import * as vscode from "vscode";
import { AgentController } from "./agent";
import { BridgeServer } from "./bridgeServer";
import { AgentViewProvider } from "./view";

let bridge: BridgeServer | undefined;
let view: AgentViewProvider | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const configuration = vscode.workspace.getConfiguration("deepseekCodeAgent");
  const port = configuration.get<number>("bridgePort", 43127);
  let autoConnect = configuration.get<boolean>("autoConnect", true);
  let storedToken = await context.secrets.get("bridgeToken");
  const pairedToken = storedToken && /^[0-9a-f]{64}$/i.test(storedToken) ? storedToken : undefined;
  let storedOrigin = context.globalState.get<string>("bridgeExtensionOrigin");
  const pairedOrigin = storedOrigin && /^chrome-extension:\/\/[a-p]{32}$/.test(storedOrigin) ? storedOrigin : undefined;
  const pairingVersion = context.globalState.get<number>("bridgePairingVersion", 0);
  const hasValidPairing = pairedToken !== undefined && pairedOrigin !== undefined && pairingVersion === 1;
  if (storedToken && !hasValidPairing) {
    await context.secrets.delete("bridgeToken");
    await context.globalState.update("bridgeExtensionOrigin", undefined);
    storedToken = undefined;
    storedOrigin = undefined;
  }
  const getChatUrl = () => vscode.workspace.getConfiguration("deepseekCodeAgent").get<string>("conversationUrl", "");
  const getAutoConnect = () => vscode.workspace.getConfiguration("deepseekCodeAgent").get<boolean>("autoConnect", true);
  bridge = new BridgeServer(
    port,
    getChatUrl,
    autoConnect && hasValidPairing ? pairedToken : undefined,
    async (url) => {
      await vscode.workspace
        .getConfiguration("deepseekCodeAgent")
        .update("conversationUrl", url, vscode.ConfigurationTarget.Global);
      view?.conversationUrlUpdated(url);
    },
    getAutoConnect,
    pairedOrigin,
  );
  try {
    await bridge.start();
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Unknown network error.";
    await vscode.window.showErrorMessage(
      `DeepSeek Code Agent could not start its loopback bridge on 127.0.0.1:${port}: ${reason}`,
    );
    throw error;
  }

  view = new AgentViewProvider(context.extensionUri, context, bridge);
  const workspace = vscode.workspace.workspaceFolders?.[0];
  if (workspace) {
    const controller = new AgentController(context, workspace, bridge, view);
    view.attach(controller);
    await controller.recoverInterruptedTask();
  }
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("deepseekCodeAgent.chat", view, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("deepseekCodeAgent.diagnoseBridge", async () => {
      if (!bridge) return;
      const state = bridge.isPaired
        ? bridge.browserActive
          ? `Bridge listening on 127.0.0.1:${port}. Browser extension is paired and polling.`
          : `Bridge listening on 127.0.0.1:${port}. Pairing is saved, but the browser extension has not polled recently. Check that it is enabled.`
        : `Bridge listening on 127.0.0.1:${port}. Pair the Chromium extension with code ${bridge.code}.`;
      await vscode.window.showInformationMessage(state);
      view?.status("completed", state);
    }),
    vscode.commands.registerCommand("deepseekCodeAgent.clearConversation", () => view?.clearConversation()),
    vscode.commands.registerCommand("deepseekCodeAgent.newSession", () => view?.newSession()),
    bridge.onDidPair((token, origin) => {
      storedToken = token;
      storedOrigin = origin;
      void Promise.all([
        context.secrets.store("bridgeToken", token),
        context.globalState.update("bridgeExtensionOrigin", origin),
        context.globalState.update("bridgePairingVersion", 1),
      ]).catch((error: unknown) => {
        console.error(
          "[DeepSeek Code Agent] Could not save browser reconnect credentials:",
          error instanceof Error ? error.name : "unknown error",
        );
      });
      view?.paired();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("deepseekCodeAgent.autoConnect")) return;
      autoConnect = vscode.workspace.getConfiguration("deepseekCodeAgent").get<boolean>("autoConnect", true);
      const reconnectToken = bridge?.reconnectToken;
      const reconnectOrigin = bridge?.reconnectOrigin;
      if (autoConnect && !bridge?.isPaired && storedToken && storedOrigin) {
        try {
          bridge?.restorePairing(storedToken, storedOrigin);
        } catch (error) {
          console.error(
            "[DeepSeek Code Agent] Could not restore browser reconnect credentials:",
            error instanceof Error ? error.message : "unknown error",
          );
        }
      }
      const update =
        reconnectToken && reconnectOrigin
          ? Promise.all([
              context.secrets.store("bridgeToken", reconnectToken),
              context.globalState.update("bridgeExtensionOrigin", reconnectOrigin),
              context.globalState.update("bridgePairingVersion", 1),
            ])
          : Promise.resolve();
      void update.catch((error: unknown) => {
        console.error(
          "[DeepSeek Code Agent] Could not update browser auto-connect preference:",
          error instanceof Error ? error.name : "unknown error",
        );
      });
    }),
    { dispose: () => view?.dispose() },
    {
      dispose: () => {
        void bridge?.stop();
      },
    },
  );
}

export async function deactivate(): Promise<void> {
  view?.dispose();
  await bridge?.stop();
  view = undefined;
  bridge = undefined;
}

import * as vscode from "vscode";
import { DEFAULT_DEEPSEEK_CHAT_URL } from "@deepseek-agent/protocol";
import { AgentController } from "./agent";
import { BridgeServer } from "./bridgeServer";
import { AgentViewProvider } from "./view";

let bridge: BridgeServer | undefined;
let view: AgentViewProvider | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const configuration = vscode.workspace.getConfiguration("deepseekCodeAgent");
  const port = configuration.get<number>("bridgePort", 43127);
  let autoConnect = configuration.get<boolean>("autoConnect", true);
  const storedToken = autoConnect ? await context.secrets.get("bridgeToken") : undefined;
  const pairedToken = storedToken && /^[0-9a-f]{64}$/i.test(storedToken) ? storedToken : undefined;
  if ((storedToken && !pairedToken) || !autoConnect) await context.secrets.delete("bridgeToken");
  const getChatUrl = () =>
    vscode.workspace.getConfiguration("deepseekCodeAgent").get<string>("conversationUrl", DEFAULT_DEEPSEEK_CHAT_URL);
  bridge = new BridgeServer(port, getChatUrl, pairedToken, async (url) => {
    await vscode.workspace
      .getConfiguration("deepseekCodeAgent")
      .update("conversationUrl", url, vscode.ConfigurationTarget.Global);
    view?.conversationUrlUpdated(url);
  });
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
    bridge.onDidPair((token) => {
      if (autoConnect)
        void Promise.resolve(context.secrets.store("bridgeToken", token)).catch((error: unknown) => {
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
      const update =
        autoConnect && reconnectToken
          ? context.secrets.store("bridgeToken", reconnectToken)
          : context.secrets.delete("bridgeToken");
      void Promise.resolve(update).catch((error: unknown) => {
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

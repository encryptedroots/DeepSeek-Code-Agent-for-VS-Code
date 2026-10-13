import * as vscode from "vscode";
import { AgentController } from "./agent";
import { BridgeServer } from "./bridgeServer";
import { AgentViewProvider } from "./view";

let bridge: BridgeServer | undefined;
let view: AgentViewProvider | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const port = vscode.workspace.getConfiguration("deepseekCodeAgent").get<number>("bridgePort", 43127);
  bridge = new BridgeServer(port);
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
    bridge.onDidPair(() => view?.paired()),
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

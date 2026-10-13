import * as vscode from "vscode";
import type { AgentController, AgentUi } from "./agent";
import type { BridgeServer } from "./bridgeServer";
import type { TaskStatus } from "./state";

export class AgentViewProvider implements vscode.WebviewViewProvider, AgentUi {
  private view: vscode.WebviewView | undefined;
  private controller: AgentController | undefined;
  private restored = false;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly context: vscode.ExtensionContext,
    private readonly bridge: BridgeServer,
  ) {}

  attach(controller: AgentController): void {
    this.controller = controller;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist", "media")],
    };
    view.webview.html = this.html(view.webview);
    this.disposables.push(
      view.webview.onDidReceiveMessage((message: { type?: string; text?: string }) => {
        if (message.type === "ready") {
          this.post({
            type: "initialize",
            workspace: vscode.workspace.workspaceFolders?.[0]?.name ?? "No workspace",
            status: this.controller?.status ?? "completed",
            pairingCode: this.bridge.isPaired ? undefined : this.bridge.code,
            bridgePaired: this.bridge.isPaired,
            browserActive: this.bridge.browserActive,
            port: vscode.workspace.getConfiguration("deepseekCodeAgent").get<number>("bridgePort", 43127),
          });
          if (!this.restored && this.controller) {
            this.restored = true;
            void this.controller.restoreHistory();
          }
        } else if (message.type === "send" && typeof message.text === "string") {
          if (!this.controller) {
            this.status("failed", "Agent is not ready.");
            return;
          }
          void this.controller.start(message.text);
        } else if (message.type === "cancel") {
          this.controller?.cancel();
        } else if (message.type === "clear") {
          void this.controller?.clearHistory();
        } else if (message.type === "new-session") {
          void this.controller?.newSession();
        } else if (message.type === "open-session" && typeof message.text === "string") {
          void this.controller?.openSession(message.text);
        }
      }),
    );
    view.onDidDispose(() => {
      this.view = undefined;
    });
  }

  status(status: TaskStatus, message: string): void {
    this.post({ type: "status", status, message });
  }

  proposal(plan: string, changes: string[], commands: string[], verification: string[]): void {
    this.post({ type: "proposal", plan, changes, commands, verification });
  }

  append(role: "user" | "assistant", text: string): void {
    this.post({ type: "message", role, text });
  }

  stream(text: string): void {
    this.post({ type: "stream", text });
  }

  activity(activity: "thinking" | "answering"): void {
    this.post({ type: "activity", activity });
  }

  clear(): void {
    this.post({ type: "clear" });
  }

  postSessions(items: Array<{ id: string; label: string }>): void {
    this.post({ type: "sessions", items });
  }

  postHistory(id: string, items: Array<{ role: "user" | "assistant"; text: string }>): void {
    this.post({ type: "show-history", sessionId: id, items });
  }

  paired(): void {
    this.post({ type: "paired", browserActive: this.bridge.browserActive });
  }

  clearConversation(): void {
    void this.controller?.clearHistory();
  }

  newSession(): void {
    void this.controller?.newSession();
  }

  dispose(): void {
    vscode.Disposable.from(...this.disposables).dispose();
  }

  private post(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }

  private html(webview: vscode.Webview): string {
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "media", "chat.js"));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "media", "chat.css"));
    const nonce = cryptoNonce();
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${style}">
  <title>DeepSeek Code Agent</title>
</head>
<body>
  <header class="toolbar">
    <div class="toolbar-heading">
      <span class="product-mark" aria-hidden="true">D</span>
      <strong class="title">DeepSeek Code Agent</strong>
      <span class="provider-label">Browser session</span>
    </div>
    <div class="toolbar-actions">
      <select id="sessions" aria-label="Choose a conversation"><option value="current">Current conversation</option></select>
      <button id="review-changes" class="icon-button" type="button" hidden aria-label="Review proposed changes" title="Review proposed changes">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5h11m-11 4h11m-11 4h7"/></svg>
      </button>
      <button id="new-session" class="icon-button" type="button" aria-label="Start a new conversation" title="New conversation">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 2.5H13v3.5M12.7 2.8 7 8.5M13 9v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h3"/></svg>
      </button>
      <button id="clear" class="icon-button" type="button" aria-label="Clear conversation" title="Clear conversation">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10m-8.5 0 .6 8h5.8l.6-8M6 4.5V3h4v1.5m-3 2v4m2-4v4"/></svg>
      </button>
    </div>
    <div class="workspace-line">
      <span class="workspace-dot" aria-hidden="true"></span>
      <span id="workspace" class="workspace">Workspace</span>
      <span class="context-label">Workspace context</span>
    </div>
  </header>
  <section id="connection" class="connection" aria-live="polite" hidden></section>
  <section id="proposal" class="proposal" aria-label="Proposed work" tabindex="-1" hidden></section>
  <div class="status-row">
    <div id="status" class="status" data-state="completed" role="status" aria-live="polite">Ready</div>
    <button id="retry" type="button" hidden title="Retry the last task">Retry</button>
  </div>
  <main id="messages" class="messages" aria-live="polite">
    <div id="empty-state" class="empty-state">
      <div class="empty-mark" aria-hidden="true">D</div>
      <strong>What can I help you build?</strong>
      <p>Ask a question or describe a change. The agent uses relevant workspace context and asks before applying edits or running commands.</p>
    </div>
  </main>
  <form id="composer">
    <div class="composer-box">
      <textarea id="prompt" rows="3" aria-label="Message DeepSeek Code Agent" placeholder="Ask a question or describe a task…" required></textarea>
      <div class="composer-actions">
        <span class="composer-hint">Enter to send · Shift+Enter for a new line</span>
        <div class="composer-buttons">
          <button id="cancel" type="button" hidden title="Stop the active task">Stop</button>
          <button id="send" class="send-button" type="submit" aria-label="Send message" title="Send message">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3m-4 4 4-4 4 4"/></svg>
          </button>
        </div>
      </div>
    </div>
  </form>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}

function cryptoNonce(): string {
  const bytes = new Uint8Array(18);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

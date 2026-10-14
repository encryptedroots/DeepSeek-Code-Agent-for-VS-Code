import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { validateDeepSeekChatUrl } from "@deepseek-agent/protocol";
import type { AgentController, AgentUi } from "./agent";
import type { BridgeServer } from "./bridgeServer";
import type { TaskStatus } from "./state";

export class AgentViewProvider implements vscode.WebviewViewProvider, AgentUi {
  private view: vscode.WebviewView | undefined;
  private controller: AgentController | undefined;
  private restored = false;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly pendingApprovals = new Map<
    string,
    { resolve: (approved: boolean) => void; signal: AbortSignal; abortHandler: () => void }
  >();

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
      view.webview.onDidReceiveMessage(
        (message: {
          type?: string;
          text?: string;
          approvalMode?: string;
          approvalId?: string;
          approved?: boolean;
          enabled?: boolean;
        }) => {
          if (message.type === "ready") {
            this.post({
              type: "initialize",
              workspace: vscode.workspace.workspaceFolders?.[0]?.name ?? "No workspace",
              status: this.controller?.status ?? "completed",
              pairingCode: this.bridge.isPaired ? undefined : this.bridge.code,
              bridgePaired: this.bridge.isPaired,
              browserActive: this.bridge.browserActive,
              autoConnect: vscode.workspace.getConfiguration("deepseekCodeAgent").get<boolean>("autoConnect", true),
              port: vscode.workspace.getConfiguration("deepseekCodeAgent").get<number>("bridgePort", 43127),
              conversationUrl: vscode.workspace
                .getConfiguration("deepseekCodeAgent")
                .get<string>("conversationUrl", ""),
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
            void this.controller.start(
              message.text,
              message.approvalMode === "safe-auto" || message.approvalMode === "auto-all"
                ? message.approvalMode
                : "review",
            );
          } else if (message.type === "cancel") {
            this.controller?.cancel();
          } else if (message.type === "clear") {
            void this.controller?.clearHistory();
          } else if (message.type === "new-session") {
            void this.startNewSession();
          } else if (message.type === "open-session" && typeof message.text === "string") {
            void this.controller?.openSession(message.text);
          } else if (message.type === "approval-response" && typeof message.approvalId === "string") {
            this.finishApproval(message.approvalId, message.approved === true);
          } else if (message.type === "save-conversation-url" && typeof message.text === "string") {
            try {
              const url = validateDeepSeekChatUrl(message.text);
              void vscode.workspace
                .getConfiguration("deepseekCodeAgent")
                .update("conversationUrl", url, vscode.ConfigurationTarget.Global)
                .then(
                  () => this.post({ type: "conversation-url-saved", url, ok: true }),
                  (error: unknown) =>
                    this.post({
                      type: "conversation-url-saved",
                      ok: false,
                      message: error instanceof Error ? error.message : "Could not save the conversation URL.",
                    }),
                );
            } catch (error) {
              this.post({
                type: "conversation-url-saved",
                ok: false,
                message: error instanceof Error ? error.message : "Use a valid DeepSeek conversation URL.",
              });
            }
          } else if (message.type === "save-auto-connect" && typeof message.enabled === "boolean") {
            void vscode.workspace
              .getConfiguration("deepseekCodeAgent")
              .update("autoConnect", message.enabled, vscode.ConfigurationTarget.Global)
              .then(
                () => this.post({ type: "auto-connect-saved", enabled: message.enabled, ok: true }),
                (error: unknown) =>
                  this.post({
                    type: "auto-connect-saved",
                    enabled: message.enabled,
                    ok: false,
                    message: error instanceof Error ? error.message : "Could not save the connection preference.",
                  }),
              );
          }
        },
      ),
    );
    view.onDidDispose(() => {
      for (const id of this.pendingApprovals.keys()) this.finishApproval(id, false);
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

  approach(summary: string): void {
    this.post({ type: "approach", summary });
  }

  requestApproval(title: string, detail: string, approveLabel: string, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted || !this.view) return Promise.resolve(false);
    const id = randomUUID();
    return new Promise((resolve) => {
      const abortHandler = () => this.finishApproval(id, false);
      this.pendingApprovals.set(id, { resolve, signal, abortHandler });
      signal.addEventListener("abort", abortHandler, { once: true });
      this.post({ type: "approval-prompt", id, title, detail, approveLabel });
    });
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
    void this.startNewSession();
  }

  conversationUrlUpdated(url: string): void {
    this.post({ type: "conversation-url-updated", url });
  }

  dispose(): void {
    vscode.Disposable.from(...this.disposables).dispose();
  }

  private post(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }

  private finishApproval(id: string, approved: boolean): void {
    const pending = this.pendingApprovals.get(id);
    if (!pending) return;
    this.pendingApprovals.delete(id);
    pending.signal.removeEventListener("abort", pending.abortHandler);
    pending.resolve(approved);
    this.post({ type: "approval-clear", id });
  }

  private async startNewSession(): Promise<void> {
    if (!this.controller || this.controller.isRunning) {
      this.status(this.controller?.status ?? "failed", "Cancel the active task before starting a new conversation.");
      return;
    }
    await this.controller.newSession();
    this.status("thinking", "Opening a new DeepSeek conversation…");
    try {
      await this.bridge.startNewConversation();
      this.status("completed", "New DeepSeek conversation is ready. Your next task will use it.");
    } catch (error) {
      this.status(
        "failed",
        `A new local conversation was started, but DeepSeek could not switch to a new chat: ${error instanceof Error ? error.message : "browser bridge error"}`,
      );
    }
  }

  private html(webview: vscode.Webview): string {
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "media", "chat.js"));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "media", "chat.css"));
    const logo = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "media", "deepseek.png"));
    const nonce = cryptoNonce();
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${style}">
  <title>DeepSeek Code Agent</title>
</head>
<body>
  <header class="toolbar">
    <div class="toolbar-heading">
      <img class="product-mark" src="${logo}" alt="" aria-hidden="true">
      <strong class="title">DeepSeek Code Agent</strong>
      <span class="provider-label">Browser session</span>
    </div>
    <div class="toolbar-actions">
      <details class="conversation-menu">
        <summary id="conversation-menu-label">DeepSeek conversation</summary>
        <div class="conversation-menu-panel">
          <form id="conversation-url-form" class="conversation-url-form">
            <label for="conversation-url">Conversation URL</label>
            <div class="conversation-url-row">
              <input id="conversation-url" type="url" autocomplete="url" spellcheck="false" required>
              <button id="save-conversation-url" type="submit">Save</button>
            </div>
            <div id="conversation-url-state" role="status" aria-live="polite"></div>
          </form>
        </div>
      </details>
      <label class="visually-hidden" for="connection-mode">Browser reconnection</label>
      <select id="connection-mode" aria-label="Browser reconnection preference">
        <option value="auto">Auto connect</option>
        <option value="manual">Manual connect</option>
      </select>
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
      <img class="empty-mark" src="${logo}" alt="" aria-hidden="true">
      <strong>What can I help you build?</strong>
      <p>Ask a question or describe a change. The agent uses relevant workspace context and asks before applying edits or running commands.</p>
    </div>
  </main>
  <form id="composer">
    <div class="composer-box">
      <section id="approval-request" class="approval-request" aria-live="assertive" hidden>
        <strong id="approval-title"></strong>
        <p id="approval-detail"></p>
        <div class="approval-buttons">
          <button id="approval-reject" type="button">Don't allow</button>
          <button id="approval-approve" class="approval-confirm" type="button">Approve</button>
        </div>
      </section>
      <textarea id="prompt" rows="3" aria-label="Message DeepSeek Code Agent" placeholder="Ask a question or describe a task…" required></textarea>
      <div class="composer-actions">
        <div class="composer-options">
          <label class="approval-label" for="approval-mode">Approval</label>
          <select id="approval-mode" aria-label="Change and command approval mode" title="Auto-apply everything skips prompts for file changes, deletions, and commands accepted by safety checks. npm scripts may perform project-defined actions; blocked commands remain blocked.">
            <option value="review">Ask before edits / commands</option>
            <option value="safe-auto">Auto-apply safe changes</option>
            <option value="auto-all">Auto-apply everything</option>
          </select>
        </div>
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

export {};

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const vscode = acquireVsCodeApi();
const messages = document.querySelector<HTMLElement>("#messages")!;
const emptyState = document.querySelector<HTMLElement>("#empty-state")!;
const status = document.querySelector<HTMLElement>("#status")!;
const connection = document.querySelector<HTMLElement>("#connection")!;
const proposal = document.querySelector<HTMLElement>("#proposal")!;
const prompt = document.querySelector<HTMLTextAreaElement>("#prompt")!;
const send = document.querySelector<HTMLButtonElement>("#send")!;
const cancel = document.querySelector<HTMLButtonElement>("#cancel")!;
const retry = document.querySelector<HTMLButtonElement>("#retry")!;
const reviewChanges = document.querySelector<HTMLButtonElement>("#review-changes")!;
const composer = document.querySelector<HTMLFormElement>("#composer")!;
const approvalMode = document.querySelector<HTMLSelectElement>("#approval-mode")!;
const approvalRequest = document.querySelector<HTMLElement>("#approval-request")!;
const approvalTitle = document.querySelector<HTMLElement>("#approval-title")!;
const approvalDetail = document.querySelector<HTMLElement>("#approval-detail")!;
const approvalApprove = document.querySelector<HTMLButtonElement>("#approval-approve")!;
const approvalReject = document.querySelector<HTMLButtonElement>("#approval-reject")!;
const conversationUrlForm = document.querySelector<HTMLFormElement>("#conversation-url-form")!;
const conversationUrlInput = document.querySelector<HTMLInputElement>("#conversation-url")!;
const conversationUrlState = document.querySelector<HTMLElement>("#conversation-url-state")!;
const saveConversationUrl = document.querySelector<HTMLButtonElement>("#save-conversation-url")!;
const connectionMode = document.querySelector<HTMLSelectElement>("#connection-mode")!;
let thinkingPanel: HTMLDetailsElement | undefined;
let lastPrompt = "";
let pendingApprovalId: string | undefined;

function inlineText(parent: HTMLElement, text: string): void {
  const inlineCode = /`([^`]+)`/g;
  let start = 0;
  for (const match of text.matchAll(inlineCode)) {
    const index = match.index ?? 0;
    parent.append(document.createTextNode(text.slice(start, index)));
    const code = document.createElement("code");
    code.textContent = match[1];
    parent.append(code);
    start = index + match[0].length;
  }
  parent.append(document.createTextNode(text.slice(start)));
}

function renderBody(body: HTMLElement, text: string): void {
  const segments = text.split(/```([^\n`]*)\n([\s\S]*?)```/g);
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (index % 3 === 1) {
      const language = segment.trim();
      const codeBlock = document.createElement("div");
      codeBlock.className = "code-block";
      if (language) {
        const languageLabel = document.createElement("div");
        languageLabel.className = "code-language";
        languageLabel.textContent = language;
        codeBlock.append(languageLabel);
      }
      const pre = document.createElement("pre");
      pre.textContent = segments[index + 1] ?? "";
      codeBlock.append(pre);
      body.append(codeBlock);
      index += 1;
      continue;
    }
    if (!segment) continue;
    for (const line of segment.split("\n")) {
      const paragraph = document.createElement("div");
      paragraph.className = /^\s*\+(?!\+\+)/.test(line)
        ? "diff-line added"
        : /^\s*-(?!--)/.test(line)
          ? "diff-line removed"
          : /^\s*(?:@@|diff --git|[+-]{3} )/.test(line)
            ? "diff-meta"
            : "message-line";
      inlineText(paragraph, line || " ");
      body.append(paragraph);
    }
  }
}

function addMessage(role: string, text: string): void {
  const article = document.createElement("article");
  const isError = role === "assistant" && text.startsWith("Task failed:");
  const displayText = text.replace(/^DeepSeek needs clarification:\s*/i, "");
  const isQuestion = role === "assistant" && displayText !== text;
  article.className = `message ${role}${isError ? " error-message" : ""}${isQuestion ? " question-message" : ""}`;
  const label = document.createElement("div");
  label.className = "message-label";
  label.textContent = role === "user" ? "You" : isError ? "Task error" : isQuestion ? "Clarification" : "Agent";
  const body = document.createElement("div");
  body.className = "message-body";
  renderBody(body, displayText);
  article.append(label, body);
  messages.append(article);
  emptyState.hidden = true;
  messages.scrollTop = messages.scrollHeight;
}

function appendThinkingStep(text: string): void {
  if (!thinkingPanel) return;
  const steps = thinkingPanel.querySelector<HTMLElement>(".thinking-steps")!;
  if (steps.lastElementChild?.textContent === text) return;
  const step = document.createElement("div");
  step.className = "thinking-step";
  step.textContent = text;
  steps.append(step);
}

function setDeepSeekActivity(activity: "thinking" | "answering"): void {
  if (!thinkingPanel) return;
  const title = thinkingPanel.querySelector<HTMLElement>(".thinking-title")!;
  title.dataset.activity = activity;
  title.replaceChildren(document.createTextNode(activity === "thinking" ? "Thinking" : "Responding"));
  if (activity === "thinking") {
    const dots = document.createElement("span");
    dots.className = "thinking-dots";
    dots.setAttribute("aria-hidden", "true");
    for (let index = 0; index < 3; index += 1) {
      const dot = document.createElement("span");
      dot.textContent = ".";
      dots.append(dot);
    }
    title.append(dots);
  }
  appendThinkingStep(activity === "thinking" ? "DeepSeek is thinking…" : "DeepSeek is writing its answer…");
}

function setThinkingLabel(label: HTMLElement, text: string, animate: boolean): void {
  label.replaceChildren(document.createTextNode(text));
  label.dataset.activity = animate ? "thinking" : "";
  if (!animate) return;
  const dots = document.createElement("span");
  dots.className = "thinking-dots";
  dots.setAttribute("aria-hidden", "true");
  for (let index = 0; index < 3; index += 1) {
    const dot = document.createElement("span");
    dot.textContent = ".";
    dots.append(dot);
  }
  label.append(dots);
}

function statusText(value: string, message: string): string {
  if (value === "waiting") return `Awaiting approval · ${message.replace(/^Waiting for approval\s*[·:]?\s*/i, "")}`;
  if (value === "testing") return `Verifying · ${message.replace(/^Running approved command:\s*/i, "")}`;
  if (value === "editing") return `Preparing changes · ${message.replace(/^Applying\s*/i, "")}`;
  if (value === "clarification") return "Waiting for your clarification";
  if (/^Connecting to DeepSeek/i.test(message)) return "Connecting to DeepSeek…";
  if (/^Preparing changes/i.test(message)) return "Preparing changes…";
  if (/^Thinking/i.test(message)) return message;
  return message;
}

function submitPrompt(): void {
  const text = prompt.value.trim();
  const active = !["completed", "failed", "cancelled", "clarification"].includes(status.dataset.state ?? "completed");
  if (!text || active) return;
  lastPrompt = text;
  vscode.postMessage({ type: "send", text, approvalMode: approvalMode.value });
  prompt.value = "";
  prompt.style.height = "";
  send.disabled = true;
}

composer.addEventListener("submit", (event) => {
  event.preventDefault();
  submitPrompt();
});

prompt.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    composer.requestSubmit();
  }
});

prompt.addEventListener("input", () => {
  prompt.style.height = "auto";
  prompt.style.height = `${Math.min(prompt.scrollHeight, 180)}px`;
  send.disabled =
    !prompt.value.trim() ||
    !["completed", "failed", "cancelled", "clarification"].includes(status.dataset.state ?? "completed");
});

cancel.addEventListener("click", () => vscode.postMessage({ type: "cancel" }));
reviewChanges.addEventListener("click", () => {
  if (proposal.hidden) return;
  const expanded = proposal.classList.toggle("expanded");
  reviewChanges.setAttribute("aria-expanded", String(expanded));
  reviewChanges.title = expanded ? "Collapse proposed changes" : "Review proposed changes";
  proposal.scrollIntoView({ behavior: "auto", block: "nearest" });
  proposal.focus();
});
retry.addEventListener("click", () => {
  prompt.value = lastPrompt;
  submitPrompt();
});
document.querySelector("#clear")!.addEventListener("click", () => vscode.postMessage({ type: "clear" }));
document.querySelector("#new-session")!.addEventListener("click", () => vscode.postMessage({ type: "new-session" }));
conversationUrlForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!conversationUrlForm.reportValidity()) return;
  saveConversationUrl.disabled = true;
  conversationUrlState.textContent = "Validating and saving…";
  conversationUrlState.dataset.state = "pending";
  vscode.postMessage({ type: "save-conversation-url", text: conversationUrlInput.value.trim() });
});

conversationUrlInput.addEventListener("input", () => {
  conversationUrlState.textContent = "Unsaved changes";
  conversationUrlState.dataset.state = "unsaved";
});

connectionMode.addEventListener("change", () => {
  connectionMode.disabled = true;
  connectionMode.title = "Saving browser reconnection preference…";
  vscode.postMessage({ type: "save-auto-connect", enabled: connectionMode.value === "auto" });
});

function answerApproval(approved: boolean): void {
  if (!pendingApprovalId) return;
  vscode.postMessage({ type: "approval-response", approvalId: pendingApprovalId, approved });
  pendingApprovalId = undefined;
  approvalRequest.hidden = true;
  approvalApprove.disabled = false;
  approvalReject.disabled = false;
}

approvalApprove.addEventListener("click", () => answerApproval(true));
approvalReject.addEventListener("click", () => answerApproval(false));

window.addEventListener("message", (event: MessageEvent) => {
  const message = event.data as Record<string, unknown>;
  if (message.type === "initialize") {
    document.querySelector("#workspace")!.textContent = String(message.workspace);
    if (typeof message.conversationUrl === "string") {
      conversationUrlInput.value = message.conversationUrl;
      conversationUrlState.textContent = "Using this conversation for new tasks.";
      conversationUrlState.dataset.state = "saved";
    }
    connectionMode.value = message.autoConnect === false ? "manual" : "auto";
    connectionMode.title =
      connectionMode.value === "auto"
        ? "Reconnect automatically after the first pairing."
        : "Pair with the browser extension again after VS Code restarts.";
    connection.hidden = false;
    if (typeof message.pairingCode === "string") {
      connection.textContent =
        message.autoConnect === true
          ? "Auto connect is enabled. Waiting for the browser extension to pair automatically."
          : `Pair the browser extension at http://127.0.0.1:${String(message.port)} using code ${message.pairingCode}. Chat readiness is checked separately.`;
      connection.dataset.state = message.autoConnect === true ? "connecting" : "disconnected";
    } else if (message.bridgePaired === true) {
      connection.textContent =
        message.browserActive === true
          ? "Browser paired and polling."
          : "Browser paired · waiting for the browser extension to reconnect.";
      connection.dataset.state = "paired";
    } else {
      connection.textContent = "Browser extension is not paired.";
      connection.dataset.state = "disconnected";
    }
    return;
  }
  if (message.type === "conversation-url-saved") {
    saveConversationUrl.disabled = false;
    if (message.ok === true && typeof message.url === "string") {
      conversationUrlInput.value = message.url;
      conversationUrlState.textContent = "Saved. New tasks will use this conversation.";
      conversationUrlState.dataset.state = "saved";
    } else {
      conversationUrlState.textContent = String(message.message ?? "Could not save the conversation URL.");
      conversationUrlState.dataset.state = "error";
    }
    return;
  }
  if (message.type === "conversation-url-updated" && typeof message.url === "string") {
    conversationUrlInput.value = message.url;
    conversationUrlState.textContent = "New DeepSeek conversation selected.";
    conversationUrlState.dataset.state = "saved";
    return;
  }
  if (message.type === "auto-connect-saved") {
    connectionMode.disabled = false;
    if (message.ok === true) {
      connectionMode.value = message.enabled === true ? "auto" : "manual";
      connectionMode.title =
        message.enabled === true
          ? "Reconnect automatically after the first pairing."
          : "Pair with the browser extension again after VS Code restarts.";
    } else {
      connectionMode.value = message.enabled === true ? "manual" : "auto";
      connectionMode.title = String(message.message ?? "Could not save the connection preference.");
      status.textContent = connectionMode.title;
      status.dataset.state = "failed";
    }
    return;
  }
  if (message.type === "paired") {
    connection.hidden = false;
    connection.dataset.state = "paired";
    connection.textContent = "Browser extension paired. DeepSeek chat readiness is checked when you send a task.";
    return;
  }
  if (message.type === "status") {
    const value = String(message.status);
    const currentMessage = String(message.message);
    status.dataset.state = value;
    if (thinkingPanel) thinkingPanel.dataset.state = value;
    status.textContent = statusText(value, currentMessage);
    const active = !["completed", "failed", "cancelled", "clarification"].includes(value);
    if (active) {
      if (!thinkingPanel) {
        thinkingPanel = document.createElement("details");
        thinkingPanel.className = "thinking-panel";
        thinkingPanel.open = false;
        const summary = document.createElement("summary");
        const dot = document.createElement("span");
        dot.className = "thinking-dot";
        dot.setAttribute("aria-hidden", "true");
        const title = document.createElement("span");
        title.className = "thinking-title";
        summary.append(dot, title);
        const steps = document.createElement("div");
        steps.className = "thinking-steps";
        thinkingPanel.append(summary, steps);
        messages.append(thinkingPanel);
        emptyState.hidden = true;
      }
      thinkingPanel.dataset.state = value;
      const title = thinkingPanel.querySelector<HTMLElement>(".thinking-title")!;
      title.textContent =
        value === "thinking"
          ? "Thinking"
          : value === "waiting"
            ? "Awaiting approval"
            : value === "editing"
              ? "Preparing changes"
              : value === "testing"
                ? "Verifying"
                : "Working";
      thinkingPanel.dataset.active = "true";
      setThinkingLabel(title, value === "thinking" ? "Thinking" : (title.textContent ?? ""), value === "thinking");
      appendThinkingStep(currentMessage);
      messages.scrollTop = messages.scrollHeight;
    } else if (thinkingPanel) {
      const terminalStep =
        value === "completed"
          ? "Task completed"
          : value === "failed"
            ? "Task failed"
            : value === "cancelled"
              ? "Task cancelled"
              : "Waiting for your clarification";
      appendThinkingStep(terminalStep);
      thinkingPanel.dataset.active = "false";
      thinkingPanel.dataset.state = value;
      thinkingPanel.querySelector<HTMLElement>(".thinking-title")!.textContent = "Task progress";
      thinkingPanel.open = false;
      thinkingPanel = undefined;
    }
    cancel.hidden = !active;
    retry.hidden = value !== "failed" || !lastPrompt;
    reviewChanges.hidden = proposal.hidden;
    send.disabled = active || !prompt.value.trim();
    return;
  }
  if (message.type === "message") {
    if (message.role === "user") lastPrompt = String(message.text);
    addMessage(String(message.role), String(message.text));
    return;
  }
  if (message.type === "stream") {
    return;
  }
  if (message.type === "activity" && (message.activity === "thinking" || message.activity === "answering")) {
    setDeepSeekActivity(message.activity);
    return;
  }
  if (message.type === "approval-prompt") {
    pendingApprovalId = String(message.id);
    approvalTitle.textContent = String(message.title);
    approvalDetail.textContent = String(message.detail);
    approvalApprove.textContent = String(message.approveLabel);
    approvalApprove.disabled = false;
    approvalReject.disabled = false;
    approvalRequest.hidden = false;
    approvalRequest.scrollIntoView({ behavior: "auto", block: "nearest" });
    approvalApprove.focus();
    return;
  }
  if (message.type === "approval-clear" && message.id === pendingApprovalId) {
    pendingApprovalId = undefined;
    approvalRequest.hidden = true;
    approvalApprove.disabled = false;
    approvalReject.disabled = false;
    return;
  }
  if (message.type === "approach" && typeof message.summary === "string" && thinkingPanel) {
    appendThinkingStep(`Approach: ${message.summary}`);
    return;
  }
  if (message.type === "clear") {
    messages.querySelectorAll(".message, .streaming, .thinking-panel").forEach((item) => item.remove());
    thinkingPanel = undefined;
    emptyState.hidden = false;
    proposal.hidden = true;
    return;
  }
  if (message.type === "show-history") {
    messages.querySelectorAll(".message, .streaming, .thinking-panel").forEach((item) => item.remove());
    thinkingPanel = undefined;
    if (Array.isArray(message.items)) {
      for (const item of message.items as Array<{ role: string; text: string }>) addMessage(item.role, item.text);
    }
    emptyState.hidden = messages.querySelector(".message") !== null;
    return;
  }
  if (message.type === "proposal") {
    const plan = String(message.plan ?? "");
    const changes = Array.isArray(message.changes) ? message.changes.map(String) : [];
    const commands = Array.isArray(message.commands) ? message.commands.map(String) : [];
    proposal.replaceChildren();
    if (!plan && !changes.length && !commands.length) {
      proposal.hidden = true;
      reviewChanges.hidden = true;
      proposal.classList.remove("expanded");
      reviewChanges.setAttribute("aria-expanded", "false");
      reviewChanges.title = "Review proposed changes";
      return;
    }
    proposal.hidden = false;
    proposal.classList.remove("expanded");
    reviewChanges.setAttribute("aria-expanded", "false");
    reviewChanges.title = "Review proposed changes";
    reviewChanges.hidden = false;
    const heading = document.createElement("h2");
    heading.textContent = "Proposed work";
    proposal.append(heading);
    if (plan) {
      const explanation = document.createElement("p");
      explanation.textContent = plan;
      proposal.append(explanation);
    }
    for (const [label, items] of [
      ["Files · review diffs before applying", changes],
      ["Commands · approval required", commands],
    ] as const) {
      if (!items.length) continue;
      const subheading = document.createElement("div");
      subheading.className = "proposal-label";
      subheading.textContent = label;
      const list = document.createElement("ul");
      for (const item of items) {
        const entry = document.createElement("li");
        const code = document.createElement("code");
        code.textContent = item;
        entry.append(code);
        list.append(entry);
      }
      proposal.append(subheading, list);
    }
    const checks = Array.isArray(message.verification) ? message.verification.map(String) : [];
    if (checks.length) {
      const subheading = document.createElement("div");
      subheading.className = "proposal-label";
      subheading.textContent = "Verification steps";
      const list = document.createElement("ul");
      for (const item of checks) {
        const entry = document.createElement("li");
        entry.textContent = item;
        list.append(entry);
      }
      proposal.append(subheading, list);
    }
  }
});

vscode.postMessage({ type: "ready" });

"use strict";
(() => {
  // media/chat.ts
  var vscode = acquireVsCodeApi();
  var messages = document.querySelector("#messages");
  var emptyState = document.querySelector("#empty-state");
  var status = document.querySelector("#status");
  var connection = document.querySelector("#connection");
  var proposal = document.querySelector("#proposal");
  var prompt = document.querySelector("#prompt");
  var send = document.querySelector("#send");
  var cancel = document.querySelector("#cancel");
  var retry = document.querySelector("#retry");
  var reviewChanges = document.querySelector("#review-changes");
  var composer = document.querySelector("#composer");
  var thinkingPanel;
  var lastPrompt = "";
  function inlineText(parent, text) {
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
  function renderBody(body, text) {
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
        paragraph.className = /^\s*\+(?!\+\+)/.test(line) ? "diff-line added" : /^\s*-(?!--)/.test(line) ? "diff-line removed" : /^\s*(?:@@|diff --git|[+-]{3} )/.test(line) ? "diff-meta" : "message-line";
        inlineText(paragraph, line || " ");
        body.append(paragraph);
      }
    }
  }
  function addMessage(role, text) {
    const article = document.createElement("article");
    const isError = role === "assistant" && text.startsWith("Task failed:");
    const isQuestion = role === "assistant" && text.startsWith("DeepSeek needs clarification:");
    article.className = `message ${role}${isError ? " error-message" : ""}${isQuestion ? " question-message" : ""}`;
    const label = document.createElement("div");
    label.className = "message-label";
    label.textContent = role === "user" ? "You" : isError ? "Task error" : isQuestion ? "Clarification" : "Agent";
    const body = document.createElement("div");
    body.className = "message-body";
    renderBody(body, text);
    article.append(label, body);
    messages.append(article);
    emptyState.hidden = true;
    messages.scrollTop = messages.scrollHeight;
  }
  function appendThinkingStep(text) {
    if (!thinkingPanel) return;
    const steps = thinkingPanel.querySelector(".thinking-steps");
    if (steps.lastElementChild?.textContent === text) return;
    const step = document.createElement("div");
    step.className = "thinking-step";
    step.textContent = text;
    steps.append(step);
  }
  function statusText(value, message) {
    if (value === "waiting") return `Awaiting approval \xB7 ${message.replace(/^Waiting for approval\s*[·:]?\s*/i, "")}`;
    if (value === "testing") return `Verifying \xB7 ${message.replace(/^Running approved command:\s*/i, "")}`;
    if (value === "editing") return `Preparing changes \xB7 ${message.replace(/^Applying\s*/i, "")}`;
    if (value === "clarification") return "Waiting for your clarification";
    if (/^Connecting to DeepSeek/i.test(message)) return "Connecting to DeepSeek\u2026";
    if (/^Preparing changes/i.test(message)) return "Preparing changes\u2026";
    if (/^Thinking/i.test(message)) return message;
    return message;
  }
  function submitPrompt() {
    const text = prompt.value.trim();
    const active = !["completed", "failed", "cancelled", "clarification"].includes(status.dataset.state ?? "completed");
    if (!text || active) return;
    lastPrompt = text;
    vscode.postMessage({ type: "send", text });
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
    send.disabled = !prompt.value.trim() || !["completed", "failed", "cancelled", "clarification"].includes(status.dataset.state ?? "completed");
  });
  cancel.addEventListener("click", () => vscode.postMessage({ type: "cancel" }));
  reviewChanges.addEventListener("click", () => {
    if (proposal.hidden) return;
    proposal.scrollIntoView({ behavior: "auto", block: "nearest" });
    proposal.focus();
  });
  retry.addEventListener("click", () => {
    prompt.value = lastPrompt;
    submitPrompt();
  });
  document.querySelector("#clear").addEventListener("click", () => vscode.postMessage({ type: "clear" }));
  document.querySelector("#new-session").addEventListener("click", () => vscode.postMessage({ type: "new-session" }));
  document.querySelector("#sessions").addEventListener("change", (event) => {
    vscode.postMessage({ type: "open-session", text: event.target.value });
  });
  window.addEventListener("message", (event) => {
    const message = event.data;
    if (message.type === "initialize") {
      document.querySelector("#workspace").textContent = String(message.workspace);
      connection.hidden = false;
      if (typeof message.pairingCode === "string") {
        connection.textContent = `Pair the browser extension at http://127.0.0.1:${String(message.port)} using code ${message.pairingCode}. Chat readiness is checked separately.`;
        connection.dataset.state = "disconnected";
      } else if (message.bridgePaired === true) {
        connection.textContent = message.browserActive === true ? "Browser paired and polling \xB7 open its popup to inspect and confirm the intended conversation." : "Browser paired \xB7 open its popup to inspect and confirm the intended conversation.";
        connection.dataset.state = "paired";
      } else {
        connection.textContent = "Browser extension is not paired.";
        connection.dataset.state = "disconnected";
      }
      return;
    }
    if (message.type === "paired") {
      connection.hidden = false;
      connection.dataset.state = "paired";
      connection.textContent = "Browser extension paired \xB7 inspect and confirm the intended conversation in its popup.";
      return;
    }
    if (message.type === "status") {
      const value = String(message.status);
      const currentMessage = String(message.message);
      status.dataset.state = value;
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
          const title2 = document.createElement("span");
          title2.className = "thinking-title";
          summary.append(dot, title2);
          const steps = document.createElement("div");
          steps.className = "thinking-steps";
          thinkingPanel.append(summary, steps);
          messages.append(thinkingPanel);
          emptyState.hidden = true;
        }
        const title = thinkingPanel.querySelector(".thinking-title");
        title.textContent = value === "thinking" ? "Thinking" : value === "waiting" ? "Awaiting approval" : value === "editing" ? "Preparing changes" : value === "testing" ? "Verifying" : "Working";
        thinkingPanel.dataset.active = "true";
        appendThinkingStep(currentMessage);
        messages.scrollTop = messages.scrollHeight;
      } else if (thinkingPanel) {
        const terminalStep = value === "completed" ? "Task completed" : value === "failed" ? "Task failed" : value === "cancelled" ? "Task cancelled" : "Waiting for your clarification";
        appendThinkingStep(terminalStep);
        thinkingPanel.dataset.active = "false";
        thinkingPanel.querySelector(".thinking-title").textContent = "Task progress";
        thinkingPanel.open = false;
        thinkingPanel = void 0;
      }
      cancel.hidden = !active;
      retry.hidden = value !== "failed" || !lastPrompt;
      reviewChanges.hidden = proposal.hidden || !["waiting", "editing", "testing"].includes(value);
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
    if (message.type === "clear") {
      messages.querySelectorAll(".message, .streaming, .thinking-panel").forEach((item) => item.remove());
      thinkingPanel = void 0;
      emptyState.hidden = false;
      proposal.hidden = true;
      document.querySelector("#sessions").value = "current";
      return;
    }
    if (message.type === "sessions") {
      const select = document.querySelector("#sessions");
      const active = select.value;
      select.replaceChildren(new Option("Current conversation", "current"));
      if (Array.isArray(message.items)) {
        for (const item of message.items) {
          select.add(new Option(item.label, item.id));
        }
      }
      select.value = [...select.options].some((option) => option.value === active) ? active : "current";
      return;
    }
    if (message.type === "show-history") {
      document.querySelector("#sessions").value = String(message.sessionId);
      messages.querySelectorAll(".message, .streaming, .thinking-panel").forEach((item) => item.remove());
      thinkingPanel = void 0;
      if (Array.isArray(message.items)) {
        for (const item of message.items) addMessage(item.role, item.text);
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
        return;
      }
      proposal.hidden = false;
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
        ["Files \xB7 review diffs before applying", changes],
        ["Commands \xB7 approval required", commands]
      ]) {
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
})();
//# sourceMappingURL=chat.js.map

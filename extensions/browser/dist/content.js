"use strict";
(() => {
  // src/chatUrl.ts
  var CHAT_PATH = /^\/a\/chat\/s\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/?$/i;
  function validateDeepSeekChatUrl(input) {
    let url;
    try {
      url = new URL(input.trim());
    } catch {
      throw new Error("Enter a valid DeepSeek conversation URL.");
    }
    if (url.protocol !== "https:" || url.hostname !== "chat.deepseek.com" || url.origin !== "https://chat.deepseek.com" || url.username || url.password || url.search || url.hash || !CHAT_PATH.test(url.pathname)) {
      throw new Error(
        "Use an HTTPS conversation URL from chat.deepseek.com with a valid chat ID, such as https://chat.deepseek.com/a/chat/s/<chat-id>."
      );
    }
    return `https://chat.deepseek.com${url.pathname.replace(/\/$/, "")}`;
  }
  function isDeepSeekConversationUrl(currentUrl, configuredUrl) {
    let expected;
    let current;
    try {
      expected = validateDeepSeekChatUrl(configuredUrl);
      current = new URL(currentUrl);
    } catch {
      return false;
    }
    return current.protocol === "https:" && current.hostname === "chat.deepseek.com" && current.origin === "https://chat.deepseek.com" && current.pathname.replace(/\/$/, "") === new URL(expected).pathname;
  }

  // src/adapter.ts
  var INPUT_SELECTORS = ["textarea", '[contenteditable="true"]', '[role="textbox"]'];
  var RESPONSE_SELECTORS = [".ds-markdown", ".markdown", '[class*="markdown"]'];
  var THINKING_SELECTOR = ".ds-think-content";
  var activeRequest;
  function visible(element) {
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && element.getBoundingClientRect().height > 0;
  }
  function findInput() {
    for (const selector of INPUT_SELECTORS) {
      const input = [...document.querySelectorAll(selector)].find(visible);
      if (input) return input;
    }
    return null;
  }
  function responseNodes() {
    for (const selector of RESPONSE_SELECTORS) {
      const nodes = [...document.querySelectorAll(selector)].filter(
        (node) => visible(node) && !node.closest(THINKING_SELECTOR)
      );
      if (nodes.length) return nodes;
    }
    return [];
  }
  function selectLatestFinalAnswer(candidates) {
    return [...candidates].reverse().find((candidate) => !candidate.isThinking && candidate.text.trim())?.text.trim() ?? "";
  }
  function shouldCommitFinalAnswer(text, started, streaming, stableForMs) {
    return started && Boolean(text.trim()) && !streaming && stableForMs >= 3500;
  }
  function setInput(input, text) {
    input.focus();
    if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
      if (!setter) throw new Error("DeepSeek input control is unsupported.");
      setter.call(input, text);
      input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    } else {
      input.textContent = text;
      input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    }
  }
  function submit(input) {
    const buttons = [...document.querySelectorAll("button")].filter(visible);
    const send = buttons.find((button) => {
      const label = `${button.getAttribute("aria-label") ?? ""} ${button.getAttribute("title") ?? ""} ${button.textContent ?? ""}`.toLowerCase();
      return /send|submit|发送/.test(label) && !button.disabled;
    });
    if (send) {
      send.click();
      return;
    }
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true }));
  }
  async function runDeepSeekPrompt(prompt, chatUrl, timeoutMs = 18e4) {
    if (!isDeepSeekHost(location.hostname))
      return { ok: false, error: "Open the official DeepSeek chat website and sign in first." };
    try {
      if (!isDeepSeekConversationUrl(location.href, chatUrl))
        return {
          ok: false,
          error: "The active DeepSeek tab is not the configured conversation. Check the saved chat URL and retry."
        };
    } catch {
      return {
        ok: false,
        error: "The configured DeepSeek conversation URL is invalid. Save a valid chat.deepseek.com conversation URL in the extension popup."
      };
    }
    const input = findInput();
    if (!input)
      return {
        ok: false,
        error: "DeepSeek chat input was not found. Sign in or check whether the website layout changed."
      };
    const before = responseNodes();
    const previousLast = selectLatestFinalAnswer(before.map((node) => ({ text: node.innerText, isThinking: false })));
    try {
      setInput(input, prompt);
      submit(input);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "Could not submit the prompt." };
    }
    return new Promise((resolve) => {
      let lastText = "";
      let stableSince = Date.now();
      let responseStarted = false;
      let finished = false;
      const finish = (result) => {
        if (finished) return;
        finished = true;
        clearInterval(timer);
        observer.disconnect();
        if (activeRequest === cancel) activeRequest = void 0;
        resolve(result);
      };
      const cancel = () => finish({ ok: false, error: "Request cancelled by VS Code." });
      activeRequest = cancel;
      const inspect = () => {
        if (!isDeepSeekConversationUrl(location.href, chatUrl)) {
          finish({
            ok: false,
            error: "The DeepSeek page navigated away from the configured conversation before its response completed."
          });
          return;
        }
        const nodes = responseNodes();
        const response = selectLatestFinalAnswer(nodes.map((node) => ({ text: node.innerText, isThinking: false })));
        if (response && (nodes.length > before.length || response !== previousLast)) {
          responseStarted = true;
        }
        if (response !== lastText) {
          lastText = response;
          stableSince = Date.now();
        }
        const streaming = [...document.querySelectorAll("button")].some((button) => {
          if (!visible(button)) return false;
          const label = `${button.getAttribute("aria-label") ?? ""} ${button.title} ${button.textContent ?? ""}`.toLowerCase();
          return /stop|interrupt|停止/.test(label);
        });
        if (shouldCommitFinalAnswer(lastText, responseStarted, streaming, Date.now() - stableSince))
          finish({ ok: true, response: lastText });
        if (Date.now() - started > timeoutMs) {
          finish({
            ok: false,
            error: responseStarted ? "DeepSeek response timed out before completion." : "DeepSeek did not start responding. The request may have been interrupted."
          });
        }
      };
      const started = Date.now();
      const observer = new MutationObserver(inspect);
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      const timer = setInterval(inspect, 400);
    });
  }
  function deepSeekPageStatus(chatUrl) {
    let intendedChat = false;
    try {
      intendedChat = isDeepSeekConversationUrl(location.href, validateDeepSeekChatUrl(chatUrl));
    } catch {
      return { available: false, intendedChat: false };
    }
    return { available: isDeepSeekHost(location.hostname) && intendedChat && findInput() !== null, intendedChat };
  }
  function cancelDeepSeekPrompt() {
    activeRequest?.();
  }
  function isDeepSeekHost(hostname) {
    return hostname === "chat.deepseek.com";
  }

  // src/content.ts
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "check-page") {
      const chatUrl = message.chatUrl;
      sendResponse(typeof chatUrl === "string" ? deepSeekPageStatus(chatUrl) : { available: false, intendedChat: false });
      return false;
    }
    if (message?.type === "cancel-prompt") {
      cancelDeepSeekPrompt();
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type !== "run-prompt" || typeof message.prompt !== "string" || typeof message.chatUrl !== "string")
      return;
    void runDeepSeekPrompt(message.prompt, message.chatUrl, message.timeoutMs).then(sendResponse);
    return true;
  });
  void chrome.storage.local.get("chatUrl").then(({ chatUrl }) => {
    const status = typeof chatUrl === "string" ? deepSeekPageStatus(chatUrl) : { available: false, intendedChat: false };
    return chrome.runtime.sendMessage({ type: "page-health", ...status, url: location.href }).catch(() => void 0);
  });
})();
//# sourceMappingURL=content.js.map

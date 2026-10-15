"use strict";
(() => {
  // src/chatUrl.ts
  var CHAT_PATH = /^\/a\/chat\/s\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/?$/i;
  var NEW_CHAT_PATH = /^\/$|^\/a\/chat\/s\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/?$/i;
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
  function isDeepSeekNewConversationPage(currentUrl) {
    try {
      const url = new URL(currentUrl);
      return url.protocol === "https:" && url.hostname === "chat.deepseek.com" && url.origin === "https://chat.deepseek.com" && NEW_CHAT_PATH.test(url.pathname);
    } catch {
      return false;
    }
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
  function restoreMarkdownCodeBlocks(text, codeBlocks) {
    return codeBlocks.reduce(
      (result, block) => result.replace(block.marker, `\`\`\`${block.language}
${block.content}
\`\`\``),
      text
    );
  }
  function codeBlockLanguage(pre) {
    const code = pre.querySelector("code");
    for (const node of [code, pre]) {
      if (!node) continue;
      const attribute = node.getAttribute("data-language") ?? node.getAttribute("lang");
      if (attribute) return attribute.trim();
      const match = node.className.match(/(?:^|\s)language-([\w.+-]+)/);
      if (match) return match[1];
    }
    let current = pre;
    for (let depth = 0; current && depth < 3; depth += 1, current = current.parentElement) {
      for (const sibling of current.parentElement?.children ?? []) {
        if (sibling === current || !sibling.querySelector("button, [role='button']")) continue;
        const label = sibling.cloneNode(true);
        label.querySelectorAll("button, [role='button']").forEach((button) => button.remove());
        const value = label.textContent?.trim() ?? "";
        if (/^[\w.+-]+$/.test(value)) return value;
      }
    }
    return "";
  }
  function extractResponseText(node) {
    const clone = node.cloneNode(true);
    const codeBlocks = [];
    const originalPreBlocks = [...node.querySelectorAll("pre")];
    const clonedPreBlocks = [...clone.querySelectorAll("pre")];
    originalPreBlocks.forEach((pre, index) => {
      const clonedPre = clonedPreBlocks[index];
      if (!clonedPre) return;
      const marker = `__DEEPSEEK_CODE_BLOCK_${index}__`;
      const language = codeBlockLanguage(pre);
      const content = pre.querySelector("code")?.textContent ?? pre.textContent ?? "";
      codeBlocks.push({
        marker,
        language,
        content: content.replace(/^\r?\n+|\r?\n+$/g, "")
      });
      const parent = clonedPre.parentElement;
      if (parent) {
        for (const sibling of [...parent.children]) {
          if (sibling !== clonedPre && (sibling.querySelector("button, [role='button']") || /copy|download/i.test(sibling.textContent ?? "")))
            sibling.remove();
        }
      }
      clonedPre.replaceWith(document.createTextNode(marker));
    });
    clone.querySelectorAll("button, [role='button']").forEach((button) => button.remove());
    const text = clone.innerText || clone.textContent || "";
    return restoreMarkdownCodeBlocks(text, codeBlocks);
  }
  function isContinueButtonLabel(label) {
    return label.trim().replace(/\s+/g, " ").toLowerCase() === "continue";
  }
  function combineContinuedResponse(previous, current) {
    if (!current) return previous;
    if (!previous) return current;
    if (current.startsWith(previous)) return current;
    if (previous.endsWith(current)) return previous;
    return `${previous}

${current}`;
  }
  function shouldCommitFinalAnswer(text, started, streaming, stableForMs, awaitingContinuation = false) {
    return started && Boolean(text.trim()) && !streaming && !awaitingContinuation && stableForMs >= 3500;
  }
  function detectDeepSeekActivity(thinkingVisible, finalAnswerStarted) {
    if (thinkingVisible) return "thinking";
    return finalAnswerStarted ? "answering" : void 0;
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
  async function runDeepSeekPrompt(prompt, chatUrl, timeoutMs = 18e4, onActivity, newConversation = false) {
    if (!isDeepSeekHost(location.hostname))
      return { ok: false, error: "Open the official DeepSeek chat website and sign in first." };
    if (newConversation) {
      if (!isDeepSeekNewConversationPage(location.href))
        return { ok: false, error: "The new DeepSeek conversation page is not open. Click New conversation and retry." };
    } else {
      try {
        if (!isDeepSeekConversationUrl(location.href, chatUrl))
          return {
            ok: false,
            error: "The active DeepSeek tab is not the configured conversation. Check the saved chat URL and retry."
          };
      } catch {
        return {
          ok: false,
          error: "The configured DeepSeek conversation URL is invalid. Set a valid chat.deepseek.com conversation URL in VS Code settings."
        };
      }
    }
    const input = findInput();
    if (!input)
      return {
        ok: false,
        error: "DeepSeek chat input was not found. Sign in or check whether the website layout changed."
      };
    const before = responseNodes();
    const previousLast = selectLatestFinalAnswer(
      before.map((node) => ({ text: extractResponseText(node), isThinking: false }))
    );
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
      let awaitingContinuation = false;
      let continuationBase = "";
      let lastObservedResponse = "";
      let continuationIsSeparateSegment = false;
      let lastActivity;
      let finished = false;
      const clickedContinueButtons = /* @__PURE__ */ new WeakSet();
      const isExpectedPage = () => newConversation ? isDeepSeekNewConversationPage(location.href) : isDeepSeekConversationUrl(location.href, chatUrl);
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
        if (!isExpectedPage()) {
          finish({
            ok: false,
            error: "The DeepSeek page navigated away from the configured conversation before its response completed."
          });
          return;
        }
        const nodes = responseNodes();
        const response = selectLatestFinalAnswer(
          nodes.map((node) => ({ text: extractResponseText(node), isThinking: false }))
        );
        const isThinking = [...document.querySelectorAll(THINKING_SELECTOR)].some(visible);
        if (response && (nodes.length > before.length || response !== previousLast)) {
          responseStarted = true;
        }
        const activity = detectDeepSeekActivity(isThinking, responseStarted);
        if (activity && lastActivity !== activity) {
          lastActivity = activity;
          onActivity?.(activity);
        }
        if (awaitingContinuation && response && response !== lastObservedResponse) {
          lastText = combineContinuedResponse(continuationBase, response);
          continuationIsSeparateSegment = !response.startsWith(continuationBase);
          lastObservedResponse = response;
          awaitingContinuation = false;
          stableSince = Date.now();
        } else if (continuationIsSeparateSegment && response && response !== lastObservedResponse) {
          lastText = combineContinuedResponse(continuationBase, response);
          lastObservedResponse = response;
          stableSince = Date.now();
        } else if (!continuationIsSeparateSegment && response !== lastText) {
          lastText = response;
          lastObservedResponse = response;
          stableSince = Date.now();
        }
        if (!awaitingContinuation) {
          const continueButton = [...document.querySelectorAll('[role="button"], button')].find(
            (button) => visible(button) && !clickedContinueButtons.has(button) && [button.getAttribute("aria-label") ?? "", button.getAttribute("title") ?? "", button.innerText].some(
              isContinueButtonLabel
            )
          );
          if (continueButton) {
            clickedContinueButtons.add(continueButton);
            continuationBase = lastText;
            lastObservedResponse = response;
            continuationIsSeparateSegment = false;
            awaitingContinuation = true;
            stableSince = Date.now();
            try {
              continueButton.click();
            } catch {
              finish({ ok: false, error: "Could not activate DeepSeek's Continue control." });
              return;
            }
          }
        }
        const streaming = [...document.querySelectorAll("button")].some((button) => {
          if (!visible(button)) return false;
          const label = `${button.getAttribute("aria-label") ?? ""} ${button.title} ${button.textContent ?? ""}`.toLowerCase();
          return /stop|interrupt|停止/.test(label);
        });
        if (shouldCommitFinalAnswer(lastText, responseStarted, streaming, Date.now() - stableSince, awaitingContinuation)) {
          if (newConversation && !isDeepSeekConversationPage(location.href)) {
            finish({
              ok: false,
              error: "DeepSeek answered, but did not expose a conversation URL. The new chat was not saved as the active conversation."
            });
            return;
          }
          finish({
            ok: true,
            response: lastText,
            ...newConversation ? { conversationUrl: `${location.origin}${location.pathname.replace(/\/$/, "")}` } : {}
          });
        }
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
  function deepSeekNewConversationStatus() {
    const intendedChat = isDeepSeekHost(location.hostname) && isDeepSeekNewConversationPage(location.href);
    return { available: intendedChat && findInput() !== null, intendedChat };
  }
  function isDeepSeekConversationPage(currentUrl) {
    try {
      const url = new URL(currentUrl);
      validateDeepSeekChatUrl(`${url.origin}${url.pathname}`);
      return true;
    } catch {
      return false;
    }
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
    if (message?.type === "check-new-conversation") {
      sendResponse(deepSeekNewConversationStatus());
      return false;
    }
    if (message?.type === "cancel-prompt") {
      cancelDeepSeekPrompt();
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type !== "run-prompt" || typeof message.prompt !== "string" || typeof message.chatUrl !== "string")
      return;
    void runDeepSeekPrompt(
      message.prompt,
      message.chatUrl,
      message.timeoutMs,
      (activity) => {
        void chrome.runtime.sendMessage({ type: "thinking-state", activity }).catch(() => void 0);
      },
      message.newConversation === true
    ).then(sendResponse);
    return true;
  });
})();
//# sourceMappingURL=content.js.map

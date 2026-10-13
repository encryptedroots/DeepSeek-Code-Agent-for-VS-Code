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
  function planConversationTab(tabs, configuredUrl) {
    const intended = tabs.find((tab) => tab.url && isDeepSeekConversationUrl(tab.url, configuredUrl));
    if (intended) return { action: "reuse", tab: intended };
    const reusable = tabs.find((tab) => tab.active) ?? tabs[0];
    return reusable ? { action: "navigate", tab: reusable } : { action: "open" };
  }
  function isConfiguredChatReady(paired, page) {
    return paired && page?.available === true && page.intendedChat === true;
  }

  // src/readiness.ts
  async function waitForReadiness(probe, isReady, timeoutMs, intervalMs = 500, shouldContinue = () => true) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!shouldContinue()) throw new Error("Readiness check was cancelled.");
      const value = await probe();
      if (value !== void 0 && isReady(value)) return value;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error("Timed out waiting for the requested page to become ready.");
  }
  async function waitForReadinessWithReload(probe, isReady, reload, initialTimeoutMs, retryTimeoutMs, intervalMs = 500, shouldContinue = () => true) {
    try {
      return await waitForReadiness(probe, isReady, initialTimeoutMs, intervalMs, shouldContinue);
    } catch (error) {
      if (error instanceof Error && error.message === "Readiness check was cancelled.") throw error;
      if (!shouldContinue()) throw new Error("Readiness check was cancelled.");
      await reload();
      return waitForReadiness(probe, isReady, retryTimeoutMs, intervalMs, shouldContinue);
    }
  }

  // src/background.ts
  var DEFAULT_URL = "http://127.0.0.1:43127";
  var running = false;
  var activeJob;
  var retryDelayMs = 1e3;
  chrome.alarms.create("bridge-poll", { periodInMinutes: 0.5 });
  async function getPairing() {
    const stored = await chrome.storage.local.get(["baseUrl", "token"]);
    if (typeof stored.baseUrl !== "string" || typeof stored.token !== "string") return void 0;
    return { baseUrl: stored.baseUrl.replace(/\/+$/, ""), token: stored.token };
  }
  async function authorizedFetch(path, init = {}) {
    const pairing = await getPairing();
    if (!pairing) throw new Error("Pair this extension with VS Code first.");
    return fetch(`${pairing.baseUrl}${path}`, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${pairing.token}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(15e3)
    });
  }
  async function getConfiguredChatUrl() {
    const stored = await chrome.storage.local.get("chatUrl");
    if (typeof stored.chatUrl !== "string")
      throw new Error("Save a DeepSeek conversation URL in the browser extension popup before starting a task.");
    return validateDeepSeekChatUrl(stored.chatUrl);
  }
  async function findOrOpenConversation(chatUrl) {
    const tabs = await chrome.tabs.query({ url: ["https://chat.deepseek.com/*"] });
    const plan = planConversationTab(tabs, chatUrl);
    if (plan.action === "open") return chrome.tabs.create({ url: chatUrl, active: true });
    if (plan.tab.id === void 0) throw new Error("Could not identify the existing DeepSeek browser tab.");
    if (plan.action === "reuse") return plan.tab;
    return chrome.tabs.update(plan.tab.id, { url: chatUrl });
  }
  async function waitForConversationReady(tabId, chatUrl, jobId) {
    let currentUrl = "";
    let pageChecked = false;
    try {
      await waitForReadinessWithReload(
        async () => {
          try {
            const tab = await chrome.tabs.get(tabId);
            currentUrl = tab.url ?? "";
            if (tab.status === "complete" && isDeepSeekConversationUrl(currentUrl, chatUrl)) {
              const page = await chrome.tabs.sendMessage(tabId, { type: "check-page", chatUrl });
              pageChecked = true;
              return page;
            }
          } catch {
          }
          return void 0;
        },
        (page) => page.available === true && page.intendedChat === true,
        async () => {
          if (activeJob?.id !== jobId) throw new Error("Readiness check was cancelled.");
          const tab = await chrome.tabs.get(tabId);
          if (!isDeepSeekConversationUrl(tab.url ?? "", chatUrl)) {
            await chrome.tabs.update(tabId, { url: chatUrl });
            return;
          }
          await chrome.tabs.reload(tabId);
        },
        12e3,
        6e4,
        500,
        () => activeJob?.id === jobId
      );
    } catch (error) {
      if (error instanceof Error && error.message === "Readiness check was cancelled.") throw error;
      if (!isDeepSeekConversationUrl(currentUrl, chatUrl)) {
        throw new Error(
          "Could not open the configured DeepSeek conversation after automatically retrying navigation. Check the saved URL and sign-in state."
        );
      }
      throw new Error(
        pageChecked ? "The configured conversation is open, but its chat input is unavailable after an automatic page reload. Sign in manually or check for a DeepSeek layout change." : "The configured DeepSeek conversation did not become ready after an automatic page reload. Check your connection and sign-in state."
      );
    }
  }
  function failActiveJob(error) {
    if (!activeJob) return;
    const job = activeJob;
    activeJob = void 0;
    void authorizedFetch("/complete", {
      method: "POST",
      body: JSON.stringify({ id: job.id, error })
    }).catch(
      (failure) => console.warn(
        "[DeepSeek Code Agent] Could not report a closed or navigated chat tab:",
        failure instanceof Error ? failure.name : "unknown error"
      )
    );
  }
  async function poll() {
    if (running) return;
    running = true;
    try {
      const response = await authorizedFetch("/next");
      retryDelayMs = 1e3;
      if (response.status === 204) return;
      if (!response.ok) throw new Error(`Bridge request failed (${response.status}).`);
      const job = await response.json();
      if (typeof job.id !== "string" || !/^[0-9a-f-]{36}$/i.test(job.id) || typeof job.prompt !== "string" || job.prompt.length > 4e5 || typeof job.responseLimit !== "number" || job.responseLimit < 1 || job.responseLimit > 2e5) {
        throw new Error("VS Code sent an invalid bridge request.");
      }
      let chatUrl;
      let tab;
      try {
        chatUrl = await getConfiguredChatUrl();
        tab = await findOrOpenConversation(chatUrl);
        if (tab.id === void 0)
          throw new Error("Could not identify a browser tab for the configured DeepSeek conversation.");
      } catch (error) {
        const failed = await authorizedFetch("/complete", {
          method: "POST",
          body: JSON.stringify({
            id: job.id,
            error: error instanceof Error ? error.message : "The configured DeepSeek conversation URL is invalid."
          })
        });
        if (!failed.ok) throw new Error(`Could not report invalid DeepSeek chat configuration (${failed.status}).`);
        return;
      }
      activeJob = { id: job.id, tabId: tab.id, chatUrl };
      const cancellationWatch = setInterval(() => {
        void authorizedFetch(`/cancelled?id=${encodeURIComponent(job.id)}`).then(async (cancelResponse) => {
          if (cancelResponse.ok && (await cancelResponse.json()).cancelled) {
            if (activeJob?.id === job.id) activeJob = void 0;
            await chrome.tabs.sendMessage(tab.id, { type: "cancel-prompt" }).catch(() => void 0);
          }
        }).catch(() => void 0);
      }, 800);
      let result;
      try {
        await waitForConversationReady(tab.id, chatUrl, job.id);
        if (activeJob?.id !== job.id) throw new Error("The DeepSeek request was interrupted before prompt submission.");
        const text = await chrome.tabs.sendMessage(tab.id, {
          type: "run-prompt",
          prompt: job.prompt,
          chatUrl,
          timeoutMs: 18e4
        });
        if (!text?.ok)
          throw new Error(typeof text?.error === "string" ? text.error : "DeepSeek page integration failed.");
        if (typeof text.response !== "string" || !text.response.trim())
          throw new Error("DeepSeek returned an empty response.");
        result = new TextEncoder().encode(text.response).byteLength > job.responseLimit ? { error: "DeepSeek response exceeded the configured response size limit; no partial response was used." } : { response: text.response };
      } catch (error) {
        result = { error: error instanceof Error ? error.message : "DeepSeek request failed." };
      } finally {
        clearInterval(cancellationWatch);
      }
      if (activeJob?.id !== job.id) return;
      activeJob = void 0;
      const completed = await authorizedFetch("/complete", {
        method: "POST",
        body: JSON.stringify({ id: job.id, ...result })
      });
      if (!completed.ok) throw new Error(`Could not return response to VS Code (${completed.status}).`);
    } catch (error) {
      console.warn(
        "[DeepSeek Code Agent] Bridge polling failed:",
        error instanceof Error ? error.message : "unknown error"
      );
      retryDelayMs = Math.min(retryDelayMs * 2, 3e4);
    } finally {
      running = false;
      setTimeout(() => void poll(), retryDelayMs);
    }
  }
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "bridge-poll") void poll();
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    if (activeJob?.tabId === tabId) failActiveJob("The authenticated DeepSeek chat tab was closed.");
  });
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (activeJob?.tabId === tabId && changeInfo.url && !isDeepSeekConversationUrl(changeInfo.url, activeJob.chatUrl)) {
      failActiveJob("The DeepSeek tab navigated away from the configured conversation.");
      void chrome.tabs.sendMessage(tabId, { type: "cancel-prompt" }).catch(() => void 0);
    }
  });
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "pair") {
      const baseUrl = typeof message.baseUrl === "string" ? message.baseUrl.replace(/\/+$/, "") : DEFAULT_URL;
      const code = typeof message.code === "string" ? message.code.trim() : "";
      let parsedUrl;
      try {
        parsedUrl = new URL(baseUrl);
      } catch {
        sendResponse({ ok: false, message: "Bridge URL is invalid." });
        return false;
      }
      if (parsedUrl.protocol !== "http:" || parsedUrl.hostname !== "127.0.0.1" || parsedUrl.username || parsedUrl.password || parsedUrl.pathname !== "/" || parsedUrl.search || parsedUrl.hash) {
        sendResponse({ ok: false, message: "For security, the bridge must use an http://127.0.0.1 URL." });
        return false;
      }
      void fetch(`${baseUrl}/pair`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
        signal: AbortSignal.timeout(1e4)
      }).then(async (response) => {
        if (!response.ok) throw new Error(await response.text() || `Pairing failed (${response.status}).`);
        const body = await response.json();
        if (!body.token) throw new Error("Bridge did not return a pairing token.");
        await chrome.storage.local.set({ baseUrl, token: body.token });
        sendResponse({
          ok: true,
          message: "Paired with VS Code. DeepSeek conversation readiness is checked separately."
        });
        void poll();
      }).catch(
        (error) => sendResponse({ ok: false, message: error instanceof Error ? error.message : "Pairing failed." })
      );
      return true;
    }
    if (message?.type === "health") {
      void Promise.all([authorizedFetch("/health"), getConfiguredChatUrl()]).then(async ([response, chatUrl]) => {
        const bridgeState = await response.json();
        const tabs = await chrome.tabs.query({ url: ["https://chat.deepseek.com/*"] });
        const tab = tabs.find((candidate) => candidate.url && isDeepSeekConversationUrl(candidate.url, chatUrl));
        const page = response.ok && tab?.id !== void 0 ? await chrome.tabs.sendMessage(tab.id, { type: "check-page", chatUrl }).catch(() => void 0) : void 0;
        const ready = response.ok && isConfiguredChatReady(bridgeState.paired === true, page);
        const pageReady = page?.available === true && page?.intendedChat === true;
        sendResponse({
          ok: response.ok,
          paired: bridgeState.paired === true,
          browserActive: bridgeState.browserActive === true,
          pageAvailable: pageReady,
          conversationMatched: pageReady,
          chatUrl,
          message: ready ? "VS Code is paired and the configured conversation URL and chat input are ready." : bridgeState.paired ? pageReady ? "VS Code is paired and the configured chat input is ready." : "VS Code pairing is active, but the configured DeepSeek conversation and input are not yet ready. Open it, sign in manually, or reload the tab." : pageReady ? "The configured DeepSeek conversation and input are ready, but pairing with VS Code is not active." : "VS Code is not paired, and the configured DeepSeek chat input is not ready."
        });
      }).catch(
        (error) => sendResponse({ ok: false, message: error instanceof Error ? error.message : "Bridge unavailable." })
      );
      return true;
    }
    if (message?.type === "page-health") {
      void chrome.storage.local.set({ pageAvailable: message.available === true, pageOrigin: message.url });
      return false;
    }
    return false;
  });
  void poll();
})();
//# sourceMappingURL=background.js.map

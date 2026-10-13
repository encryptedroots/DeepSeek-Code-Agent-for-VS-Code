import {
  isConfiguredChatReady,
  isDeepSeekConversationUrl,
  planConversationTab,
  validateDeepSeekChatUrl,
} from "./chatUrl";
import { waitForReadinessWithReload } from "./readiness";

interface Pairing {
  baseUrl: string;
  token: string;
}

const DEFAULT_URL = "http://127.0.0.1:43127";
let running = false;
let activeJob: { id: string; tabId: number; chatUrl: string } | undefined;
let retryDelayMs = 1_000;

chrome.alarms.create("bridge-poll", { periodInMinutes: 0.5 });

async function getPairing(): Promise<Pairing | undefined> {
  const stored = await chrome.storage.local.get(["baseUrl", "token"]);
  if (typeof stored.baseUrl !== "string" || typeof stored.token !== "string") return undefined;
  return { baseUrl: stored.baseUrl.replace(/\/+$/, ""), token: stored.token };
}

async function authorizedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const pairing = await getPairing();
  if (!pairing) throw new Error("Pair this extension with VS Code first.");
  return fetch(`${pairing.baseUrl}${path}`, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${pairing.token}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
}

async function getConfiguredChatUrl(): Promise<string> {
  const stored = await chrome.storage.local.get("chatUrl");
  if (typeof stored.chatUrl !== "string")
    throw new Error("Save a DeepSeek conversation URL in the browser extension popup before starting a task.");
  return validateDeepSeekChatUrl(stored.chatUrl);
}

async function findOrOpenConversation(chatUrl: string): Promise<chrome.tabs.Tab> {
  const tabs = await chrome.tabs.query({ url: ["https://chat.deepseek.com/*"] });
  const plan = planConversationTab(tabs, chatUrl);
  if (plan.action === "open") return chrome.tabs.create({ url: chatUrl, active: true });
  if (plan.tab.id === undefined) throw new Error("Could not identify the existing DeepSeek browser tab.");
  if (plan.action === "reuse") return plan.tab;
  return chrome.tabs.update(plan.tab.id, { url: chatUrl });
}

async function waitForConversationReady(tabId: number, chatUrl: string, jobId: string): Promise<void> {
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
            return page as { available?: boolean; intendedChat?: boolean };
          }
        } catch {
          // Navigation can briefly remove the content script before the page is ready.
        }
        return undefined;
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
      12_000,
      60_000,
      500,
      () => activeJob?.id === jobId,
    );
  } catch (error) {
    if (error instanceof Error && error.message === "Readiness check was cancelled.") throw error;
    if (!isDeepSeekConversationUrl(currentUrl, chatUrl)) {
      throw new Error(
        "Could not open the configured DeepSeek conversation after automatically retrying navigation. Check the saved URL and sign-in state.",
      );
    }
    throw new Error(
      pageChecked
        ? "The configured conversation is open, but its chat input is unavailable after an automatic page reload. Sign in manually or check for a DeepSeek layout change."
        : "The configured DeepSeek conversation did not become ready after an automatic page reload. Check your connection and sign-in state.",
    );
  }
}

function failActiveJob(error: string): void {
  if (!activeJob) return;
  const job = activeJob;
  activeJob = undefined;
  void authorizedFetch("/complete", {
    method: "POST",
    body: JSON.stringify({ id: job.id, error }),
  }).catch((failure: unknown) =>
    console.warn(
      "[DeepSeek Code Agent] Could not report a closed or navigated chat tab:",
      failure instanceof Error ? failure.name : "unknown error",
    ),
  );
}

async function poll(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const response = await authorizedFetch("/next");
    retryDelayMs = 1_000;
    if (response.status === 204) return;
    if (!response.ok) throw new Error(`Bridge request failed (${response.status}).`);
    const job = (await response.json()) as { id?: string; prompt?: string; responseLimit?: number };
    if (
      typeof job.id !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(job.id) ||
      typeof job.prompt !== "string" ||
      job.prompt.length > 400_000 ||
      typeof job.responseLimit !== "number" ||
      job.responseLimit < 1 ||
      job.responseLimit > 200_000
    ) {
      throw new Error("VS Code sent an invalid bridge request.");
    }
    let chatUrl: string;
    let tab: chrome.tabs.Tab;
    try {
      chatUrl = await getConfiguredChatUrl();
      tab = await findOrOpenConversation(chatUrl);
      if (tab.id === undefined)
        throw new Error("Could not identify a browser tab for the configured DeepSeek conversation.");
    } catch (error) {
      const failed = await authorizedFetch("/complete", {
        method: "POST",
        body: JSON.stringify({
          id: job.id,
          error: error instanceof Error ? error.message : "The configured DeepSeek conversation URL is invalid.",
        }),
      });
      if (!failed.ok) throw new Error(`Could not report invalid DeepSeek chat configuration (${failed.status}).`);
      return;
    }
    activeJob = { id: job.id, tabId: tab.id, chatUrl };
    const cancellationWatch = setInterval(() => {
      void authorizedFetch(`/cancelled?id=${encodeURIComponent(job.id!)}`)
        .then(async (cancelResponse) => {
          if (cancelResponse.ok && ((await cancelResponse.json()) as { cancelled?: boolean }).cancelled) {
            if (activeJob?.id === job.id) activeJob = undefined;
            await chrome.tabs.sendMessage(tab.id!, { type: "cancel-prompt" }).catch(() => undefined);
          }
        })
        .catch(() => undefined);
    }, 800);
    let result: { response?: string; error?: string };
    try {
      await waitForConversationReady(tab.id, chatUrl, job.id);
      if (activeJob?.id !== job.id) throw new Error("The DeepSeek request was interrupted before prompt submission.");
      const text = await chrome.tabs.sendMessage(tab.id, {
        type: "run-prompt",
        prompt: job.prompt,
        chatUrl,
        timeoutMs: 180_000,
      });
      if (!text?.ok)
        throw new Error(typeof text?.error === "string" ? text.error : "DeepSeek page integration failed.");
      if (typeof text.response !== "string" || !text.response.trim())
        throw new Error("DeepSeek returned an empty response.");
      result =
        new TextEncoder().encode(text.response).byteLength > job.responseLimit
          ? { error: "DeepSeek response exceeded the configured response size limit; no partial response was used." }
          : { response: text.response };
    } catch (error) {
      result = { error: error instanceof Error ? error.message : "DeepSeek request failed." };
    } finally {
      clearInterval(cancellationWatch);
    }
    if (activeJob?.id !== job.id) return;
    activeJob = undefined;
    const completed = await authorizedFetch("/complete", {
      method: "POST",
      body: JSON.stringify({ id: job.id, ...result }),
    });
    if (!completed.ok) throw new Error(`Could not return response to VS Code (${completed.status}).`);
  } catch (error) {
    console.warn(
      "[DeepSeek Code Agent] Bridge polling failed:",
      error instanceof Error ? error.message : "unknown error",
    );
    retryDelayMs = Math.min(retryDelayMs * 2, 30_000);
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
    void chrome.tabs.sendMessage(tabId, { type: "cancel-prompt" }).catch(() => undefined);
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (
    message?.type === "thinking-state" &&
    activeJob &&
    (message.activity === "thinking" || message.activity === "answering") &&
    _sender.tab?.id === activeJob.tabId
  ) {
    void authorizedFetch("/activity", {
      method: "POST",
      body: JSON.stringify({ id: activeJob.id, activity: message.activity }),
    }).catch((error: unknown) =>
      console.warn(
        "[DeepSeek Code Agent] Could not forward DeepSeek activity:",
        error instanceof Error ? error.message : "unknown error",
      ),
    );
    return false;
  }
  if (message?.type === "pair") {
    const baseUrl = typeof message.baseUrl === "string" ? message.baseUrl.replace(/\/+$/, "") : DEFAULT_URL;
    const code = typeof message.code === "string" ? message.code.trim() : "";
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(baseUrl);
    } catch {
      sendResponse({ ok: false, message: "Bridge URL is invalid." });
      return false;
    }
    if (
      parsedUrl.protocol !== "http:" ||
      parsedUrl.hostname !== "127.0.0.1" ||
      parsedUrl.username ||
      parsedUrl.password ||
      parsedUrl.pathname !== "/" ||
      parsedUrl.search ||
      parsedUrl.hash
    ) {
      sendResponse({ ok: false, message: "For security, the bridge must use an http://127.0.0.1 URL." });
      return false;
    }
    void fetch(`${baseUrl}/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
      signal: AbortSignal.timeout(10_000),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error((await response.text()) || `Pairing failed (${response.status}).`);
        const body = (await response.json()) as { token?: string };
        if (!body.token) throw new Error("Bridge did not return a pairing token.");
        await chrome.storage.local.set({ baseUrl, token: body.token });
        sendResponse({
          ok: true,
          message: "Paired with VS Code. DeepSeek conversation readiness is checked separately.",
        });
        void poll();
      })
      .catch((error: unknown) =>
        sendResponse({ ok: false, message: error instanceof Error ? error.message : "Pairing failed." }),
      );
    return true;
  }
  if (message?.type === "health") {
    void Promise.all([authorizedFetch("/health"), getConfiguredChatUrl()])
      .then(async ([response, chatUrl]) => {
        const bridgeState = (await response.json()) as { paired?: boolean; browserActive?: boolean };
        const tabs = await chrome.tabs.query({ url: ["https://chat.deepseek.com/*"] });
        const tab = tabs.find((candidate) => candidate.url && isDeepSeekConversationUrl(candidate.url, chatUrl));
        const page =
          response.ok && tab?.id !== undefined
            ? await chrome.tabs.sendMessage(tab.id, { type: "check-page", chatUrl }).catch(() => undefined)
            : undefined;
        const ready = response.ok && isConfiguredChatReady(bridgeState.paired === true, page);
        const pageReady = page?.available === true && page?.intendedChat === true;
        sendResponse({
          ok: response.ok,
          paired: bridgeState.paired === true,
          browserActive: bridgeState.browserActive === true,
          pageAvailable: pageReady,
          conversationMatched: pageReady,
          chatUrl,
          message: ready
            ? "VS Code is paired and the configured conversation URL and chat input are ready."
            : bridgeState.paired
              ? pageReady
                ? "VS Code is paired and the configured chat input is ready."
                : "VS Code pairing is active, but the configured DeepSeek conversation and input are not yet ready. Open it, sign in manually, or reload the tab."
              : pageReady
                ? "The configured DeepSeek conversation and input are ready, but pairing with VS Code is not active."
                : "VS Code is not paired, and the configured DeepSeek chat input is not ready.",
        });
      })
      .catch((error: unknown) =>
        sendResponse({ ok: false, message: error instanceof Error ? error.message : "Bridge unavailable." }),
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

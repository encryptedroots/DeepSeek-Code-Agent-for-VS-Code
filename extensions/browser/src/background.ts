import {
  isConfiguredChatReady,
  isDeepSeekConversationUrl,
  isDeepSeekNewConversationPage,
  planConversationTab,
  validateDeepSeekChatUrl,
} from "./chatUrl";
import { waitForReadinessWithReload } from "./readiness";

interface Pairing {
  baseUrl: string;
  token: string;
}

async function openNewConversation(id: string): Promise<void> {
  let error: string | undefined;
  let currentRequest = true;
  try {
    const tab = await findOrOpenNewConversation();
    if (tab.id === undefined) throw new Error("Could not identify a browser tab for the new conversation.");
    await waitForConversationReady(tab.id, "https://chat.deepseek.com/", id, true, () => currentRequest);
  } catch (failure) {
    error = failure instanceof Error ? failure.message : "Could not open a new DeepSeek conversation.";
  } finally {
    currentRequest = false;
  }
  const response = await authorizedFetch("/new-conversation/complete", {
    method: "POST",
    body: JSON.stringify({ id, ok: error === undefined, ...(error ? { error } : {}) }),
  });
  if (!response.ok) throw new Error(`Could not confirm the new DeepSeek conversation (${response.status}).`);
}

const DEFAULT_URL = "http://127.0.0.1:43127";
let running = false;
let activeJob: { id: string; tabId: number; chatUrl: string; newConversation: boolean } | undefined;
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

async function findOrOpenConversation(chatUrl: string): Promise<chrome.tabs.Tab> {
  const tabs = await chrome.tabs.query({ url: ["https://chat.deepseek.com/*"] });
  const plan = planConversationTab(tabs, chatUrl);
  if (plan.action === "open") return chrome.tabs.create({ url: chatUrl, active: true });
  if (plan.tab.id === undefined) throw new Error("Could not identify the existing DeepSeek browser tab.");
  if (plan.action === "reuse") return plan.tab;
  return chrome.tabs.update(plan.tab.id, { url: chatUrl });
}

async function findOrOpenNewConversation(): Promise<chrome.tabs.Tab> {
  const tabs = await chrome.tabs.query({ url: ["https://chat.deepseek.com/*"] });
  const existingNewChat = tabs.find((tab) => tab.url && new URL(tab.url).pathname === "/");
  if (existingNewChat) return existingNewChat;
  const reusable = tabs.find((tab) => tab.active) ?? tabs[0];
  if (reusable?.id !== undefined) return chrome.tabs.update(reusable.id, { url: "https://chat.deepseek.com/" });
  return chrome.tabs.create({ url: "https://chat.deepseek.com/", active: true });
}

async function waitForConversationReady(
  tabId: number,
  chatUrl: string,
  jobId: string,
  newConversation = false,
  isCurrentRequest: () => boolean = () => activeJob?.id === jobId,
): Promise<void> {
  let currentUrl = "";
  let pageChecked = false;
  try {
    await waitForReadinessWithReload(
      async () => {
        try {
          const tab = await chrome.tabs.get(tabId);
          currentUrl = tab.url ?? "";
          const correctPage = newConversation
            ? tab.status === "complete" && isDeepSeekNewConversationPage(currentUrl)
            : tab.status === "complete" && isDeepSeekConversationUrl(currentUrl, chatUrl);
          if (correctPage) {
            const page = await chrome.tabs.sendMessage(tabId, {
              type: newConversation ? "check-new-conversation" : "check-page",
              chatUrl,
            });
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
        if (!isCurrentRequest()) throw new Error("Readiness check was cancelled.");
        const tab = await chrome.tabs.get(tabId);
        const correctPage = newConversation
          ? isDeepSeekNewConversationPage(tab.url ?? "")
          : isDeepSeekConversationUrl(tab.url ?? "", chatUrl);
        if (!correctPage) {
          await chrome.tabs.update(tabId, { url: newConversation ? "https://chat.deepseek.com/" : chatUrl });
          return;
        }
        await chrome.tabs.reload(tabId);
      },
      12_000,
      60_000,
      500,
      isCurrentRequest,
    );
  } catch (error) {
    if (error instanceof Error && error.message === "Readiness check was cancelled.") throw error;
    const correctPage = newConversation
      ? isDeepSeekNewConversationPage(currentUrl)
      : isDeepSeekConversationUrl(currentUrl, chatUrl);
    if (!correctPage) {
      throw new Error(
        newConversation
          ? "Could not open a new DeepSeek conversation after automatically retrying navigation. Check your sign-in state."
          : "Could not open the configured DeepSeek conversation after automatically retrying navigation. Check the saved URL and sign-in state.",
      );
    }
    throw new Error(
      pageChecked
        ? newConversation
          ? "The new DeepSeek chat page opened, but its input is unavailable after an automatic page reload. Sign in manually or check for a DeepSeek layout change."
          : "The configured conversation is open, but its chat input is unavailable after an automatic page reload. Sign in manually or check for a DeepSeek layout change."
        : newConversation
          ? "The new DeepSeek chat page did not become ready after an automatic page reload. Check your connection and sign-in state."
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
    const job = (await response.json()) as {
      type?: string;
      id?: string;
      prompt?: string;
      responseLimit?: number;
      chatUrl?: string;
      newConversation?: boolean;
    };
    if (job.type === "new-conversation") {
      if (typeof job.id !== "string" || !/^[0-9a-f-]{36}$/i.test(job.id))
        throw new Error("VS Code sent an invalid new-conversation request.");
      await openNewConversation(job.id);
      return;
    }
    if (
      typeof job.id !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(job.id) ||
      typeof job.prompt !== "string" ||
      job.prompt.length > 400_000 ||
      typeof job.responseLimit !== "number" ||
      job.responseLimit < 1 ||
      job.responseLimit > 200_000 ||
      typeof job.chatUrl !== "string" ||
      (job.newConversation !== undefined && typeof job.newConversation !== "boolean")
    ) {
      throw new Error("VS Code sent an invalid bridge request.");
    }
    let chatUrl: string;
    let tab: chrome.tabs.Tab;
    try {
      chatUrl = validateDeepSeekChatUrl(job.chatUrl);
      tab = job.newConversation ? await findOrOpenNewConversation() : await findOrOpenConversation(chatUrl);
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
    activeJob = { id: job.id, tabId: tab.id, chatUrl, newConversation: job.newConversation === true };
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
    let result: { response?: string; error?: string; conversationUrl?: string };
    try {
      await waitForConversationReady(tab.id, chatUrl, job.id, job.newConversation === true);
      if (activeJob?.id !== job.id) throw new Error("The DeepSeek request was interrupted before prompt submission.");
      const text = await chrome.tabs.sendMessage(tab.id, {
        type: "run-prompt",
        prompt: job.prompt,
        chatUrl,
        newConversation: job.newConversation === true,
        timeoutMs: 180_000,
      });
      if (!text?.ok)
        throw new Error(typeof text?.error === "string" ? text.error : "DeepSeek page integration failed.");
      if (typeof text.response !== "string" || !text.response.trim())
        throw new Error("DeepSeek returned an empty response.");
      result =
        new TextEncoder().encode(text.response).byteLength > job.responseLimit
          ? { error: "DeepSeek response exceeded the configured response size limit; no partial response was used." }
          : {
              response: text.response,
              ...(typeof text.conversationUrl === "string"
                ? { conversationUrl: validateDeepSeekChatUrl(text.conversationUrl) }
                : {}),
            };
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
  const validLocation =
    activeJob?.newConversation && changeInfo.url
      ? isDeepSeekNewConversationPage(changeInfo.url)
      : changeInfo.url && activeJob
        ? isDeepSeekConversationUrl(changeInfo.url, activeJob.chatUrl)
        : true;
  if (activeJob?.tabId === tabId && changeInfo.url && !validLocation) {
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
    void authorizedFetch("/health")
      .then(async (response) => {
        const bridgeState = (await response.json()) as {
          paired?: boolean;
          browserActive?: boolean;
          chatUrl?: string;
        };
        if (typeof bridgeState.chatUrl !== "string") {
          sendResponse({
            ok: false,
            message: "Configure a valid DeepSeek conversation URL in VS Code settings first.",
          });
          return;
        }
        const chatUrl = validateDeepSeekChatUrl(bridgeState.chatUrl);
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

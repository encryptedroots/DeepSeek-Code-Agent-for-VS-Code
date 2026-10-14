import { isDeepSeekConversationUrl, isDeepSeekNewConversationPage, validateDeepSeekChatUrl } from "./chatUrl";

export type AdapterResult = { ok: true; response: string; conversationUrl?: string } | { ok: false; error: string };

const INPUT_SELECTORS = ["textarea", '[contenteditable="true"]', '[role="textbox"]'];
const RESPONSE_SELECTORS = [".ds-markdown", ".markdown", '[class*="markdown"]'];
const THINKING_SELECTOR = ".ds-think-content";
let activeRequest: (() => void) | undefined;

function visible(element: Element): boolean {
  const style = getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden" && element.getBoundingClientRect().height > 0;
}

function findInput(): HTMLElement | null {
  for (const selector of INPUT_SELECTORS) {
    const input = [...document.querySelectorAll<HTMLElement>(selector)].find(visible);
    if (input) return input;
  }
  return null;
}

function responseNodes(): HTMLElement[] {
  for (const selector of RESPONSE_SELECTORS) {
    const nodes = [...document.querySelectorAll<HTMLElement>(selector)].filter(
      (node) => visible(node) && !node.closest(THINKING_SELECTOR),
    );
    if (nodes.length) return nodes;
  }
  return [];
}

export function selectLatestFinalAnswer(candidates: Array<{ text: string; isThinking: boolean }>): string {
  return (
    [...candidates]
      .reverse()
      .find((candidate) => !candidate.isThinking && candidate.text.trim())
      ?.text.trim() ?? ""
  );
}

export function shouldCommitFinalAnswer(
  text: string,
  started: boolean,
  streaming: boolean,
  stableForMs: number,
): boolean {
  return started && Boolean(text.trim()) && !streaming && stableForMs >= 3_500;
}

export function detectDeepSeekActivity(
  thinkingVisible: boolean,
  finalAnswerStarted: boolean,
): "thinking" | "answering" | undefined {
  if (thinkingVisible) return "thinking";
  return finalAnswerStarted ? "answering" : undefined;
}

function setInput(input: HTMLElement, text: string): void {
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

function submit(input: HTMLElement): void {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>("button")].filter(visible);
  const send = buttons.find((button) => {
    const label =
      `${button.getAttribute("aria-label") ?? ""} ${button.getAttribute("title") ?? ""} ${button.textContent ?? ""}`.toLowerCase();
    return /send|submit|发送/.test(label) && !button.disabled;
  });
  if (send) {
    send.click();
    return;
  }
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true }));
}

export async function runDeepSeekPrompt(
  prompt: string,
  chatUrl: string,
  timeoutMs = 180_000,
  onActivity?: (activity: "thinking" | "answering") => void,
  newConversation = false,
): Promise<AdapterResult> {
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
          error: "The active DeepSeek tab is not the configured conversation. Check the saved chat URL and retry.",
        };
    } catch {
      return {
        ok: false,
        error:
          "The configured DeepSeek conversation URL is invalid. Set a valid chat.deepseek.com conversation URL in VS Code settings.",
      };
    }
  }
  const input = findInput();
  if (!input)
    return {
      ok: false,
      error: "DeepSeek chat input was not found. Sign in or check whether the website layout changed.",
    };

  const before = responseNodes();
  const previousLast = selectLatestFinalAnswer(before.map((node) => ({ text: node.innerText, isThinking: false })));
  try {
    setInput(input, prompt);
    submit(input);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not submit the prompt." };
  }

  return new Promise<AdapterResult>((resolve) => {
    let lastText = "";
    let stableSince = Date.now();
    let responseStarted = false;
    let lastActivity: "thinking" | "answering" | undefined;
    let finished = false;
    const isExpectedPage = () =>
      newConversation
        ? isDeepSeekNewConversationPage(location.href)
        : isDeepSeekConversationUrl(location.href, chatUrl);
    const finish = (result: AdapterResult) => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      observer.disconnect();
      if (activeRequest === cancel) activeRequest = undefined;
      resolve(result);
    };
    const cancel = () => finish({ ok: false, error: "Request cancelled by VS Code." });
    activeRequest = cancel;
    const inspect = () => {
      if (!isExpectedPage()) {
        finish({
          ok: false,
          error: "The DeepSeek page navigated away from the configured conversation before its response completed.",
        });
        return;
      }
      const nodes = responseNodes();
      const response = selectLatestFinalAnswer(nodes.map((node) => ({ text: node.innerText, isThinking: false })));
      const isThinking = [...document.querySelectorAll<HTMLElement>(THINKING_SELECTOR)].some(visible);
      if (response && (nodes.length > before.length || response !== previousLast)) {
        responseStarted = true;
      }
      const activity = detectDeepSeekActivity(isThinking, responseStarted);
      if (activity && lastActivity !== activity) {
        lastActivity = activity;
        onActivity?.(activity);
      }
      if (response !== lastText) {
        lastText = response;
        stableSince = Date.now();
      }
      const streaming = [...document.querySelectorAll<HTMLElement>("button")].some((button) => {
        if (!visible(button)) return false;
        const label =
          `${button.getAttribute("aria-label") ?? ""} ${button.title} ${button.textContent ?? ""}`.toLowerCase();
        return /stop|interrupt|停止/.test(label);
      });
      if (shouldCommitFinalAnswer(lastText, responseStarted, streaming, Date.now() - stableSince)) {
        if (newConversation && !isDeepSeekConversationPage(location.href)) {
          finish({
            ok: false,
            error:
              "DeepSeek answered, but did not expose a conversation URL. The new chat was not saved as the active conversation.",
          });
          return;
        }
        finish({
          ok: true,
          response: lastText,
          ...(newConversation ? { conversationUrl: `${location.origin}${location.pathname.replace(/\/$/, "")}` } : {}),
        });
      }
      if (Date.now() - started > timeoutMs) {
        finish({
          ok: false,
          error: responseStarted
            ? "DeepSeek response timed out before completion."
            : "DeepSeek did not start responding. The request may have been interrupted.",
        });
      }
    };
    const started = Date.now();
    const observer = new MutationObserver(inspect);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    const timer = setInterval(inspect, 400);
  });
}

export function deepSeekPageStatus(chatUrl: string): { available: boolean; intendedChat: boolean } {
  let intendedChat = false;
  try {
    intendedChat = isDeepSeekConversationUrl(location.href, validateDeepSeekChatUrl(chatUrl));
  } catch {
    return { available: false, intendedChat: false };
  }
  return { available: isDeepSeekHost(location.hostname) && intendedChat && findInput() !== null, intendedChat };
}

export function deepSeekNewConversationStatus(): { available: boolean; intendedChat: boolean } {
  const intendedChat = isDeepSeekHost(location.hostname) && isDeepSeekNewConversationPage(location.href);
  return { available: intendedChat && findInput() !== null, intendedChat };
}

function isDeepSeekConversationPage(currentUrl: string): boolean {
  try {
    const url = new URL(currentUrl);
    validateDeepSeekChatUrl(`${url.origin}${url.pathname}`);
    return true;
  } catch {
    return false;
  }
}

export function cancelDeepSeekPrompt(): void {
  activeRequest?.();
}

export function isDeepSeekHost(hostname: string): boolean {
  return hostname === "chat.deepseek.com";
}

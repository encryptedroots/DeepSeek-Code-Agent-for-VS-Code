const CHAT_PATH = /^\/a\/chat\/s\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/?$/i;
const NEW_CHAT_PATH = /^\/$|^\/a\/chat\/s\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/?$/i;

export function validateDeepSeekChatUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("Enter a valid DeepSeek conversation URL.");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "chat.deepseek.com" ||
    url.origin !== "https://chat.deepseek.com" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !CHAT_PATH.test(url.pathname)
  ) {
    throw new Error(
      "Use an HTTPS conversation URL from chat.deepseek.com with a valid chat ID, such as https://chat.deepseek.com/a/chat/s/<chat-id>.",
    );
  }
  return `https://chat.deepseek.com${url.pathname.replace(/\/$/, "")}`;
}

export function isDeepSeekConversationUrl(currentUrl: string, configuredUrl: string): boolean {
  let expected: string;
  let current: URL;
  try {
    expected = validateDeepSeekChatUrl(configuredUrl);
    current = new URL(currentUrl);
  } catch {
    return false;
  }
  return (
    current.protocol === "https:" &&
    current.hostname === "chat.deepseek.com" &&
    current.origin === "https://chat.deepseek.com" &&
    current.pathname.replace(/\/$/, "") === new URL(expected).pathname
  );
}

export function isDeepSeekNewConversationPage(currentUrl: string): boolean {
  try {
    const url = new URL(currentUrl);
    return (
      url.protocol === "https:" &&
      url.hostname === "chat.deepseek.com" &&
      url.origin === "https://chat.deepseek.com" &&
      NEW_CHAT_PATH.test(url.pathname)
    );
  } catch {
    return false;
  }
}

export type ConversationTabPlan<T> = { action: "open" } | { action: "reuse" | "navigate"; tab: T };

export function planConversationTab<T extends { url?: string; active?: boolean }>(
  tabs: T[],
  configuredUrl: string,
): ConversationTabPlan<T> {
  const intended = tabs.find((tab) => tab.url && isDeepSeekConversationUrl(tab.url, configuredUrl));
  if (intended) return { action: "reuse", tab: intended };
  const reusable = tabs.find((tab) => tab.active) ?? tabs[0];
  return reusable ? { action: "navigate", tab: reusable } : { action: "open" };
}

export function isConfiguredChatReady(
  paired: boolean,
  page: { available?: boolean; intendedChat?: boolean } | undefined,
): boolean {
  return paired && page?.available === true && page.intendedChat === true;
}

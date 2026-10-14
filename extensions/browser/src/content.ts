import { cancelDeepSeekPrompt, deepSeekNewConversationStatus, deepSeekPageStatus, runDeepSeekPrompt } from "./adapter";

type PromptMessage = {
  type: "run-prompt";
  prompt: string;
  chatUrl: string;
  timeoutMs?: number;
  newConversation?: boolean;
};

chrome.runtime.onMessage.addListener((message: PromptMessage, _sender, sendResponse) => {
  if ((message as { type?: string })?.type === "check-page") {
    const chatUrl = (message as { chatUrl?: unknown }).chatUrl;
    sendResponse(typeof chatUrl === "string" ? deepSeekPageStatus(chatUrl) : { available: false, intendedChat: false });
    return false;
  }
  if ((message as { type?: string })?.type === "check-new-conversation") {
    sendResponse(deepSeekNewConversationStatus());
    return false;
  }
  if ((message as { type?: string })?.type === "cancel-prompt") {
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
      void chrome.runtime.sendMessage({ type: "thinking-state", activity }).catch(() => undefined);
    },
    message.newConversation === true,
  ).then(sendResponse);
  return true;
});

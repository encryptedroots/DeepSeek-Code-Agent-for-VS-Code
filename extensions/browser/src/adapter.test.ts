import { describe, expect, it } from "vitest";
import { detectDeepSeekActivity, isDeepSeekHost, selectLatestFinalAnswer, shouldCommitFinalAnswer } from "./adapter";
import {
  isConfiguredChatReady,
  isDeepSeekConversationUrl,
  isDeepSeekNewConversationPage,
  planConversationTab,
  validateDeepSeekChatUrl,
} from "./chatUrl";
import { waitForReadiness, waitForReadinessWithReload } from "./readiness";

const CHAT_URL = "https://chat.deepseek.com/a/chat/s/7a1408e3-2201-4f72-83f4-d17be27ff05c";

describe("DeepSeek adapter", () => {
  it("accepts only the official DeepSeek chat host", () => {
    expect(isDeepSeekHost("chat.deepseek.com")).toBe(true);
    expect(isDeepSeekHost("deepseek.com")).toBe(false);
    expect(isDeepSeekHost("evil-chat.deepseek.com")).toBe(false);
  });

  it("selects only the final answer and never surfaces DeepSeek thinking text", () => {
    expect(
      selectLatestFinalAnswer([
        { text: "older answer", isThinking: false },
        { text: "private reasoning", isThinking: true },
        { text: "final answer", isThinking: false },
      ]),
    ).toBe("final answer");
    expect(selectLatestFinalAnswer([{ text: "private reasoning", isThinking: true }])).toBe("");
  });

  it("commits only non-empty final text after generation has stopped and remained stable", () => {
    expect(shouldCommitFinalAnswer("", true, false, 10_000)).toBe(false);
    expect(shouldCommitFinalAnswer("answer", false, false, 10_000)).toBe(false);
    expect(shouldCommitFinalAnswer("answer", true, true, 10_000)).toBe(false);
    expect(shouldCommitFinalAnswer("answer", true, false, 3_499)).toBe(false);
    expect(shouldCommitFinalAnswer("answer", true, false, 3_500)).toBe(true);
  });

  it("reports DeepSeek activity without forwarding its thinking text", () => {
    expect(detectDeepSeekActivity(false, false)).toBeUndefined();
    expect(detectDeepSeekActivity(true, false)).toBe("thinking");
    expect(detectDeepSeekActivity(false, true)).toBe("answering");
  });

  it("accepts only official HTTPS conversation URLs with a chat ID", () => {
    expect(validateDeepSeekChatUrl(CHAT_URL)).toBe(CHAT_URL);
    for (const url of [
      "http://chat.deepseek.com/a/chat/s/7a1408e3-2201-4f72-83f4-d17be27ff05c",
      "https://deepseek.com/a/chat/s/7a1408e3-2201-4f72-83f4-d17be27ff05c",
      "https://chat.deepseek.com/a/chat/s/not-a-chat-id",
      "https://user@chat.deepseek.com/a/chat/s/7a1408e3-2201-4f72-83f4-d17be27ff05c",
      "https://chat.deepseek.com/a/chat/s/7a1408e3-2201-4f72-83f4-d17be27ff05c?redirect=other",
    ]) {
      expect(() => validateDeepSeekChatUrl(url)).toThrow(/conversation URL/);
    }
  });

  it("confirms the current page is the configured conversation", () => {
    expect(isDeepSeekConversationUrl(CHAT_URL, CHAT_URL)).toBe(true);
    expect(
      isDeepSeekConversationUrl("https://chat.deepseek.com/a/chat/s/11111111-2222-3333-4444-555555555555", CHAT_URL),
    ).toBe(false);
    expect(
      isDeepSeekConversationUrl("https://evil.example/a/chat/s/7a1408e3-2201-4f72-83f4-d17be27ff05c", CHAT_URL),
    ).toBe(false);
  });

  it("recognizes only official new-chat and conversation pages", () => {
    expect(isDeepSeekNewConversationPage("https://chat.deepseek.com/")).toBe(true);
    expect(isDeepSeekNewConversationPage(CHAT_URL)).toBe(true);
    expect(isDeepSeekNewConversationPage("https://chat.deepseek.com/login")).toBe(false);
    expect(isDeepSeekNewConversationPage("https://example.com/")).toBe(false);
  });

  it("reuses the intended tab, then an active DeepSeek tab, before opening another", () => {
    const intended = { id: 1, url: CHAT_URL };
    const active = { id: 2, url: "https://chat.deepseek.com/", active: true };
    expect(planConversationTab([active, intended], CHAT_URL)).toEqual({ action: "reuse", tab: intended });
    expect(planConversationTab([active], CHAT_URL)).toEqual({ action: "navigate", tab: active });
    expect(planConversationTab([], CHAT_URL)).toEqual({ action: "open" });
  });

  it("does not equate bridge pairing with a ready matching chat page", () => {
    expect(isConfiguredChatReady(true, undefined)).toBe(false);
    expect(isConfiguredChatReady(true, { available: true, intendedChat: false })).toBe(false);
    expect(isConfiguredChatReady(false, { available: true, intendedChat: true })).toBe(false);
    expect(isConfiguredChatReady(true, { available: true, intendedChat: true })).toBe(true);
  });

  it("waits through missing inputs and fails clearly when readiness times out", async () => {
    let attempts = 0;
    await expect(
      waitForReadiness(
        async () => {
          attempts += 1;
          return attempts < 2 ? { available: false, intendedChat: true } : { available: true, intendedChat: true };
        },
        (page) => page.available && page.intendedChat,
        100,
        1,
      ),
    ).resolves.toMatchObject({ available: true });
    await expect(
      waitForReadiness(
        async () => ({ available: false, intendedChat: true }),
        (page) => page.available === true,
        5,
        1,
      ),
    ).rejects.toThrow(/Timed out waiting/);
    await expect(
      waitForReadiness(
        async () => undefined,
        () => false,
        100,
        1,
        () => false,
      ),
    ).rejects.toThrow(/cancelled/);
  });

  it("automatically reloads once after readiness times out and then waits for the chat input", async () => {
    let reloaded = false;
    const result = await waitForReadinessWithReload(
      async () => (reloaded ? { available: true } : undefined),
      (page) => page.available,
      async () => {
        reloaded = true;
      },
      0,
      100,
      1,
    );
    expect(result.available).toBe(true);
    expect(reloaded).toBe(true);
  });

  it("does not reload the page when the request has been cancelled", async () => {
    let reloaded = false;
    await expect(
      waitForReadinessWithReload(
        async () => undefined,
        () => false,
        async () => {
          reloaded = true;
        },
        0,
        100,
        1,
        () => false,
      ),
    ).rejects.toThrow(/cancelled/);
    expect(reloaded).toBe(false);
  });
});

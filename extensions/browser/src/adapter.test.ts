import { describe, expect, it } from "vitest";
import { isDeepSeekHost, selectLatestFinalAnswer, shouldCommitFinalAnswer } from "./adapter";
import {
  DEFAULT_CHAT_URL,
  isConfiguredChatReady,
  isDeepSeekConversationUrl,
  persistDeepSeekChatUrl,
  planConversationTab,
  validateDeepSeekChatUrl,
} from "./chatUrl";
import { waitForReadiness, waitForReadinessWithReload } from "./readiness";

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

  it("accepts only official HTTPS conversation URLs with a chat ID", () => {
    expect(validateDeepSeekChatUrl(DEFAULT_CHAT_URL)).toBe(DEFAULT_CHAT_URL);
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

  it("persists a validated conversation URL without saving invalid values", async () => {
    const values = new Map<string, string>();
    const storage = {
      async get(keys: string | string[]) {
        const result: Record<string, unknown> = {};
        for (const key of typeof keys === "string" ? [keys] : keys) {
          const value = values.get(key);
          if (value !== undefined) result[key] = value;
        }
        return result;
      },
      async set(items: Record<string, string>) {
        for (const [key, value] of Object.entries(items)) values.set(key, value);
      },
    };
    await expect(persistDeepSeekChatUrl(DEFAULT_CHAT_URL, storage)).resolves.toBe(DEFAULT_CHAT_URL);
    expect(values.get("chatUrl")).toBe(DEFAULT_CHAT_URL);
    await expect(
      persistDeepSeekChatUrl("https://chat.deepseek.com/a/chat/s/11111111-2222-3333-4444-555555555555", storage),
    ).resolves.toBe("https://chat.deepseek.com/a/chat/s/11111111-2222-3333-4444-555555555555");
    expect(values.get("chatUrl")).toBe("https://chat.deepseek.com/a/chat/s/11111111-2222-3333-4444-555555555555");
    await expect(persistDeepSeekChatUrl("http://evil.example", storage)).rejects.toThrow(/conversation URL/);
    expect(values.get("chatUrl")).toBe("https://chat.deepseek.com/a/chat/s/11111111-2222-3333-4444-555555555555");
  });

  it("reports a storage write that did not actually persist", async () => {
    let writes = 0;
    const storage = {
      async get() {
        return {
          chatUrl: "https://chat.deepseek.com/a/chat/s/11111111-2222-3333-4444-555555555555",
        };
      },
      async set() {
        writes += 1;
      },
    };
    await expect(persistDeepSeekChatUrl(DEFAULT_CHAT_URL, storage)).rejects.toThrow(/could not verify/);
    expect(writes).toBe(1);
  });

  it("confirms the current page is the configured conversation", () => {
    expect(isDeepSeekConversationUrl(DEFAULT_CHAT_URL, DEFAULT_CHAT_URL)).toBe(true);
    expect(
      isDeepSeekConversationUrl(
        "https://chat.deepseek.com/a/chat/s/11111111-2222-3333-4444-555555555555",
        DEFAULT_CHAT_URL,
      ),
    ).toBe(false);
    expect(
      isDeepSeekConversationUrl("https://evil.example/a/chat/s/7a1408e3-2201-4f72-83f4-d17be27ff05c", DEFAULT_CHAT_URL),
    ).toBe(false);
  });

  it("reuses the intended tab, then an active DeepSeek tab, before opening another", () => {
    const intended = { id: 1, url: DEFAULT_CHAT_URL };
    const active = { id: 2, url: "https://chat.deepseek.com/", active: true };
    expect(planConversationTab([active, intended], DEFAULT_CHAT_URL)).toEqual({ action: "reuse", tab: intended });
    expect(planConversationTab([active], DEFAULT_CHAT_URL)).toEqual({ action: "navigate", tab: active });
    expect(planConversationTab([], DEFAULT_CHAT_URL)).toEqual({ action: "open" });
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

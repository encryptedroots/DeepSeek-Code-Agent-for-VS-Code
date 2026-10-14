import { afterEach, describe, expect, it } from "vitest";
import { BridgeServer } from "./bridgeServer";

let bridge: BridgeServer | undefined;

afterEach(async () => {
  await bridge?.stop();
  bridge = undefined;
});

function authHeaders(token: string): Record<string, string> {
  return { Authorization: "Bea" + "rer " + token, "Content-Type": "application/json" };
}

async function pair(
  chatUrl?: string,
  onConversationUrl?: (url: string) => Promise<void>,
  getChatUrl?: () => string,
): Promise<{ baseUrl: string; token: string }> {
  bridge = new BridgeServer(0, getChatUrl ?? (chatUrl ? () => chatUrl : undefined), undefined, onConversationUrl);
  await bridge.start();
  const response = await fetch(`${bridge.address}/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "chrome-extension://test-extension" },
    body: JSON.stringify({ code: bridge.code }),
  });
  expect(response.status).toBe(200);
  const result = (await response.json()) as { token: string };
  return { baseUrl: bridge.address, token: result.token };
}

describe("loopback browser bridge integration", () => {
  it("pairs once, streams correlated progress, and returns only the matching response", async () => {
    const { baseUrl, token } = await pair();
    expect((await fetch(`${baseUrl}/next`)).status).toBe(401);

    const progress: string[] = [];
    const task = bridge!.request("test prompt", 10_000, new AbortController().signal, (text) => progress.push(text));
    const jobResponse = await fetch(`${baseUrl}/next`, { headers: authHeaders(token) });
    expect(jobResponse.status).toBe(200);
    const job = (await jobResponse.json()) as { id: string; prompt: string; chatUrl: string };
    expect(job.prompt).toBe("test prompt");
    expect(job.chatUrl).toBe("https://chat.deepseek.com/a/chat/s/7a1408e3-2201-4f72-83f4-d17be27ff05c");

    expect(
      (
        await fetch(`${baseUrl}/progress`, {
          method: "POST",
          headers: authHeaders(token),
          body: JSON.stringify({ id: job.id, text: '{"version":' }),
        })
      ).status,
    ).toBe(200);
    expect(progress).toEqual(['{"version":']);

    const completion = { id: job.id, response: "complete response" };
    expect(
      (
        await fetch(`${baseUrl}/complete`, {
          method: "POST",
          headers: authHeaders(token),
          body: JSON.stringify(completion),
        })
      ).status,
    ).toBe(200);
    await expect(task).resolves.toBe("complete response");
    expect(
      (
        await fetch(`${baseUrl}/complete`, {
          method: "POST",
          headers: authHeaders(token),
          body: JSON.stringify(completion),
        })
      ).status,
    ).toBe(404);
  });

  it("removes queued requests when cancelled before the browser receives them", async () => {
    const { baseUrl, token } = await pair();
    const abort = new AbortController();
    const task = bridge!.request("cancel me", 1_000, abort.signal);
    abort.abort();
    await expect(task).rejects.toThrow(/cancelled/);
    const response = await fetch(`${baseUrl}/next`, { headers: authHeaders(token) });
    expect(response.status).toBe(204);
  });

  it("uses the configured VS Code conversation URL in each browser job", async () => {
    const chatUrl = "https://chat.deepseek.com/a/chat/s/11111111-2222-3333-4444-555555555555";
    const { baseUrl, token } = await pair(chatUrl);
    const task = bridge!.request("custom conversation", 1_000, new AbortController().signal);
    const response = await fetch(`${baseUrl}/next`, { headers: authHeaders(token) });
    const job = (await response.json()) as { id: string; chatUrl: string };
    expect(job.chatUrl).toBe(chatUrl);
    await fetch(`${baseUrl}/complete`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ id: job.id, response: "done" }),
    });
    await expect(task).resolves.toBe("done");
  });

  it("opens a new DeepSeek chat and persists its URL from the first response", async () => {
    let configuredUrl = "https://chat.deepseek.com/a/chat/s/7a1408e3-2201-4f72-83f4-d17be27ff05c";
    const savedUrls: string[] = [];
    const { baseUrl, token } = await pair(
      undefined,
      async (url) => {
        configuredUrl = url;
        savedUrls.push(url);
      },
      () => configuredUrl,
    );

    const opening = bridge!.startNewConversation();
    const openRequest = (await (await fetch(`${baseUrl}/next`, { headers: authHeaders(token) })).json()) as {
      type: string;
      id: string;
    };
    expect(openRequest.type).toBe("new-conversation");
    expect(
      (
        await fetch(`${baseUrl}/new-conversation/complete`, {
          method: "POST",
          headers: authHeaders(token),
          body: JSON.stringify({ id: openRequest.id, ok: true }),
        })
      ).status,
    ).toBe(200);
    await expect(opening).resolves.toBeUndefined();

    const task = bridge!.request("use the new chat", 1_000, new AbortController().signal);
    const jobResponse = await fetch(`${baseUrl}/next`, { headers: authHeaders(token) });
    const job = (await jobResponse.json()) as { id: string; newConversation: boolean };
    expect(job.newConversation).toBe(true);
    const conversationUrl = "https://chat.deepseek.com/a/chat/s/11111111-2222-3333-4444-555555555555";
    expect(
      (
        await fetch(`${baseUrl}/complete`, {
          method: "POST",
          headers: authHeaders(token),
          body: JSON.stringify({ id: job.id, response: "done", conversationUrl }),
        })
      ).status,
    ).toBe(200);
    await expect(task).resolves.toBe("done");
    expect(configuredUrl).toBe(conversationUrl);
    expect(savedUrls).toEqual([conversationUrl]);

    const followingTask = bridge!.request("use saved conversation", 1_000, new AbortController().signal);
    const followingJob = (await (await fetch(`${baseUrl}/next`, { headers: authHeaders(token) })).json()) as {
      id: string;
      newConversation?: boolean;
      chatUrl: string;
    };
    expect(followingJob.newConversation).toBe(false);
    expect(followingJob.chatUrl).toBe(conversationUrl);
    await fetch(`${baseUrl}/complete`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ id: followingJob.id, response: "done" }),
    });
    await expect(followingTask).resolves.toBe("done");
  });

  it("rejects an invalid configured conversation URL before enqueueing work", async () => {
    const { baseUrl, token } = await pair("http://example.com");
    await expect(bridge!.request("bad config", 1_000, new AbortController().signal)).rejects.toThrow(
      /HTTPS conversation URL/,
    );
    const response = await fetch(`${baseUrl}/next`, { headers: authHeaders(token) });
    expect(response.status).toBe(204);
  });

  it("restores a previously paired token for secure auto-connect", async () => {
    const token = "a".repeat(64);
    bridge = new BridgeServer(0, undefined, token);
    await bridge.start();
    expect(bridge.isPaired).toBe(true);
    expect(bridge.code).toBe("");
    const response = await fetch(`${bridge.address}/next`, { headers: authHeaders(token) });
    expect(response.status).toBe(204);
  });
});

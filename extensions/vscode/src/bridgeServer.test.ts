import { afterEach, describe, expect, it } from "vitest";
import { BridgeServer } from "./bridgeServer";

let bridge: BridgeServer | undefined;
const EXTENSION_ORIGIN = `chrome-extension://${"a".repeat(32)}`;
const TEST_CHAT_URL = "https://chat.deepseek.com/a/chat/s/7a1408e3-2201-4f72-83f4-d17be27ff05c";

afterEach(async () => {
  await bridge?.stop();
  bridge = undefined;
});

function authHeaders(token: string): Record<string, string> {
  return { Authorization: "Bea" + "rer " + token, "Content-Type": "application/json" };
}

async function pair(
  chatUrl = TEST_CHAT_URL,
  onConversationUrl?: (url: string) => Promise<void>,
  getChatUrl?: () => string,
  getAutoConnect?: () => boolean,
): Promise<{ baseUrl: string; token: string }> {
  bridge = new BridgeServer(
    0,
    getChatUrl ?? (chatUrl ? () => chatUrl : undefined),
    undefined,
    onConversationUrl,
    getAutoConnect,
  );
  await bridge.start();
  const response = await fetch(`${bridge.address}/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: EXTENSION_ORIGIN },
    body: JSON.stringify({ code: bridge.code }),
  });
  expect(response.status).toBe(200);
  const result = (await response.json()) as { token: string };
  return { baseUrl: bridge.address, token: result.token };
}

describe("loopback browser bridge integration", () => {
  it("requires the one-time code for initial pairing and limits automatic reconnect to that extension", async () => {
    bridge = new BridgeServer(0, undefined, undefined, undefined, () => true);
    await bridge.start();
    const origin = EXTENSION_ORIGIN;
    const initialAutoPair = await fetch(`${bridge.address}/auto-pair`, {
      method: "POST",
      headers: { Origin: origin },
    });
    expect(initialAutoPair.status).toBe(403);
    expect(bridge.isPaired).toBe(false);

    const manualPair = await fetch(`${bridge.address}/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ code: bridge.code }),
    });
    expect(manualPair.status).toBe(200);
    const result = (await manualPair.json()) as { token: string };
    const reconnect = await fetch(`${bridge.address}/auto-pair`, {
      method: "POST",
      headers: { Origin: origin },
    });
    expect(reconnect.status).toBe(200);
    expect((await reconnect.json()) as { token: string }).toEqual(result);
    expect(bridge.isPaired).toBe(true);
    expect(bridge.reconnectOrigin).toBe(origin);
  });

  it("waits for initial code pairing before sending a task", async () => {
    bridge = new BridgeServer(
      0,
      () => TEST_CHAT_URL,
      undefined,
      undefined,
      () => true,
    );
    await bridge.start();
    const controller = new AbortController();
    const task = bridge.request("send after auto-pair", 1_000, controller.signal);
    const response = await fetch(`${bridge.address}/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: EXTENSION_ORIGIN },
      body: JSON.stringify({ code: bridge.code }),
    });
    expect(response.status).toBe(200);
    const { token } = (await response.json()) as { token: string };
    const next = await fetch(`${bridge.address}/next`, { headers: authHeaders(token) });
    const job = (await next.json()) as { id: string; prompt: string };
    expect(job.prompt).toBe("send after auto-pair");
    await fetch(`${bridge.address}/complete`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ id: job.id, response: "paired and complete" }),
    });
    await expect(task).resolves.toBe("paired and complete");
  });

  it("waits for initial code pairing before opening a new conversation", async () => {
    bridge = new BridgeServer(0, undefined, undefined, undefined, () => true);
    await bridge.start();
    const opening = bridge.startNewConversation();
    const paired = await fetch(`${bridge.address}/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: EXTENSION_ORIGIN },
      body: JSON.stringify({ code: bridge.code }),
    });
    expect(paired.status).toBe(200);
    const { token } = (await paired.json()) as { token: string };
    const request = (await (await fetch(`${bridge.address}/next`, { headers: authHeaders(token) })).json()) as {
      id: string;
      type: string;
    };
    expect(request.type).toBe("new-conversation");
    await fetch(`${bridge.address}/new-conversation/complete`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ id: request.id, ok: true }),
    });
    await expect(opening).resolves.toBeUndefined();
  });

  it("refuses automatic pairing when Auto connect is disabled or the origin is not an extension", async () => {
    bridge = new BridgeServer(0, undefined, undefined, undefined, () => false);
    await bridge.start();
    const disabled = await fetch(`${bridge.address}/auto-pair`, {
      method: "POST",
      headers: { Origin: EXTENSION_ORIGIN },
    });
    expect(disabled.status).toBe(403);

    const invalidOrigin = await fetch(`${bridge.address}/auto-pair`, {
      method: "POST",
      headers: { Origin: "https://example.com" },
    });
    expect(invalidOrigin.status).toBe(403);
    expect(bridge.isPaired).toBe(false);
  });

  it("pairs once, streams correlated progress, and returns only the matching response", async () => {
    const { baseUrl, token } = await pair();
    expect((await fetch(`${baseUrl}/next`)).status).toBe(401);

    const progress: string[] = [];
    const task = bridge!.request("test prompt", 10_000, new AbortController().signal, (text) => progress.push(text));
    const jobResponse = await fetch(`${baseUrl}/next`, { headers: authHeaders(token) });
    expect(jobResponse.status).toBe(200);
    const job = (await jobResponse.json()) as { id: string; prompt: string; chatUrl: string };
    expect(job.prompt).toBe("test prompt");
    expect(job.chatUrl).toBe(TEST_CHAT_URL);

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

  it("does not silently select a default DeepSeek conversation", async () => {
    bridge = new BridgeServer(0, undefined, "f".repeat(64));
    await bridge.start();
    await expect(bridge.request("new task", 1_000, new AbortController().signal)).rejects.toThrow(
      /Enter a valid DeepSeek conversation URL/,
    );
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

  it("restores a saved pairing when Auto connect is enabled after a manual-mode restart", async () => {
    const token = "d".repeat(64);
    bridge = new BridgeServer(0, undefined, undefined, undefined, () => true);
    await bridge.start();
    expect(bridge.isPaired).toBe(false);

    bridge.restorePairing(token, EXTENSION_ORIGIN);
    expect(bridge.isPaired).toBe(true);
    expect(bridge.reconnectToken).toBe(token);
    expect(bridge.reconnectOrigin).toBe(EXTENSION_ORIGIN);

    const response = await fetch(`${bridge.address}/auto-pair`, {
      method: "POST",
      headers: { Origin: EXTENSION_ORIGIN },
    });
    expect(response.status).toBe(200);
    expect((await response.json()) as { token: string }).toEqual({ token });
  });

  it("rejects invalid saved browser pairing credentials", async () => {
    bridge = new BridgeServer(0);
    await bridge.start();
    expect(() => bridge!.restorePairing("invalid", EXTENSION_ORIGIN)).toThrow(/credentials are invalid/i);
    expect(() => bridge!.restorePairing("e".repeat(64), "https://example.com")).toThrow(/credentials are invalid/i);
    expect(bridge.isPaired).toBe(false);
  });

  it("only returns an existing automatic pairing to the same browser extension", async () => {
    const token = "b".repeat(64);
    bridge = new BridgeServer(0, undefined, token, undefined, () => true, EXTENSION_ORIGIN);
    await bridge.start();
    const response = await fetch(`${bridge.address}/auto-pair`, {
      method: "POST",
      headers: { Origin: EXTENSION_ORIGIN },
    });
    expect(response.status).toBe(200);
    expect((await response.json()) as { token: string }).toEqual({ token });
    const denied = await fetch(`${bridge.address}/auto-pair`, {
      method: "POST",
      headers: { Origin: `chrome-extension://${"b".repeat(32)}` },
    });
    expect(denied.status).toBe(403);
    expect((await denied.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining("already paired"),
    });
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("restores an automatic pairing after the bridge restarts for the same browser extension", async () => {
    const token = "c".repeat(64);
    bridge = new BridgeServer(0, undefined, token, undefined, () => true, EXTENSION_ORIGIN);
    await bridge.start();
    const response = await fetch(`${bridge.address}/auto-pair`, {
      method: "POST",
      headers: { Origin: EXTENSION_ORIGIN },
    });
    expect(response.status).toBe(200);
    expect((await response.json()) as { token: string }).toEqual({ token });
    const next = await fetch(`${bridge.address}/next`, { headers: authHeaders(token) });
    expect(next.status).toBe(204);
  });
});

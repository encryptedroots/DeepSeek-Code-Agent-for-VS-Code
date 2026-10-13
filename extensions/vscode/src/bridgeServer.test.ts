import { afterEach, describe, expect, it } from "vitest";
import { BridgeServer } from "./bridgeServer";

let bridge: BridgeServer | undefined;

afterEach(async () => {
  await bridge?.stop();
  bridge = undefined;
});

async function pair(): Promise<{ baseUrl: string; token: string }> {
  bridge = new BridgeServer(0);
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
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    expect((await fetch(`${baseUrl}/next`)).status).toBe(401);

    const progress: string[] = [];
    const task = bridge!.request("test prompt", 10_000, new AbortController().signal, (text) => progress.push(text));
    const jobResponse = await fetch(`${baseUrl}/next`, { headers });
    expect(jobResponse.status).toBe(200);
    const job = (await jobResponse.json()) as { id: string; prompt: string };
    expect(job.prompt).toBe("test prompt");

    expect(
      (
        await fetch(`${baseUrl}/progress`, {
          method: "POST",
          headers,
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
          headers,
          body: JSON.stringify(completion),
        })
      ).status,
    ).toBe(200);
    await expect(task).resolves.toBe("complete response");
    expect(
      (
        await fetch(`${baseUrl}/complete`, {
          method: "POST",
          headers,
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
    const response = await fetch(`${baseUrl}/next`, { headers: { Authorization: `Bearer ${token}` } });
    expect(response.status).toBe(204);
  });
});

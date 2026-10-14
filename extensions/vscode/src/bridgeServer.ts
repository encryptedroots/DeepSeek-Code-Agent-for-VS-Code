import { randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  bridgeActivitySchema,
  bridgeProgressSchema,
  bridgeResultSchema,
  bridgeJobSchema,
  DEFAULT_DEEPSEEK_CHAT_URL,
  validateDeepSeekChatUrl,
} from "@deepseek-agent/protocol";

interface PendingRequest {
  resolve: (response: string) => void;
  reject: (error: Error) => void;
}

interface PendingNewConversation {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class BridgeServer {
  private server: Server | undefined;
  private readonly token: string;
  private pairingCode: string;
  private pairingAttempts = 0;
  private paired: boolean;
  private lastBrowserPoll = 0;
  private readonly pairListeners = new Set<(token: string) => void>();
  private readonly queue: Array<{
    id: string;
    prompt: string;
    responseLimit: number;
    chatUrl: string;
    newConversation?: boolean;
  }> = [];
  private readonly newConversationQueue: string[] = [];
  private readonly pendingNewConversations = new Map<string, PendingNewConversation>();
  private newConversationForNextTask = false;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly progress = new Map<
    string,
    { onProgress: (partial: string) => void; limit: number; lastText: string }
  >();
  private readonly activities = new Map<string, (activity: "thinking" | "answering") => void>();
  private readonly cancelled = new Set<string>();

  constructor(
    private readonly port: number,
    private readonly getChatUrl: () => string = () => DEFAULT_DEEPSEEK_CHAT_URL,
    pairedToken?: string,
    private readonly onConversationUrl?: (url: string) => Promise<void>,
  ) {
    this.token = pairedToken ?? randomBytes(32).toString("hex");
    this.paired = pairedToken !== undefined;
    this.pairingCode = pairedToken === undefined ? String(randomInt(10_000_000, 100_000_000)) : "";
  }

  get code(): string {
    return this.pairingCode;
  }

  get address(): string {
    const address = this.server?.address();
    if (!address || typeof address === "string") throw new Error("Bridge server is not listening on a TCP port.");
    return `http://127.0.0.1:${address.port}`;
  }

  get isPaired(): boolean {
    return this.paired;
  }

  get reconnectToken(): string | undefined {
    return this.paired ? this.token : undefined;
  }

  get browserActive(): boolean {
    return this.paired && Date.now() - this.lastBrowserPoll < 90_000;
  }

  onDidPair(listener: (token: string) => void): { dispose: () => void } {
    this.pairListeners.add(listener);
    return { dispose: () => this.pairListeners.delete(listener) };
  }

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch((error: unknown) => {
        console.error(
          "[DeepSeek Code Agent] Bridge request failed:",
          error instanceof Error ? error.name : "unknown error",
        );
        if (!response.writableEnded)
          this.send(response, 500, { error: "Bridge request failed. Check the VS Code extension logs." });
      });
    });
    this.server.on("error", (error) => {
      console.error("[DeepSeek Code Agent] Bridge server error:", error.name);
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.port, "127.0.0.1", () => {
        this.server!.removeListener("error", reject);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    for (const request of this.pending.values()) request.reject(new Error("The browser bridge was stopped."));
    this.pending.clear();
    for (const pending of this.pendingNewConversations.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("The browser bridge was stopped."));
    }
    this.pendingNewConversations.clear();
    this.progress.clear();
    this.activities.clear();
    this.queue.length = 0;
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => this.server!.close((error) => (error ? reject(error) : resolve())));
    this.server = undefined;
  }

  request(
    prompt: string,
    responseLimit: number,
    signal: AbortSignal,
    onProgress?: (partial: string) => void,
    onActivity?: (activity: "thinking" | "answering") => void,
  ): Promise<string> {
    if (Buffer.byteLength(prompt, "utf8") > 400_000)
      return Promise.reject(new Error("Prompt exceeds the 400 KB browser-bridge limit."));
    if (!Number.isInteger(responseLimit) || responseLimit < 1 || responseLimit > 200_000) {
      return Promise.reject(new Error("Configured response size is outside the supported limit."));
    }
    if (!this.paired)
      return Promise.reject(
        new Error(
          "Browser extension is not paired. Open the DeepSeek Code Agent popup and enter the pairing code shown in VS Code.",
        ),
      );
    if (signal.aborted) return Promise.reject(new Error("Task cancelled."));
    let chatUrl: string;
    try {
      chatUrl = validateDeepSeekChatUrl(this.getChatUrl());
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new Error("Configured DeepSeek conversation URL is invalid."),
      );
    }
    const job = bridgeJobSchema.safeParse({
      id: randomUUID(),
      prompt,
      responseLimit,
      chatUrl,
      newConversation: this.newConversationForNextTask,
    });
    if (!job.success) return Promise.reject(new Error("Bridge request did not match the supported protocol."));
    const id = job.data.id;
    return new Promise<string>((resolve, reject) => {
      const timers: { request?: ReturnType<typeof setTimeout> } = {};
      const onAbort = () => {
        clearTimeout(timers.request);
        this.pending.delete(id);
        const queuedIndex = this.queue.findIndex((job) => job.id === id);
        if (queuedIndex >= 0) this.queue.splice(queuedIndex, 1);
        else this.markCancelled(id);
        this.progress.delete(id);
        this.activities.delete(id);
        reject(new Error("Task cancelled."));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      const cleanupResolve = (value: string) => {
        clearTimeout(timers.request);
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const cleanupReject = (error: Error) => {
        clearTimeout(timers.request);
        signal.removeEventListener("abort", onAbort);
        reject(error);
      };
      this.pending.set(id, { resolve: cleanupResolve, reject: cleanupReject });
      if (onProgress) this.progress.set(id, { onProgress, limit: responseLimit, lastText: "" });
      if (onActivity) this.activities.set(id, onActivity);
      timers.request = setTimeout(() => {
        this.pending.delete(id);
        this.progress.delete(id);
        this.activities.delete(id);
        const queuedIndex = this.queue.findIndex((job) => job.id === id);
        if (queuedIndex >= 0) this.queue.splice(queuedIndex, 1);
        else this.markCancelled(id);
        signal.removeEventListener("abort", onAbort);
        cleanupReject(new Error("Timed out waiting for a response from DeepSeek."));
      }, 180_000);
      this.queue.push(job.data);
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("Cache-Control", "no-store");
    const origin = request.headers.origin;
    if (origin && !origin.startsWith("chrome-extension://")) {
      this.send(response, 403, { error: "Browser origin is not allowed." });
      return;
    }
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname === "/pair" && request.method === "POST") {
      const body = await this.readBody(request, response);
      if (body === undefined) return;
      let input: unknown;
      try {
        input = JSON.parse(body);
      } catch {
        this.send(response, 400, { error: "Invalid pairing request." });
        return;
      }
      const code =
        typeof input === "object" && input !== null && "code" in input && typeof input.code === "string"
          ? input.code
          : "";
      this.pairingAttempts += 1;
      if (this.pairingAttempts > 5 || this.paired || code !== this.pairingCode) {
        if (this.pairingAttempts >= 5) this.pairingCode = "";
        this.send(response, 401, { error: "Pairing code is invalid, expired, or already used." });
        return;
      }
      this.paired = true;
      this.pairingCode = "";
      for (const listener of this.pairListeners) listener(this.token);
      this.send(response, 200, { token: this.token });
      return;
    }
    if (pathname === "/health" && request.method === "GET") {
      let chatUrl: string | undefined;
      try {
        chatUrl = validateDeepSeekChatUrl(this.getChatUrl());
      } catch {
        chatUrl = undefined;
      }
      this.send(response, 200, { ok: true, paired: this.paired, browserActive: this.browserActive, chatUrl });
      return;
    }
    if (!this.authorized(request)) {
      this.send(response, 401, { error: "Bridge authentication required." });
      return;
    }
    if (pathname === "/next" && request.method === "GET") {
      this.lastBrowserPoll = Date.now();
      const newConversationId = this.newConversationQueue.shift();
      if (newConversationId) {
        this.send(response, 200, { type: "new-conversation", id: newConversationId });
        return;
      }
      const job = this.queue.shift();
      if (!job) {
        response.writeHead(204);
        response.end();
        return;
      }
      this.send(response, 200, job);
      return;
    }
    if (pathname === "/complete" && request.method === "POST") {
      const body = await this.readBody(request, response);
      if (body === undefined) return;
      let input: unknown;
      try {
        input = JSON.parse(body);
      } catch {
        this.send(response, 400, { error: "Invalid response body." });
        return;
      }
      const parsed = bridgeResultSchema.safeParse(input);
      if (!parsed.success) {
        this.send(response, 400, { error: "Browser returned an invalid result." });
        return;
      }
      const pending = this.pending.get(parsed.data.id);
      if (!pending) {
        this.send(response, 404, { error: "Request expired or was cancelled." });
        return;
      }
      if (parsed.data.conversationUrl) {
        try {
          await this.onConversationUrl?.(parsed.data.conversationUrl);
          this.newConversationForNextTask = false;
        } catch (error) {
          this.pending.delete(parsed.data.id);
          this.progress.delete(parsed.data.id);
          this.activities.delete(parsed.data.id);
          pending.reject(
            new Error(
              `DeepSeek created a new conversation, but VS Code could not save its URL: ${error instanceof Error ? error.message : "settings update failed"}`,
            ),
          );
          this.send(response, 200, { ok: true });
          return;
        }
      }
      this.pending.delete(parsed.data.id);
      this.progress.delete(parsed.data.id);
      this.activities.delete(parsed.data.id);
      if (parsed.data.error) pending.reject(new Error(parsed.data.error));
      else if (parsed.data.response) pending.resolve(parsed.data.response);
      else pending.reject(new Error("Browser returned an empty response."));
      this.send(response, 200, { ok: true });
      return;
    }
    if (pathname === "/new-conversation/complete" && request.method === "POST") {
      const body = await this.readBody(request, response);
      if (body === undefined) return;
      let input: unknown;
      try {
        input = JSON.parse(body);
      } catch {
        this.send(response, 400, { error: "Invalid new-conversation result." });
        return;
      }
      if (
        typeof input !== "object" ||
        input === null ||
        !("id" in input) ||
        typeof input.id !== "string" ||
        !("ok" in input) ||
        typeof input.ok !== "boolean" ||
        ("error" in input && (typeof input.error !== "string" || input.error.length > 2_000))
      ) {
        this.send(response, 400, { error: "Browser returned an invalid new-conversation result." });
        return;
      }
      const pending = this.pendingNewConversations.get(input.id);
      if (!pending) {
        this.send(response, 404, { error: "New-conversation request expired." });
        return;
      }
      this.pendingNewConversations.delete(input.id);
      clearTimeout(pending.timer);
      if (input.ok) {
        this.newConversationForNextTask = true;
        pending.resolve();
      } else {
        const message = "error" in input && typeof input.error === "string" ? input.error : undefined;
        pending.reject(new Error(message || "Could not open a new DeepSeek conversation."));
      }
      this.send(response, 200, { ok: true });
      return;
    }
    if (pathname === "/activity" && request.method === "POST") {
      const body = await this.readBody(request, response);
      if (body === undefined) return;
      let input: unknown;
      try {
        input = JSON.parse(body);
      } catch {
        this.send(response, 400, { error: "Invalid activity body." });
        return;
      }
      const parsed = bridgeActivitySchema.safeParse(input);
      if (!parsed.success) {
        this.send(response, 400, { error: "Browser returned invalid activity." });
        return;
      }
      const onActivity = this.activities.get(parsed.data.id);
      if (!this.pending.has(parsed.data.id) || !onActivity) {
        this.send(response, 404, { error: "Request expired." });
        return;
      }
      onActivity(parsed.data.activity);
      this.send(response, 200, { ok: true });
      return;
    }
    if (pathname === "/progress" && request.method === "POST") {
      const body = await this.readBody(request, response);
      if (body === undefined) return;
      let input: unknown;
      try {
        input = JSON.parse(body);
      } catch {
        this.send(response, 400, { error: "Invalid progress body." });
        return;
      }
      const parsed = bridgeProgressSchema.safeParse(input);
      if (!parsed.success) {
        this.send(response, 400, { error: "Browser returned invalid progress." });
        return;
      }
      const current = this.progress.get(parsed.data.id);
      if (!current || parsed.data.text.length < current.lastText.length || parsed.data.text === current.lastText) {
        this.send(response, current ? 200 : 404, current ? { ok: true } : { error: "Request expired." });
        return;
      }
      if (Buffer.byteLength(parsed.data.text, "utf8") > current.limit) {
        this.send(response, 413, { error: "Response exceeded the configured size limit." });
        return;
      }
      current.lastText = parsed.data.text;
      current.onProgress(parsed.data.text);
      this.send(response, 200, { ok: true });
      return;
    }
    if (pathname === "/cancelled" && request.method === "GET") {
      const id = new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get("id") ?? "";
      const cancelled = this.cancelled.delete(id);
      this.send(response, 200, { cancelled });
      return;
    }
    this.send(response, 404, { error: "Unknown bridge endpoint." });
  }

  startNewConversation(): Promise<void> {
    if (!this.paired)
      return Promise.reject(new Error("Pair the browser extension before opening a new DeepSeek conversation."));
    if (this.newConversationForNextTask || this.pendingNewConversations.size)
      return Promise.reject(new Error("A new DeepSeek conversation is already being prepared."));
    const id = randomUUID();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingNewConversations.delete(id);
        const queuedIndex = this.newConversationQueue.indexOf(id);
        if (queuedIndex >= 0) this.newConversationQueue.splice(queuedIndex, 1);
        reject(new Error("Timed out waiting for the browser to open a new DeepSeek conversation."));
      }, 30_000);
      this.pendingNewConversations.set(id, { resolve, reject, timer });
      this.newConversationQueue.push(id);
    });
  }

  private authorized(request: IncomingMessage): boolean {
    const authorization = request.headers.authorization ?? "";
    if (!authorization.startsWith("Bearer ")) return false;
    const supplied = Buffer.from(authorization.slice(7));
    const expected = Buffer.from(this.token);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected) && this.paired;
  }

  private markCancelled(id: string): void {
    this.cancelled.add(id);
    if (this.cancelled.size > 100) {
      const oldest = this.cancelled.values().next().value;
      if (oldest) this.cancelled.delete(oldest);
    }
  }

  private async readBody(request: IncomingMessage, response: ServerResponse): Promise<string | undefined> {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += buffer.length;
      if (length > 210_000) {
        this.send(response, 413, { error: "Request body is too large." });
        request.resume();
        return undefined;
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  private send(response: ServerResponse, status: number, value: unknown): void {
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(value));
  }
}

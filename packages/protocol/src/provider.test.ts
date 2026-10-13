import { describe, expect, it } from "vitest";
import { requestStructuredPlan, type StructuredResponseProvider } from "./index";

const validResponse = JSON.stringify({
  version: 1,
  plan: "Create a module",
  operations: [{ type: "create", path: "src/module.ts", content: "export {};" }],
  commands: [],
  verification: ["npm test"],
  summary: "Created the module",
});

class MockProvider implements StructuredResponseProvider {
  readonly prompts: string[] = [];
  constructor(private readonly responses: string[]) {}
  async request(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    const response = this.responses.shift();
    if (response === undefined) throw new Error("Mock DeepSeek response queue exhausted.");
    return response;
  }
}

describe("structured DeepSeek provider integration", () => {
  it("validates provider output and requests a full correction for malformed JSON", async () => {
    const provider = new MockProvider(["not json", validResponse]);
    const result = await requestStructuredPlan(
      provider,
      "Create a module",
      "workspace files",
      10_000,
      new AbortController().signal,
    );
    expect(result.summary).toBe("Created the module");
    expect(provider.prompts).toHaveLength(2);
    expect(provider.prompts[1]).toContain("previous answer was rejected");
  });

  it("uses bounded correction attempts and rejects repeated invalid output without returning a partial plan", async () => {
    const provider = new MockProvider(["{", "{", "{", "{"]);
    await expect(
      requestStructuredPlan(provider, "Task", "Context", 10_000, new AbortController().signal),
    ).rejects.toThrow(/after 4 attempts.*Nothing was applied/);
    expect(provider.prompts).toHaveLength(4);
    expect(provider.prompts[1]).toContain("Escape quotes, backslashes, and line breaks");
  });

  it("recovers from malformed JSON after more than one repair and returns only the validated result", async () => {
    const provider = new MockProvider([
      '{"version":1,"plan":"broken quote " here"}',
      "{",
      `Some response text:\n${validResponse}`,
    ]);
    const result = await requestStructuredPlan(provider, "Task", "Context", 10_000, new AbortController().signal);
    expect(result.summary).toBe("Created the module");
    expect(provider.prompts).toHaveLength(3);
  });

  it("redacts secrets from task and context before sending to the provider", async () => {
    const provider = new MockProvider([validResponse]);
    await requestStructuredPlan(
      provider,
      "api_key=secret123",
      "Authorization: Bearer abcdef",
      10_000,
      new AbortController().signal,
    );
    expect(provider.prompts[0]).not.toContain("secret123");
    expect(provider.prompts[0]).not.toContain("abcdef");
  });

  it("keeps correction prompts concise without resending unchanged context", async () => {
    const provider = new MockProvider(["not json", validResponse]);
    await requestStructuredPlan(
      provider,
      "Current task",
      "Large unchanged workspace context",
      10_000,
      new AbortController().signal,
    );
    expect(provider.prompts[0]).toContain("Large unchanged workspace context");
    expect(provider.prompts[1]).toContain("previous answer was rejected");
    expect(provider.prompts[1]).not.toContain("Large unchanged workspace context");
    expect(provider.prompts[1].length).toBeLessThan(provider.prompts[0].length);
  });

  it("omits repeated protocol instructions on follow-up turns", async () => {
    const provider = new MockProvider([validResponse]);
    await requestStructuredPlan(
      provider,
      "Continue the task",
      "Only newly changed context",
      10_000,
      new AbortController().signal,
      undefined,
      { includeProtocol: false },
    );
    expect(provider.prompts[0]).not.toContain("Schema:");
    expect(provider.prompts[0]).toContain("Only newly changed context");
  });

  it("supports one focused clarification without adding editing operations", async () => {
    const provider = new MockProvider([
      JSON.stringify({
        version: 1,
        plan: "Clarify the target",
        operations: [],
        commands: [],
        verification: [],
        summary: "Need one detail",
        clarification: "Which configuration file should be changed?",
      }),
    ]);
    const result = await requestStructuredPlan(
      provider,
      "Make a configuration change",
      "Relevant files",
      10_000,
      new AbortController().signal,
    );
    expect(result.clarification).toBe("Which configuration file should be changed?");
  });
});

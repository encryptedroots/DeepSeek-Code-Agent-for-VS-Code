"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const index_1 = require("./index");
const validResponse = JSON.stringify({
    version: 1,
    plan: "Create a module",
    operations: [{ type: "create", path: "src/module.ts", content: "export {};" }],
    commands: [],
    verification: ["npm test"],
    summary: "Created the module",
});
class MockProvider {
    responses;
    prompts = [];
    constructor(responses) {
        this.responses = responses;
    }
    async request(prompt) {
        this.prompts.push(prompt);
        const response = this.responses.shift();
        if (response === undefined)
            throw new Error("Mock DeepSeek response queue exhausted.");
        return response;
    }
}
(0, vitest_1.describe)("structured DeepSeek provider integration", () => {
    (0, vitest_1.it)("validates provider output and requests a full correction for malformed JSON", async () => {
        const provider = new MockProvider(["not json", validResponse]);
        const result = await (0, index_1.requestStructuredPlan)(provider, "Create a module", "workspace files", 10_000, new AbortController().signal);
        (0, vitest_1.expect)(result.summary).toBe("Created the module");
        (0, vitest_1.expect)(provider.prompts).toHaveLength(2);
        (0, vitest_1.expect)(provider.prompts[1]).toContain("previous answer was rejected");
    });
    (0, vitest_1.it)("uses bounded correction attempts and rejects repeated invalid output without returning a partial plan", async () => {
        const provider = new MockProvider(["{", "{", "{", "{"]);
        await (0, vitest_1.expect)((0, index_1.requestStructuredPlan)(provider, "Task", "Context", 10_000, new AbortController().signal)).rejects.toThrow(/after 4 attempts.*Nothing was applied/);
        (0, vitest_1.expect)(provider.prompts).toHaveLength(4);
        (0, vitest_1.expect)(provider.prompts[1]).toContain("Escape quotes, backslashes, and line breaks");
    });
    (0, vitest_1.it)("recovers from malformed JSON after more than one repair and returns only the validated result", async () => {
        const provider = new MockProvider([
            '{"version":1,"plan":"broken quote " here"}',
            "{",
            `Some response text:\n${validResponse}`,
        ]);
        const result = await (0, index_1.requestStructuredPlan)(provider, "Task", "Context", 10_000, new AbortController().signal);
        (0, vitest_1.expect)(result.summary).toBe("Created the module");
        (0, vitest_1.expect)(provider.prompts).toHaveLength(3);
    });
    (0, vitest_1.it)("redacts secrets from task and context before sending to the provider", async () => {
        const provider = new MockProvider([validResponse]);
        await (0, index_1.requestStructuredPlan)(provider, "api_key=secret123", "Authorization: Bearer abcdef", 10_000, new AbortController().signal);
        (0, vitest_1.expect)(provider.prompts[0]).not.toContain("secret123");
        (0, vitest_1.expect)(provider.prompts[0]).not.toContain("abcdef");
    });
    (0, vitest_1.it)("keeps correction prompts concise without resending unchanged context", async () => {
        const provider = new MockProvider(["not json", validResponse]);
        await (0, index_1.requestStructuredPlan)(provider, "Current task", "Large unchanged workspace context", 10_000, new AbortController().signal);
        (0, vitest_1.expect)(provider.prompts[0]).toContain("Large unchanged workspace context");
        (0, vitest_1.expect)(provider.prompts[1]).toContain("previous answer was rejected");
        (0, vitest_1.expect)(provider.prompts[1]).not.toContain("Large unchanged workspace context");
        (0, vitest_1.expect)(provider.prompts[1].length).toBeLessThan(provider.prompts[0].length);
    });
    (0, vitest_1.it)("omits repeated protocol instructions on follow-up turns", async () => {
        const provider = new MockProvider([validResponse]);
        await (0, index_1.requestStructuredPlan)(provider, "Continue the task", "Only newly changed context", 10_000, new AbortController().signal, undefined, { includeProtocol: false });
        (0, vitest_1.expect)(provider.prompts[0]).not.toContain("Schema:");
        (0, vitest_1.expect)(provider.prompts[0]).toContain("Only newly changed context");
    });
    (0, vitest_1.it)("supports one focused clarification without adding editing operations", async () => {
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
        const result = await (0, index_1.requestStructuredPlan)(provider, "Make a configuration change", "Relevant files", 10_000, new AbortController().signal);
        (0, vitest_1.expect)(result.clarification).toBe("Which configuration file should be changed?");
    });
});

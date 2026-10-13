"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const index_1 = require("./index");
const valid = {
    version: 1,
    plan: "Update a file",
    operations: [{ type: "create", path: "src/new.ts", content: "export {};" }],
    commands: [],
    verification: ["Run tests"],
    summary: "Created a file",
};
(0, vitest_1.describe)("agent protocol", () => {
    (0, vitest_1.it)("parses a valid JSON response inside a code fence", () => {
        (0, vitest_1.expect)((0, index_1.parseAgentResponse)(`\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``).operations).toHaveLength(1);
    });
    (0, vitest_1.it)("extracts a complete protocol object from surrounding text without changing its contents", () => {
        const response = JSON.stringify({ ...valid, summary: 'Text with "quotes", braces { }, and\nnewlines.' });
        (0, vitest_1.expect)((0, index_1.parseAgentResponse)(`Here is the result:\n${response}\nDone.`).summary).toBe('Text with "quotes", braces { }, and\nnewlines.');
    });
    (0, vitest_1.it)("rejects malformed, truncated, duplicate-path, and traversal responses", () => {
        (0, vitest_1.expect)(() => (0, index_1.parseAgentResponse)("{")).toThrow(/invalid or truncated JSON/);
        (0, vitest_1.expect)(() => (0, index_1.parseAgentResponse)(JSON.stringify({ ...valid, operations: [valid.operations[0], valid.operations[0]] }))).toThrow(/Duplicate/);
        (0, vitest_1.expect)(() => (0, index_1.parseAgentResponse)(JSON.stringify({ ...valid, operations: [{ ...valid.operations[0], path: "../outside" }] }))).toThrow(/relative path/);
    });
});

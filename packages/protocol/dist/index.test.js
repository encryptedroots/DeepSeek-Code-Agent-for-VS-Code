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
        (0, vitest_1.expect)(() => (0, index_1.parseAgentResponse)(JSON.stringify({ ...valid, operations: [{ ...valid.operations[0], path: "./src/new.ts" }] }))).toThrow(/relative path/);
    });
    (0, vitest_1.it)("documents protocol array bounds in the model instructions", () => {
        (0, vitest_1.expect)((0, index_1.protocolInstructions)()).toContain("30 requestedFiles");
        (0, vitest_1.expect)((0, index_1.protocolInstructions)()).toContain("20 searches");
    });
    (0, vitest_1.it)("distinguishes a standalone clarification from one accompanied by a safe context request", () => {
        const clarification = (0, index_1.parseAgentResponse)(JSON.stringify({ ...valid, operations: [], verification: [], clarification: "Which behavior do you mean?" }));
        (0, vitest_1.expect)((0, index_1.isStandaloneClarification)(clarification)).toBe(true);
        const contextRequest = (0, index_1.parseAgentResponse)(JSON.stringify({
            ...valid,
            operations: [],
            verification: [],
            clarification: "I need to inspect the implementation.",
            requestedFiles: ["src/agent.ts"],
        }));
        (0, vitest_1.expect)((0, index_1.isStandaloneClarification)(contextRequest)).toBe(false);
    });
});
(0, vitest_1.describe)("Python response protocol", () => {
    (0, vitest_1.it)("extracts a Python script and an optional plan from a fenced response", () => {
        (0, vitest_1.expect)((0, index_1.parsePythonAgentResponse)(`Update the parser.\n\n\`\`\`fix.py\nprint("done")\n\`\`\``)).toEqual({
            type: "script",
            plan: "Update the parser.",
            script: 'print("done")',
        });
    });
    (0, vitest_1.it)("supports bounded workspace file and search requests", () => {
        (0, vitest_1.expect)((0, index_1.parsePythonAgentResponse)("```files\nsrc/agent.ts\n```")).toEqual({
            type: "context",
            files: ["src/agent.ts"],
            searches: [],
        });
        (0, vitest_1.expect)((0, index_1.parsePythonAgentResponse)("```searches\nAgentController\n```")).toEqual({
            type: "context",
            files: [],
            searches: ["AgentController"],
        });
    });
    (0, vitest_1.it)("rejects unsafe, duplicate, mixed, and empty requests without returning a script", () => {
        (0, vitest_1.expect)(() => (0, index_1.parsePythonAgentResponse)("```files\n../outside.txt\n```")).toThrow();
        (0, vitest_1.expect)(() => (0, index_1.parsePythonAgentResponse)("```files\nsrc/a.ts\nsrc/A.ts\n```")).toThrow(/duplicate/i);
        (0, vitest_1.expect)(() => (0, index_1.parsePythonAgentResponse)("```fix.py\nprint(1)\n```\n```files\nsrc/a.ts\n```")).toThrow(/exactly one/i);
        (0, vitest_1.expect)(() => (0, index_1.parsePythonAgentResponse)("```fix.py\n  \n```")).toThrow(/empty/i);
        (0, vitest_1.expect)(() => (0, index_1.parsePythonAgentResponse)("```fix.py\nprint('truncated')")).toThrow(/incomplete or truncated/i);
        (0, vitest_1.expect)((0, index_1.parsePythonAgentResponse)("I need to see this file first.\n```files\nsrc/a.ts\n```")).toEqual({
            type: "context",
            files: ["src/a.ts"],
            searches: [],
        });
        (0, vitest_1.expect)((0, index_1.parsePythonAgentResponse)("```python\nprint('not executable')\n```")).toEqual({
            type: "message",
            text: "```python\nprint('not executable')\n```",
        });
        (0, vitest_1.expect)((0, index_1.parsePythonAgentResponse)("  Answer as written.\n")).toEqual({
            type: "message",
            text: "  Answer as written.\n",
        });
    });
    (0, vitest_1.it)("treats plain text as a final conversational response and documents explicit approval", () => {
        (0, vitest_1.expect)((0, index_1.parsePythonAgentResponse)("Hello, what would you like to change?")).toEqual({
            type: "message",
            text: "Hello, what would you like to change?",
        });
        (0, vitest_1.expect)((0, index_1.pythonProtocolInstructions)()).toContain("```fix.py");
        (0, vitest_1.expect)((0, index_1.pythonProtocolInstructions)()).toContain("only permitted generated script filename is fix.py");
        (0, vitest_1.expect)((0, index_1.pythonProtocolInstructions)()).toContain("```searches");
        (0, vitest_1.expect)((0, index_1.pythonProtocolInstructions)()).toContain("ask for that file's relevant contents");
    });
});

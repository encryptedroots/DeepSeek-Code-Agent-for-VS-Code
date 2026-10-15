import { describe, expect, it } from "vitest";
import {
  isStandaloneClarification,
  parseAgentResponse,
  parsePythonAgentResponse,
  protocolInstructions,
  pythonProtocolInstructions,
} from "./index";

const valid = {
  version: 1,
  plan: "Update a file",
  operations: [{ type: "create", path: "src/new.ts", content: "export {};" }],
  commands: [],
  verification: ["Run tests"],
  summary: "Created a file",
};

describe("agent protocol", () => {
  it("parses a valid JSON response inside a code fence", () => {
    expect(parseAgentResponse(`\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``).operations).toHaveLength(1);
  });

  it("extracts a complete protocol object from surrounding text without changing its contents", () => {
    const response = JSON.stringify({ ...valid, summary: 'Text with "quotes", braces { }, and\nnewlines.' });
    expect(parseAgentResponse(`Here is the result:\n${response}\nDone.`).summary).toBe(
      'Text with "quotes", braces { }, and\nnewlines.',
    );
  });

  it("rejects malformed, truncated, duplicate-path, and traversal responses", () => {
    expect(() => parseAgentResponse("{")).toThrow(/invalid or truncated JSON/);
    expect(() =>
      parseAgentResponse(JSON.stringify({ ...valid, operations: [valid.operations[0], valid.operations[0]] })),
    ).toThrow(/Duplicate/);
    expect(() =>
      parseAgentResponse(JSON.stringify({ ...valid, operations: [{ ...valid.operations[0], path: "../outside" }] })),
    ).toThrow(/relative path/);
    expect(() =>
      parseAgentResponse(JSON.stringify({ ...valid, operations: [{ ...valid.operations[0], path: "./src/new.ts" }] })),
    ).toThrow(/relative path/);
  });

  it("documents protocol array bounds in the model instructions", () => {
    expect(protocolInstructions()).toContain("30 requestedFiles");
    expect(protocolInstructions()).toContain("20 searches");
  });

  it("distinguishes a standalone clarification from one accompanied by a safe context request", () => {
    const clarification = parseAgentResponse(
      JSON.stringify({ ...valid, operations: [], verification: [], clarification: "Which behavior do you mean?" }),
    );
    expect(isStandaloneClarification(clarification)).toBe(true);

    const contextRequest = parseAgentResponse(
      JSON.stringify({
        ...valid,
        operations: [],
        verification: [],
        clarification: "I need to inspect the implementation.",
        requestedFiles: ["src/agent.ts"],
      }),
    );
    expect(isStandaloneClarification(contextRequest)).toBe(false);
  });
});

describe("Python response protocol", () => {
  it("extracts a Python script and an optional plan from a fenced response", () => {
    expect(parsePythonAgentResponse(`Update the parser.\n\n\`\`\`fix.py\nprint("done")\n\`\`\``)).toEqual({
      type: "script",
      plan: "Update the parser.",
      script: 'print("done")',
    });
  });

  it("supports bounded workspace file and search requests", () => {
    expect(parsePythonAgentResponse("```files\nsrc/agent.ts\n```")).toEqual({
      type: "context",
      files: ["src/agent.ts"],
      searches: [],
    });
    expect(parsePythonAgentResponse("```searches\nAgentController\n```")).toEqual({
      type: "context",
      files: [],
      searches: ["AgentController"],
    });
  });

  it("rejects unsafe, duplicate, mixed, and empty requests without returning a script", () => {
    expect(() => parsePythonAgentResponse("```files\n../outside.txt\n```")).toThrow();
    expect(() => parsePythonAgentResponse("```files\nsrc/a.ts\nsrc/A.ts\n```")).toThrow(/duplicate/i);
    expect(() => parsePythonAgentResponse("```fix.py\nprint(1)\n```\n```files\nsrc/a.ts\n```")).toThrow(/exactly one/i);
    expect(() => parsePythonAgentResponse("```fix.py\n  \n```")).toThrow(/empty/i);
    expect(() => parsePythonAgentResponse("```fix.py\nprint('truncated')")).toThrow(/incomplete or truncated/i);
    expect(parsePythonAgentResponse("I need to see this file first.\n```files\nsrc/a.ts\n```")).toEqual({
      type: "context",
      files: ["src/a.ts"],
      searches: [],
    });
    expect(parsePythonAgentResponse("```python\nprint('not executable')\n```")).toEqual({
      type: "message",
      text: "```python\nprint('not executable')\n```",
    });
    expect(parsePythonAgentResponse("  Answer as written.\n")).toEqual({
      type: "message",
      text: "  Answer as written.\n",
    });
  });

  it("treats plain text as a final conversational response and documents explicit approval", () => {
    expect(parsePythonAgentResponse("Hello, what would you like to change?")).toEqual({
      type: "message",
      text: "Hello, what would you like to change?",
    });
    expect(pythonProtocolInstructions()).toContain("```fix.py");
    expect(pythonProtocolInstructions()).toContain("only permitted generated script filename is fix.py");
    expect(pythonProtocolInstructions()).toContain("```searches");
    expect(pythonProtocolInstructions()).toContain("ask for that file's relevant contents");
  });
});

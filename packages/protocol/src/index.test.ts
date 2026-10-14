import { describe, expect, it } from "vitest";
import { parseAgentResponse, protocolInstructions } from "./index";

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
});

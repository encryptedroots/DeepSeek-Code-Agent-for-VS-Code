import { describe, expect, it } from "vitest";
import {
  composeBoundedTaskContext,
  rankWorkspacePaths,
  relevantExcerpt,
  taskTerms,
  truncateUtf8,
} from "./contextRanking";

describe("task-focused context ranking", () => {
  it("filters generic task words and prioritizes instructions, relevant source, tests, and active files", () => {
    const paths = [
      "src/unrelated.ts",
      "src/urlValidation.test.ts",
      "src/urlValidation.ts",
      "AGENTS.md",
      "src/current.ts",
    ];
    const ranked = rankWorkspacePaths(paths, "validate DeepSeek conversation URL", "src/current.ts");
    expect(ranked.slice(0, 4)).toEqual([
      "AGENTS.md",
      "src/urlValidation.test.ts",
      "src/urlValidation.ts",
      "src/current.ts",
    ]);
    expect(taskTerms("Please make this change")).not.toContain("please");
  });

  it("keeps large files to relevant excerpts and marks them as incomplete", () => {
    const source = Array.from({ length: 120 }, (_, index) =>
      index === 80 ? "function validateConversationUrl() {}" : `unrelated line ${index}`,
    ).join("\n");
    const excerpt = relevantExcerpt(source, "validate conversation url", 500);
    expect(excerpt).toContain("function validateConversationUrl");
    expect(excerpt).toContain("request the complete file before proposing edits");
    expect(excerpt.length).toBeLessThanOrEqual(550);
  });

  it("enforces the context limit in UTF-8 bytes without cutting a character", () => {
    expect(truncateUtf8("a🙂b", 5)).toBe("a🙂");
    expect(Buffer.byteLength(truncateUtf8("a🙂b", 4), "utf8")).toBeLessThanOrEqual(4);
  });

  it("reserves bounded context space for actual verification failures", () => {
    const result = composeBoundedTaskContext("x".repeat(20_000), "Exit: 1\nBuild failed", 1_000);
    expect(result).toContain("Exit: 1");
    expect(result).toContain("Build failed");
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(1_000);
  });
});

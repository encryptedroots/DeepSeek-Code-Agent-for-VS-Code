import { describe, expect, it } from "vitest";
import {
  composeBoundedTaskContext,
  buildOverviewFileBatches,
  buildOverviewInventoryText,
  findMentionedWorkspacePaths,
  getNewContextRequests,
  isOverviewInventoryPath,
  rankWorkspacePaths,
  relevantExcerpt,
  taskTerms,
  truncateUtf8,
} from "./contextRanking";

describe("task-focused context ranking", () => {
  it("prioritizes explicitly mentioned workspace paths and unique filenames", () => {
    const paths = ["agent-smoke-test.txt", "src/other.txt", "src/config.json", "tests/config.json"];
    expect(findMentionedWorkspacePaths(paths, "Read agent-smoke-test.txt and report its contents.")).toEqual([
      "agent-smoke-test.txt",
    ]);
    expect(findMentionedWorkspacePaths(paths, "Read src\\config.json.")).toEqual(["src/config.json"]);
    expect(findMentionedWorkspacePaths(paths, "Read config.json.")).toEqual([]);
  });

  it("finds existing workspace files named in a request to paste their contents", () => {
    const paths = ["agent-smoke-test.txt", "src/config.json", "tests/config.json"];
    expect(
      findMentionedWorkspacePaths(
        paths,
        "I can't access local files, so I can't read agent-smoke-test.txt. Please paste its contents.",
      ),
    ).toEqual(["agent-smoke-test.txt"]);
  });

  it("keeps overview inventories to source/config files and excludes dependency lockfiles", () => {
    expect(isOverviewInventoryPath("src/agent.ts")).toBe(true);
    expect(isOverviewInventoryPath("package.json")).toBe(true);
    expect(isOverviewInventoryPath("package-lock.json")).toBe(false);
    expect(isOverviewInventoryPath("assets/logo.png")).toBe(false);
    expect(isOverviewInventoryPath("node_modules/pkg/index.js")).toBe(false);
    expect(isOverviewInventoryPath("src/.env.local")).toBe(false);
    expect(isOverviewInventoryPath("src/private.key")).toBe(false);
    expect(isOverviewInventoryPath("Dockerfile")).toBe(true);
    expect(isOverviewInventoryPath(".gitignore")).toBe(true);
  });

  it("presents inventory paths in stable alphabetical order for the model to select from", () => {
    const paths = ["services/billing/src/invoice.ts", "README.md", "apps/storefront/src/catalog.ts"];
    const inventory = buildOverviewInventoryText("demo", [...paths].sort(), 1_000);
    expect(inventory.includedPaths).toEqual([...paths].sort());
    expect(inventory.text).toContain("Project/source file inventory");
  });

  it("shows project roots and clearly counts inventory paths omitted by the context limit", () => {
    const result = buildOverviewInventoryText(
      "demo",
      ["README.md", ...Array.from({ length: 40 }, (_, index) => `src/module${index}.ts`)],
      500,
    );
    expect(result.text).toContain("Workspace: demo");
    expect(result.text).toContain("src/ (40 project/source files)");
    expect(result.text).toContain("Project/source file inventory");
    expect(result.omittedCount).toBeGreaterThan(0);
    expect(result.includedPaths.length + result.omittedCount).toBe(41);
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(500);
  });

  it("splits oversized overview files into bounded, UTF-8-safe labeled chunks", () => {
    const content = `const message = "${"🙂".repeat(400)}";\n`;
    const batches = buildOverviewFileBatches([{ path: "extensions/browser/src/background.ts", content }], 512);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.every((batch) => Buffer.byteLength(batch.text, "utf8") <= 512)).toBe(true);
    expect(batches[0].text).toContain("(part 1/");
    expect(batches.at(-1)?.text).toContain(`(part ${batches.length}/${batches.length})`);
    expect(batches.flatMap((batch) => batch.completedPaths)).toEqual(["extensions/browser/src/background.ts"]);
    const reconstructed = batches
      .flatMap((batch) => batch.parts)
      .sort((left, right) => left.part - right.part)
      .map(({ content: chunk }) => chunk)
      .join("");
    expect(reconstructed).toBe(content);
    expect(reconstructed).not.toContain("�");
  });

  it("keeps small file contents together and marks completion in their batch", () => {
    const batches = buildOverviewFileBatches(
      [
        { path: "src/one.ts", content: "export const one = 1;" },
        { path: "src/two.ts", content: "export const two = 2;" },
      ],
      1_000,
    );
    expect(batches).toHaveLength(1);
    expect(batches[0].text).toContain("--- src/one.ts ---");
    expect(batches[0].text).toContain("--- src/two.ts ---");
    expect(batches[0].completedPaths).toEqual(["src/one.ts", "src/two.ts"]);
  });

  it("filters already-requested context so a repeat cannot appear as progress", () => {
    expect(
      getNewContextRequests(
        ["src/agent.ts", "src/new.ts", "src/new.ts"],
        ["bridge pairing", "bridge pairing", "context loop"],
        new Set(["src/agent.ts"]),
        new Set(["bridge pairing"]),
      ),
    ).toEqual({ files: ["src/new.ts"], searches: ["context loop"] });
  });

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

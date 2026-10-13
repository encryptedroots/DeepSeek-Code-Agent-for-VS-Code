import { describe, expect, it } from "vitest";
import { isSafeRelativePath, redactSecrets } from "./safety";

describe("workspace context safety", () => {
  it("rejects absolute, traversal, and non-normalized paths", () => {
    for (const path of [
      "../secret",
      "src/../../outside",
      "C:/Windows",
      "/etc/passwd",
      "src\\file.ts",
      "src//file.ts",
    ]) {
      expect(isSafeRelativePath(path)).toBe(false);
    }
    expect(isSafeRelativePath("src/agent.ts")).toBe(true);
  });

  it("redacts credential assignments, bearer tokens, and private key blocks", () => {
    const content =
      'api_key="secret-value"\nconst password = "p@ss"\nBearer abc.def123\n-----BEGIN PRIVATE KEY-----\nkey-body\n-----END PRIVATE KEY-----';
    const redacted = redactSecrets(content);
    expect(redacted).not.toContain("secret-value");
    expect(redacted).not.toContain("p@ss");
    expect(redacted).not.toContain("abc.def123");
    expect(redacted).not.toContain("key-body");
  });
});

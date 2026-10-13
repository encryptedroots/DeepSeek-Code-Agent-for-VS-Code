import { describe, expect, it } from "vitest";
import { isTrustedCommand, parseSafeCommand } from "./commandSafety";

describe("command safety", () => {
  it("parses an npm verification command without a shell", () => {
    expect(parseSafeCommand("npm run test")).toEqual({ executable: "npm", args: ["run", "test"] });
  });

  it("rejects shell chaining, arbitrary binaries, network and destructive commands", () => {
    for (const command of [
      "npm test & del *",
      "curl https://example.com",
      "format C:",
      "unknown-tool --help",
      "git branch -D main",
      "git diff --output=changes.txt",
      "npm.cmd install package",
      "npx.cmd test",
    ]) {
      expect(() => parseSafeCommand(command)).toThrow();
    }
    expect(parseSafeCommand("npm run format")).toEqual({ executable: "npm", args: ["run", "format"] });
  });

  it("trusts only exact configured commands", () => {
    expect(isTrustedCommand("npm test", ["npm test"])).toBe(true);
    expect(isTrustedCommand("npm test --force", ["npm test"])).toBe(false);
  });
});

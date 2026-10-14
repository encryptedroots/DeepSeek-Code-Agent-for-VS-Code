import { describe, expect, it } from "vitest";
import {
  isTrustedCommand,
  parseSafeCommand,
  shouldAskForCommandApproval,
  shouldAskForFileApproval,
} from "./commandSafety";

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

  it("skips prompts only for exact trusted commands in safe auto mode", () => {
    expect(shouldAskForCommandApproval("npm test", ["npm test"], "safe-auto")).toBe(false);
    expect(shouldAskForCommandApproval("npm test --force", ["npm test"], "safe-auto")).toBe(true);
    expect(shouldAskForCommandApproval("npm test", ["npm test"], "review")).toBe(true);
  });

  it("skips all file and command approval prompts in auto-all mode", () => {
    expect(shouldAskForCommandApproval("npm test", [], "auto-all")).toBe(false);
    expect(shouldAskForFileApproval("auto-all", false)).toBe(false);
    expect(shouldAskForFileApproval("auto-all", true)).toBe(false);
  });

  it("keeps deletions approval-gated in safe auto mode", () => {
    expect(shouldAskForFileApproval("safe-auto", false)).toBe(false);
    expect(shouldAskForFileApproval("safe-auto", true)).toBe(true);
    expect(shouldAskForFileApproval("review", false)).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { buildTaskPrompt } from "./taskPrompt";

describe("task prompt construction", () => {
  it("sends only the current request instead of replaying unrelated conversation history", () => {
    expect(buildTaskPrompt("  Fix the conversation URL validation.  ")).toBe("Fix the conversation URL validation.");
  });
});

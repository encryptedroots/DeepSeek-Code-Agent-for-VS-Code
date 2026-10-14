import { describe, expect, it } from "vitest";
import {
  buildClarificationFollowUpPrompt,
  buildTaskPrompt,
  isClarificationConfirmation,
  isClarificationRejection,
  isWorkspaceOverviewRequest,
} from "./taskPrompt";

describe("task prompt construction", () => {
  it("sends only the current request instead of replaying unrelated conversation history", () => {
    expect(buildTaskPrompt("  Fix the conversation URL validation.  ")).toBe("Fix the conversation URL validation.");
  });

  it("recognizes requests for a project overview or source-file inventory", () => {
    expect(isWorkspaceOverviewRequest("Give me an overview of this project")).toBe(true);
    expect(isWorkspaceOverviewRequest("Show me what files the workspace contains")).toBe(true);
    expect(
      isWorkspaceOverviewRequest("Do not make changes, only scan current files and code and give an overview"),
    ).toBe(true);
    expect(isWorkspaceOverviewRequest("Review the current project without making changes")).toBe(true);
    expect(isWorkspaceOverviewRequest("Audit this repository for quality issues")).toBe(true);
    expect(isWorkspaceOverviewRequest("Review the browser extension implementation")).toBe(true);
    expect(isWorkspaceOverviewRequest("Review the current project but don't fix anything")).toBe(true);
    expect(isWorkspaceOverviewRequest("Audit the repository, do not modify any files")).toBe(true);
    expect(isWorkspaceOverviewRequest("Inspect the codebase and do not update or remove anything")).toBe(true);
    expect(isWorkspaceOverviewRequest("Review this project without making any changes")).toBe(true);
    expect(isWorkspaceOverviewRequest("Review the project, don't fix anything, but add a feature")).toBe(false);
    expect(isWorkspaceOverviewRequest("Audit this codebase and then implement the fix")).toBe(false);
    expect(isWorkspaceOverviewRequest("Review the project and fix the failing tests")).toBe(false);
    expect(isWorkspaceOverviewRequest("Fix the overview panel")).toBe(false);
    expect(isWorkspaceOverviewRequest("Fix conversation URL validation")).toBe(false);
  });

  it("recognizes short clarification confirmations", () => {
    expect(isClarificationConfirmation("yes")).toBe(true);
    expect(isClarificationConfirmation("Sure, go ahead.")).toBe(true);
    expect(isClarificationConfirmation("No, not yet.")).toBe(false);
    expect(isClarificationConfirmation("Please fix the validation bug")).toBe(false);
    expect(isClarificationRejection("No, don't inspect the files.")).toBe(true);
    expect(isClarificationRejection("yes, continue")).toBe(false);
  });

  it("carries the original task and clarification into an affirmative follow-up", () => {
    const prompt = buildClarificationFollowUpPrompt(
      { task: "Give me a read-only project overview", question: "Should I inspect the source files?" },
      "yes",
    );
    expect(prompt).toContain("Give me a read-only project overview");
    expect(prompt).toContain("Should I inspect the source files?");
    expect(prompt).toContain("User's answer:\nyes");
    expect(prompt).toContain("request specific paths using requestedFiles");
  });
});

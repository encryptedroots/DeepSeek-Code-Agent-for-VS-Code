import { describe, expect, it } from "vitest";
import {
  buildClarificationFollowUpPrompt,
  buildTaskPrompt,
  isClarificationConfirmation,
  isClarificationRejection,
  isMissingWorkspaceContextResponse,
  isSpecificFileContentsRequest,
  requiresWorkspaceContext,
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

  it("skips workspace context for ordinary conversation but keeps it for project tasks", () => {
    expect(
      requiresWorkspaceContext("Reply with exactly this line and nothing else: Plain-text reliability test: 456"),
    ).toBe(false);
    expect(requiresWorkspaceContext("Thanks, that worked.")).toBe(false);
    expect(requiresWorkspaceContext("What does this project do?")).toBe(true);
    expect(requiresWorkspaceContext("Fix the pairing issue.")).toBe(true);
    expect(requiresWorkspaceContext("Run the unit tests.")).toBe(true);
    expect(
      requiresWorkspaceContext("Create agent-smoke-test.txt with the requested text and verify its contents."),
    ).toBe(true);
    expect(requiresWorkspaceContext("Show me a short Python example.")).toBe(false);
  });

  it("recognizes file-access refusals without matching ordinary replies", () => {
    expect(isMissingWorkspaceContextResponse("I don’t have filesystem access in this chat.")).toBe(true);
    expect(isMissingWorkspaceContextResponse("I cannot read agent-smoke-test.txt.")).toBe(true);
    expect(isMissingWorkspaceContextResponse("I can't access the workspace files.")).toBe(true);
    expect(
      isMissingWorkspaceContextResponse(
        "I can't summarize missing.txt because it isn't present in the workspace. Please paste its contents.",
      ),
    ).toBe(true);
    expect(isMissingWorkspaceContextResponse("I can read the file contents you provided.")).toBe(false);
    expect(isMissingWorkspaceContextResponse("I can't access that website.")).toBe(false);
  });

  it("recognizes when DeepSeek requests contents of a specifically unavailable file", () => {
    expect(
      isSpecificFileContentsRequest(
        "I can't summarize missing.txt because it isn't present in the workspace. Please paste its exact contents.",
      ),
    ).toBe(true);
    expect(isSpecificFileContentsRequest("I can't access workspace files.")).toBe(false);
    expect(isSpecificFileContentsRequest("Please paste the file contents.")).toBe(false);
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
    expect(prompt).toContain("User's answer and any supplied file contents or missing details:\nyes");
    expect(prompt).toContain("Treat any file contents pasted in the user's answer as the requested workspace context");
    expect(prompt).toContain("request specific paths using requestedFiles");
  });

  it("attaches user-supplied missing file contents to the original task follow-up", () => {
    const suppliedContents = "Missing file contents:\nStatus: approved";
    const prompt = buildClarificationFollowUpPrompt(
      {
        task: "Read __context_request_smoke_test__/not-provided.txt and summarize it.",
        question: "Please paste the contents of __context_request_smoke_test__/not-provided.txt.",
      },
      suppliedContents,
    );
    expect(prompt).toContain("Read __context_request_smoke_test__/not-provided.txt and summarize it.");
    expect(prompt).toContain(suppliedContents);
    expect(prompt).toContain("Use those contents directly; do not ask for them again.");
  });
});

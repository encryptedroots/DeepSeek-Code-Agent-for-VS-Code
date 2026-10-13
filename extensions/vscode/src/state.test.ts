import { describe, expect, it } from "vitest";
import { TaskState } from "./state";

describe("task state transitions", () => {
  it("accepts the normal approval, editing, and verification flow", () => {
    const state = new TaskState();
    state.transition("thinking");
    state.transition("waiting");
    state.transition("editing");
    state.transition("testing");
    state.transition("completed");
    expect(state.status).toBe("completed");
  });

  it("rejects transitions that skip required task states", () => {
    const state = new TaskState();
    expect(() => state.transition("editing")).toThrow(/Invalid task state/);
  });

  it("allows approval between edits and each verification command", () => {
    const state = new TaskState();
    state.transition("thinking");
    state.transition("waiting");
    state.transition("editing");
    state.transition("waiting");
    state.transition("testing");
    state.transition("waiting");
    state.transition("testing");
    state.transition("completed");
    expect(state.status).toBe("completed");
  });

  it("allows bounded thinking iterations while requesting more context", () => {
    const state = new TaskState();
    state.transition("thinking");
    state.transition("thinking");
    state.transition("waiting");
    expect(state.status).toBe("waiting");
  });

  it("allows a clarification to pause a task and the user's answer to resume it", () => {
    const state = new TaskState();
    state.transition("thinking");
    state.transition("clarification");
    state.transition("thinking");
    expect(state.status).toBe("thinking");
  });
});

export type TaskStatus =
  | "thinking"
  | "editing"
  | "testing"
  | "waiting"
  | "clarification"
  | "completed"
  | "failed"
  | "cancelled";

export class TaskState {
  private current: TaskStatus = "completed";

  get status(): TaskStatus {
    return this.current;
  }

  transition(next: TaskStatus): void {
    const allowed: Record<TaskStatus, TaskStatus[]> = {
      completed: ["thinking"],
      failed: ["thinking"],
      cancelled: ["thinking"],
      clarification: ["thinking"],
      thinking: ["thinking", "waiting", "editing", "testing", "clarification", "completed", "failed", "cancelled"],
      waiting: ["thinking", "editing", "testing", "failed", "cancelled"],
      editing: ["thinking", "waiting", "testing", "completed", "failed", "cancelled"],
      testing: ["thinking", "waiting", "completed", "failed", "cancelled"],
    };
    if (!allowed[this.current].includes(next))
      throw new Error(`Invalid task state transition: ${this.current} -> ${next}`);
    this.current = next;
  }
}

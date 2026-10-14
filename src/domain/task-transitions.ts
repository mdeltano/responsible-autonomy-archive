import type { TaskStatus } from "../contracts/canonical.js";

// Task state machine (spec Step 6, §Reliability and limits). Terminal statuses never resume. A waiting
// task resumes only by going back to `queued`, so it re-enters the runner and takes a worker slot again.
// `running -> queued` is restart recovery: the previous process died mid-run.

const TERMINAL = ["completed", "refused", "partial", "failed", "cancelled"] as const;

const ALLOWED: Record<TaskStatus, readonly TaskStatus[]> = {
  queued: ["running", "cancelled", "failed"],
  running: ["waiting_for_information", "waiting_for_approval", "queued", ...TERMINAL],
  // A waiting task resumes, is cancelled, expires (partial), or is refused by an approver's denial.
  waiting_for_information: ["queued", "cancelled", "partial", "failed"],
  waiting_for_approval: ["queued", "cancelled", "partial", "refused", "failed"],
  completed: [],
  refused: [],
  partial: [],
  failed: [],
  cancelled: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return ALLOWED[from].includes(to);
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) throw new Error(`Illegal task transition ${from} -> ${to}`);
}

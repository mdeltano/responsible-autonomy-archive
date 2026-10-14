import { callerContext, type CallerContext } from "../contracts/caller-context.js";
import { isTerminalStatus, taskResult, taskStatus, type TaskResult, type TaskStatus } from "../contracts/canonical.js";
import { AppError, notFound } from "../contracts/errors.js";
import { assertTransition } from "../domain/task-transitions.js";
import { newId } from "../domain/ids.js";
import type { Database } from "./database.js";
import { int, json, jsonOrNull, text, textOrNull } from "./rows.js";

// Task records (spec Step 3, Step 6). Each task stores the CallerContext snapshot it was started with.
// Status changes go through transitionTask, which checks the transition table and updates only when
// the stored status is still the expected one, so two events can never both move the same task.

export interface TaskRecord {
  id: string;
  ownerId: string;
  instanceId: string;
  scenarioId: string;
  goal: string;
  status: TaskStatus;
  stage: string;
  inputHash: string;
  context: CallerContext;
  budgets: Record<string, number>;
  checkpoint: unknown;
  cancelRequested: boolean;
  result: TaskResult | null;
  createdAt: string;
  updatedAt: string;
  terminalAt: string | null;
}

export function createTask(
  db: Database,
  input: Pick<TaskRecord, "ownerId" | "instanceId" | "scenarioId" | "goal" | "inputHash" | "context" | "budgets"> & {
    now: string;
  },
): TaskRecord {
  const task: TaskRecord = {
    id: newId("task"),
    ownerId: input.ownerId,
    instanceId: input.instanceId,
    scenarioId: input.scenarioId,
    goal: input.goal,
    status: "queued",
    stage: "queued",
    inputHash: input.inputHash,
    context: callerContext.parse(input.context),
    budgets: input.budgets,
    checkpoint: null,
    cancelRequested: false,
    result: null,
    createdAt: input.now,
    updatedAt: input.now,
    terminalAt: null,
  };
  db.prepare(
    `INSERT INTO tasks (id, owner_id, instance_id, scenario_id, goal, status, stage, input_hash, context_json,
       budgets_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    task.id,
    task.ownerId,
    task.instanceId,
    task.scenarioId,
    task.goal,
    task.status,
    task.stage,
    task.inputHash,
    JSON.stringify(task.context),
    JSON.stringify(task.budgets),
    task.createdAt,
    task.updatedAt,
  );
  return task;
}

function toTask(row: Record<string, unknown>): TaskRecord {
  const result = jsonOrNull(row, "result_json");
  return {
    id: text(row, "id"),
    ownerId: text(row, "owner_id"),
    instanceId: text(row, "instance_id"),
    scenarioId: text(row, "scenario_id"),
    goal: text(row, "goal"),
    status: taskStatus.parse(text(row, "status")),
    stage: text(row, "stage"),
    inputHash: text(row, "input_hash"),
    context: callerContext.parse(json(row, "context_json")),
    budgets: json(row, "budgets_json"),
    checkpoint: jsonOrNull(row, "checkpoint_json"),
    cancelRequested: int(row, "cancel_requested") === 1,
    result: result === null ? null : taskResult.parse(result),
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at"),
    terminalAt: textOrNull(row, "terminal_at"),
  };
}

// Unknown and foreign-owner tasks are indistinguishable (spec §Security and privacy).
export function getTask(db: Database, id: string, ownerId: string): TaskRecord {
  const task = loadTask(db, id);
  if (!task || task.ownerId !== ownerId) throw notFound();
  return task;
}

// Engine-internal read with no owner check, for the coordinator acting on a task it already holds.
export function loadTask(db: Database, id: string): TaskRecord | null {
  const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
  return row ? toTask(row) : null;
}

export function listTasks(db: Database, ownerId: string, limit = 20): TaskRecord[] {
  return db
    .prepare("SELECT * FROM tasks WHERE owner_id = ? ORDER BY created_at DESC, id LIMIT ?")
    .all(ownerId, limit)
    .map(toTask);
}

export function listTasksByStatus(db: Database, statuses: readonly TaskStatus[]): TaskRecord[] {
  const placeholders = statuses.map(() => "?").join(", ");
  return db
    .prepare(`SELECT * FROM tasks WHERE status IN (${placeholders}) ORDER BY created_at, id`)
    .all(...statuses)
    .map(toTask);
}

export interface Transition {
  from: readonly TaskStatus[];
  to: TaskStatus;
  stage: string;
  now: string;
  result?: TaskResult;
}

// Moves a task only if its stored status is one of `from`. Returns false when another event got there
// first, which callers treat as "nothing to do" rather than as an error.
export function transitionTask(db: Database, id: string, t: Transition): boolean {
  for (const from of t.from) assertTransition(from, t.to);
  const terminal = isTerminalStatus(t.to);
  if (terminal !== (t.result !== undefined)) throw new Error("A result is recorded exactly when a task becomes terminal");
  const placeholders = t.from.map(() => "?").join(", ");
  const update = db
    .prepare(
      `UPDATE tasks SET status = ?, stage = ?, updated_at = ?, result_json = ?, terminal_at = ?
       WHERE id = ? AND status IN (${placeholders})`,
    )
    .run(
      t.to,
      t.stage,
      t.now,
      t.result === undefined ? null : JSON.stringify(taskResult.parse(t.result)),
      terminal ? t.now : null,
      id,
      ...t.from,
    );
  return update.changes === 1;
}

// Saves coordinator progress. Only a running task has a checkpoint to save.
export function saveCheckpoint(db: Database, id: string, input: { checkpoint: unknown; stage: string; now: string }): void {
  const update = db
    .prepare("UPDATE tasks SET checkpoint_json = ?, stage = ?, updated_at = ? WHERE id = ? AND status = 'running'")
    .run(JSON.stringify(input.checkpoint), input.stage, input.now, id);
  if (update.changes !== 1) throw new AppError("STATE_CONFLICT", "Task is no longer running", { taskId: id, retryable: false });
}

export function requestCancel(db: Database, id: string, now: string): void {
  db.prepare("UPDATE tasks SET cancel_requested = 1, updated_at = ? WHERE id = ?").run(now, id);
}

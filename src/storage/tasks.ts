import { callerContext, type CallerContext } from "../contracts/caller-context.js";
import { taskStatus, type TaskStatus } from "../contracts/canonical.js";
import { notFound } from "../contracts/errors.js";
import { newId } from "../domain/ids.js";
import type { Database } from "./database.js";
import { json, text } from "./rows.js";

// Task records (spec Step 3). Each task stores the CallerContext snapshot it was started with.
// Lifecycle transitions arrive with the coordinator (Step 6).

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
  createdAt: string;
  updatedAt: string;
}

export function createTask(
  db: Database,
  input: Omit<TaskRecord, "id" | "status" | "stage" | "createdAt" | "updatedAt"> & { now: string },
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
    createdAt: input.now,
    updatedAt: input.now,
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

// Unknown and foreign-owner tasks are indistinguishable (spec §Security and privacy).
export function getTask(db: Database, id: string, ownerId: string): TaskRecord {
  const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
  if (!row || text(row, "owner_id") !== ownerId) throw notFound();
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
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at"),
  };
}

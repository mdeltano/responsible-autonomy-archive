import { evidence, type Evidence } from "../contracts/canonical.js";
import { LIST_MAX_LENGTH } from "../contracts/primitives.js";
import type { Database } from "./database.js";
import { intOrNull, json, text } from "./rows.js";

// Task evidence (spec §Agent control loop, Step 6). The engine records what it read, with the source
// record and version; the planner never authors evidence.

function toEvidence(row: Record<string, unknown>): Evidence {
  return evidence.parse({
    id: text(row, "id"),
    kind: text(row, "kind"),
    sourceId: text(row, "source_id"),
    recordVersion: intOrNull(row, "record_version"),
    observedAt: text(row, "observed_at"),
    statement: text(row, "statement"),
    supportsPreconditionIds: json(row, "supports_precondition_ids_json"),
  });
}

export function insertEvidence(db: Database, input: Evidence & { taskId: string }): void {
  const { taskId: _taskId, ...rest } = input;
  const e = evidence.parse(rest);
  db.prepare(
    `INSERT INTO evidence (id, task_id, kind, source_id, record_version, observed_at, statement,
       supports_precondition_ids_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    e.id,
    input.taskId,
    e.kind,
    e.sourceId,
    e.recordVersion,
    e.observedAt,
    e.statement,
    JSON.stringify(e.supportsPreconditionIds),
  );
}

export function listEvidenceByIds(db: Database, taskId: string, ids: readonly string[]): Evidence[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
  return db
    .prepare(`SELECT * FROM evidence WHERE task_id = ? AND id IN (${placeholders}) ORDER BY rowid`)
    .all(taskId, ...ids)
    .map(toEvidence);
}

// The most recent evidence about the given source records, newest last, capped at the list limit so a
// proposal can cite it.
export function recentEvidenceFor(db: Database, taskId: string, sourceIds: readonly string[]): Evidence[] {
  if (sourceIds.length === 0) return [];
  const placeholders = sourceIds.map(() => "?").join(", ");
  return db
    .prepare(
      `SELECT * FROM (SELECT rowid AS r, * FROM evidence WHERE task_id = ? AND source_id IN (${placeholders})
         ORDER BY rowid DESC LIMIT ?) ORDER BY r`,
    )
    .all(taskId, ...sourceIds, LIST_MAX_LENGTH)
    .map(toEvidence);
}

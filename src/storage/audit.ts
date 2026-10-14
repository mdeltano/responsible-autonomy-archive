import { auditEvent, type AuditEvent } from "../contracts/canonical.js";
import { newId } from "../domain/ids.js";
import type { Database } from "./database.js";
import { int, json, text, textOrNull } from "./rows.js";

// Append-only audit log (spec Step 3). Sequence numbers are assigned in the same statement as the
// insert, and UNIQUE (task_id, sequence) rejects any concurrent duplicate. This log supports explanation;
// it is not tamper-proof storage.

export type NewAuditEvent = Omit<AuditEvent, "id" | "sequence">;

export function appendAuditEvent(db: Database, input: NewAuditEvent): AuditEvent {
  const id = newId("evt");
  // Validate the full event shape before writing; the placeholder sequence is replaced by SQL below.
  auditEvent.parse({ ...input, id, sequence: 0 });
  db.prepare(
    `INSERT INTO audit_events (id, task_id, sequence, timestamp, type, actor_id, proposal_id, operation_id,
       evidence_ids_json, rule_ids_json, summary, result)
     VALUES (?, ?, (SELECT COALESCE(MAX(sequence) + 1, 0) FROM audit_events WHERE task_id = ?),
       ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.taskId,
    input.taskId,
    input.timestamp,
    input.type,
    input.actorId,
    input.proposalId,
    input.operationId,
    JSON.stringify(input.evidenceIds),
    JSON.stringify(input.ruleIds),
    input.summary,
    input.result,
  );
  const row = db.prepare("SELECT sequence FROM audit_events WHERE id = ?").get(id);
  return { ...input, id, sequence: int(row ?? {}, "sequence") };
}

export function listAuditEvents(db: Database, taskId: string): AuditEvent[] {
  return db
    .prepare("SELECT * FROM audit_events WHERE task_id = ? ORDER BY sequence")
    .all(taskId)
    .map((row) =>
      auditEvent.parse({
        id: text(row, "id"),
        taskId: text(row, "task_id"),
        sequence: int(row, "sequence"),
        timestamp: text(row, "timestamp"),
        type: text(row, "type"),
        actorId: text(row, "actor_id"),
        proposalId: textOrNull(row, "proposal_id"),
        operationId: textOrNull(row, "operation_id"),
        evidenceIds: json(row, "evidence_ids_json"),
        ruleIds: json(row, "rule_ids_json"),
        summary: text(row, "summary"),
        result: text(row, "result"),
      }),
    );
}

// One page of a task's events in sequence order, starting at `fromSequence` (spec §Application service
// interface: getAudit). Reads one extra row to know whether another page exists.
export function listAuditPage(
  db: Database,
  taskId: string,
  fromSequence: number,
  limit: number,
): { events: AuditEvent[]; nextSequence: number | null } {
  const events = listAuditEvents(db, taskId).filter((e) => e.sequence >= fromSequence);
  const page = events.slice(0, limit);
  const next = events[limit];
  return { events: page, nextSequence: next === undefined ? null : next.sequence };
}

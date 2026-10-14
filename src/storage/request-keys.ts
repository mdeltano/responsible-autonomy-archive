import type { Database } from "./database.js";
import { text } from "./rows.js";

// startTask idempotency keys (spec §Reliability and limits, R10). A key is unique per owner and
// remembers the hash of the input it was first used with.

export interface RequestKey {
  taskId: string;
  inputHash: string;
}

export function findRequestKey(db: Database, ownerId: string, key: string): RequestKey | null {
  const row = db.prepare("SELECT * FROM request_keys WHERE owner_id = ? AND request_key = ?").get(ownerId, key);
  return row ? { taskId: text(row, "task_id"), inputHash: text(row, "input_hash") } : null;
}

export function insertRequestKey(
  db: Database,
  input: { ownerId: string; key: string; inputHash: string; taskId: string; now: string },
): void {
  db.prepare(
    "INSERT INTO request_keys (owner_id, request_key, input_hash, task_id, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(input.ownerId, input.key, input.inputHash, input.taskId, input.now);
}

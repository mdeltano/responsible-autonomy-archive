import { approval, type Approval } from "../contracts/canonical.js";
import type { Database } from "./database.js";
import { json, text, textOrNull } from "./rows.js";

// Approval records (spec Step 5). One approval per proposal (UNIQUE in the schema), so a denial blocks
// that proposal for good and changed circumstances need a new proposal. Status changes are conditional
// on the current status, so two operators cannot both resolve the same approval.

export interface StoredApproval {
  approval: Approval;
  createdAt: string;
  resolvedAt: string | null;
}

function toApproval(row: Record<string, unknown>): StoredApproval {
  return {
    approval: approval.parse({
      id: text(row, "id"),
      taskId: text(row, "task_id"),
      proposalId: text(row, "proposal_id"),
      actionDigest: text(row, "action_digest"),
      policyVersion: text(row, "policy_version"),
      stateVersions: json(row, "state_versions_json"),
      requiredRole: text(row, "required_role"),
      expiresAt: text(row, "expires_at"),
      status: text(row, "status"),
      approverId: textOrNull(row, "approver_id"),
    }),
    createdAt: text(row, "created_at"),
    resolvedAt: textOrNull(row, "resolved_at"),
  };
}

export function insertApproval(db: Database, input: { approval: Approval; createdAt: string }): void {
  const a = approval.parse(input.approval);
  if (a.status !== "pending") throw new Error("New approvals start pending");
  db.prepare(
    `INSERT INTO approvals (id, task_id, proposal_id, action_digest, policy_version, state_versions_json, required_role,
       expires_at, status, approver_id, created_at, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, NULL)`,
  ).run(
    a.id,
    a.taskId,
    a.proposalId,
    a.actionDigest,
    a.policyVersion,
    JSON.stringify(a.stateVersions),
    a.requiredRole,
    a.expiresAt,
    input.createdAt,
  );
}

export function readApproval(db: Database, id: string): StoredApproval | null {
  const row = db.prepare("SELECT * FROM approvals WHERE id = ?").get(id);
  return row ? toApproval(row) : null;
}

export function readApprovalForProposal(db: Database, proposalId: string): StoredApproval | null {
  const row = db.prepare("SELECT * FROM approvals WHERE proposal_id = ?").get(proposalId);
  return row ? toApproval(row) : null;
}

export function latestApprovalForTask(db: Database, taskId: string): StoredApproval | null {
  const row = db
    .prepare("SELECT * FROM approvals WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
    .get(taskId);
  return row ? toApproval(row) : null;
}

export function pendingApprovalForTask(db: Database, taskId: string): StoredApproval | null {
  const row = db.prepare("SELECT * FROM approvals WHERE task_id = ? AND status = 'pending'").get(taskId);
  return row ? toApproval(row) : null;
}

// Records an explicit operator decision. Only a pending approval can be decided.
export function decideApproval(
  db: Database,
  input: { id: string; status: "approved" | "denied"; approverId: string; now: string },
): boolean {
  const update = db
    .prepare("UPDATE approvals SET status = ?, approver_id = ?, resolved_at = ? WHERE id = ? AND status = 'pending'")
    .run(input.status, input.approverId, input.now, input.id);
  return update.changes === 1;
}

// Expiry applies only to an approval still waiting for a decision. Expiry is not a denial.
export function expireApproval(db: Database, id: string, now: string): boolean {
  const update = db
    .prepare("UPDATE approvals SET status = 'expired', resolved_at = ? WHERE id = ? AND status = 'pending'")
    .run(now, id);
  return update.changes === 1;
}

// A relevant change (records, policy, cancellation) voids a pending or granted approval. The contract
// sets approverId only for approved or denied, so it is cleared here; the audit log keeps who approved.
export function invalidateApproval(db: Database, id: string, now: string): boolean {
  const update = db
    .prepare(
      `UPDATE approvals SET status = 'invalidated', approver_id = NULL, resolved_at = ?
       WHERE id = ? AND status IN ('pending', 'approved')`,
    )
    .run(now, id);
  return update.changes === 1;
}

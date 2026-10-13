import { callerContext, type CallerContext } from "../contracts/caller-context.js";
import { actionProposal, type ActionProposal } from "../contracts/canonical.js";
import type { Database } from "./database.js";
import { json, text } from "./rows.js";

// Immutable proposals (spec Step 3, Step 5). Database triggers reject UPDATE and DELETE, so a stored
// proposal, its digest, and the caller context it was formed under can never change after insertion.

export interface StoredProposal {
  proposal: ActionProposal;
  context: CallerContext;
  createdAt: string;
}

export function insertProposal(db: Database, input: StoredProposal): void {
  const p = actionProposal.parse(input.proposal);
  const context = callerContext.parse(input.context);
  db.prepare(
    `INSERT INTO proposals (id, task_id, tool, target_id, arguments_json, evidence_ids_json, preconditions_json,
       policy_version, state_versions_json, action_digest, decision, rule_ids_json, explanation, context_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    p.id,
    p.taskId,
    p.tool,
    p.targetId,
    JSON.stringify(p.arguments),
    JSON.stringify(p.evidenceIds),
    JSON.stringify(p.preconditions),
    p.policyVersion,
    JSON.stringify(p.stateVersions),
    p.actionDigest,
    p.decision,
    JSON.stringify(p.ruleIds),
    p.explanation,
    JSON.stringify(context),
    input.createdAt,
  );
}

export function readProposal(db: Database, id: string): StoredProposal | null {
  const row = db.prepare("SELECT * FROM proposals WHERE id = ?").get(id);
  if (!row) return null;
  const proposal = actionProposal.parse({
    id: text(row, "id"),
    taskId: text(row, "task_id"),
    tool: text(row, "tool"),
    targetId: text(row, "target_id"),
    arguments: json(row, "arguments_json"),
    evidenceIds: json(row, "evidence_ids_json"),
    preconditions: json(row, "preconditions_json"),
    policyVersion: text(row, "policy_version"),
    stateVersions: json(row, "state_versions_json"),
    actionDigest: text(row, "action_digest"),
    decision: text(row, "decision"),
    ruleIds: json(row, "rule_ids_json"),
    explanation: text(row, "explanation"),
  });
  return { proposal, context: callerContext.parse(json(row, "context_json")), createdAt: text(row, "created_at") };
}

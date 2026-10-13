import { z } from "zod";
import {
  boundedList,
  boundedText,
  counter,
  currencyCode,
  LIST_MAX_LENGTH,
  narrative,
  nonEmptyNarrative,
  opaqueId,
  positiveMinorUnits,
  recordVersion,
  roleName,
  sha256Hex,
  utcTimestamp,
} from "./primitives.js";

// Canonical contracts (spec §Canonical contracts, Step 2). These schemas are the single source of truth:
// TypeScript types are inferred from them and JSON Schema is emitted from them (json-schema.ts).
// Schemas check shape and in-object invariants only; whether referenced IDs resolve, and whether the
// caller may see them, is checked against storage by the services.

export const ACTION_DECISIONS = ["AUTO_EXECUTE", "VERIFY_FIRST", "HUMAN_APPROVAL", "REFUSE"] as const;
export const actionDecision = z.enum(ACTION_DECISIONS);
export type ActionDecision = z.infer<typeof actionDecision>;

export const TERMINAL_TASK_STATUSES = ["completed", "refused", "partial", "failed", "cancelled"] as const;
export const taskStatus = z.enum([
  "queued",
  "running",
  "waiting_for_information",
  "waiting_for_approval",
  ...TERMINAL_TASK_STATUSES,
]);
export type TaskStatus = z.infer<typeof taskStatus>;

export const policyVersion = opaqueId;
export const ruleId = opaqueId;
export const preconditionId = opaqueId;

// Map of record ID -> version observed when the proposal or approval was formed. Any change to one of
// these versions invalidates the binding (spec §Policy rules).
export const stateVersions = z
  .record(opaqueId, recordVersion)
  .refine((v) => Object.keys(v).length <= LIST_MAX_LENGTH, `must have at most ${LIST_MAX_LENGTH} entries`);
export type StateVersions = z.infer<typeof stateVersions>;

export const evidence = z
  .strictObject({
    id: opaqueId,
    kind: z.enum(["record", "user_statement", "inference"]),
    sourceId: opaqueId,
    recordVersion: recordVersion.nullable(),
    observedAt: utcTimestamp,
    statement: nonEmptyNarrative,
    supportsPreconditionIds: boundedList(preconditionId),
  })
  .refine((e) => e.kind !== "record" || e.recordVersion !== null, {
    message: "record evidence must carry the record version it was read at",
    path: ["recordVersion"],
  });
export type Evidence = z.infer<typeof evidence>;

export const precondition = z.strictObject({
  id: preconditionId,
  description: nonEmptyNarrative,
  status: z.enum(["satisfied", "missing", "conflicting", "stale"]),
});
export type Precondition = z.infer<typeof precondition>;

// Tool-specific proposal arguments (spec §Internal agent tools). A commit_refund proposal carries the
// exact refund that propose_refund requested; the destination is always the original payment, so
// no account field exists to be filled from untrusted text.
export const refundArguments = z.strictObject({
  orderId: opaqueId,
  amountMinor: positiveMinorUnits,
  currency: currencyCode,
  reason: nonEmptyNarrative,
});
export type RefundArguments = z.infer<typeof refundArguments>;

export const resolutionArguments = z.strictObject({
  orderId: opaqueId,
  note: nonEmptyNarrative,
});
export type ResolutionArguments = z.infer<typeof resolutionArguments>;

const proposalBase = {
  id: opaqueId,
  taskId: opaqueId,
  targetId: opaqueId,
  evidenceIds: boundedList(opaqueId),
  preconditions: boundedList(precondition),
  policyVersion,
  stateVersions,
  actionDigest: sha256Hex,
  decision: actionDecision,
  ruleIds: boundedList(ruleId),
  explanation: narrative,
};

export const actionProposal = z
  .discriminatedUnion("tool", [
    z.strictObject({ ...proposalBase, tool: z.literal("commit_refund"), arguments: refundArguments }),
    z.strictObject({ ...proposalBase, tool: z.literal("record_resolution"), arguments: resolutionArguments }),
  ])
  .refine((p) => p.targetId === p.arguments.orderId, {
    message: "targetId must match the order named in the arguments",
    path: ["targetId"],
  })
  // Approval never substitutes for missing facts (spec §Product behavior): only a proposal whose
  // preconditions are all satisfied can be executed or sent for approval.
  .refine(
    (p) =>
      (p.decision !== "AUTO_EXECUTE" && p.decision !== "HUMAN_APPROVAL") ||
      p.preconditions.every((c) => c.status === "satisfied"),
    { message: "AUTO_EXECUTE and HUMAN_APPROVAL require every precondition satisfied", path: ["decision"] },
  );
export type ActionProposal = z.infer<typeof actionProposal>;

export const approval = z
  .strictObject({
    id: opaqueId,
    taskId: opaqueId,
    proposalId: opaqueId,
    actionDigest: sha256Hex,
    policyVersion,
    stateVersions,
    requiredRole: roleName,
    expiresAt: utcTimestamp,
    status: z.enum(["pending", "approved", "denied", "expired", "invalidated"]),
    approverId: opaqueId.nullable(),
  })
  // Only an explicit operator decision records an approver; nothing else may claim one.
  .refine((a) => (a.status === "approved" || a.status === "denied") === (a.approverId !== null), {
    message: "approverId is set exactly when the approval was approved or denied",
    path: ["approverId"],
  });
export type Approval = z.infer<typeof approval>;

export const question = z.strictObject({
  id: opaqueId,
  taskId: opaqueId,
  // A question exists only to resolve specific missing preconditions (spec §Agent control loop).
  missingPreconditionIds: boundedList(preconditionId).min(1),
  text: nonEmptyNarrative,
  options: boundedList(boundedText(1, 200)),
  answer: nonEmptyNarrative.nullable(),
});
export type Question = z.infer<typeof question>;

export const auditEvent = z.strictObject({
  id: opaqueId,
  taskId: opaqueId,
  sequence: counter,
  timestamp: utcTimestamp,
  type: z.enum([
    "lookup",
    "proposal",
    "decision",
    "question",
    "approval",
    "execution",
    "verification",
    "state_change",
    "error",
  ]),
  actorId: opaqueId,
  proposalId: opaqueId.nullable(),
  operationId: opaqueId.nullable(),
  evidenceIds: boundedList(opaqueId),
  ruleIds: boundedList(ruleId),
  summary: nonEmptyNarrative,
  result: z.enum(["success", "blocked", "pending", "failure", "unknown"]),
});
export type AuditEvent = z.infer<typeof auditEvent>;

export const taskResult = z.strictObject({
  outcome: nonEmptyNarrative,
  operationIds: boundedList(opaqueId),
  verified: z.boolean(),
  limitations: boundedList(nonEmptyNarrative),
});
export type TaskResult = z.infer<typeof taskResult>;

const terminalStatuses: ReadonlySet<TaskStatus> = new Set(TERMINAL_TASK_STATUSES);

export function isTerminalStatus(status: TaskStatus): boolean {
  return terminalStatuses.has(status);
}

export const taskSummary = z
  .strictObject({
    id: opaqueId,
    status: taskStatus,
    stage: boundedText(1, 64),
    createdAt: utcTimestamp,
    updatedAt: utcTimestamp,
    question: question.nullable(),
    approval: approval.nullable(),
    result: taskResult.nullable(),
    warnings: boundedList(nonEmptyNarrative),
  })
  .superRefine((t, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    // Lexical comparison is valid because utcTimestamp only admits "Z" timestamps.
    if (t.updatedAt < t.createdAt) issue("updatedAt", "updatedAt must not precede createdAt");
    if ((t.status === "waiting_for_information") !== (t.question !== null && t.question.answer === null)) {
      issue("question", "an unanswered question is present exactly when waiting_for_information");
    }
    if ((t.status === "waiting_for_approval") !== (t.approval?.status === "pending")) {
      issue("approval", "a pending approval is present exactly when waiting_for_approval");
    }
    if (isTerminalStatus(t.status) !== (t.result !== null)) {
      issue("result", "a result is present exactly when the task is terminal");
    }
    // Honest status: completion requires a verified ledger outcome (spec §Definition of done).
    if (t.status === "completed" && t.result?.verified !== true) {
      issue("result", "completed tasks must have a verified result");
    }
  });
export type TaskSummary = z.infer<typeof taskSummary>;

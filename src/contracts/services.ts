import { z } from "zod";
import { boundedText, idempotencyKey, opaqueId } from "./primitives.js";

// Application service inputs (spec §Application service interface, Step 2). Every input is a strict
// object. None of them carries caller identity, roles, or scope: trusted CallerContext is supplied
// separately by the interface from configuration and never parsed out of request data.

// At least one non-whitespace character, so padding cannot satisfy a minimum length.
const meaningfulText = (min: number, max: number) => boundedText(min, max).regex(/\S/, "must not be blank");

export const startTaskInput = z.strictObject({
  goal: meaningfulText(10, 4000),
  scenarioId: opaqueId,
  idempotencyKey: idempotencyKey.optional(),
});
export type StartTaskInput = z.infer<typeof startTaskInput>;

export const getTaskInput = z.strictObject({ taskId: opaqueId });
export type GetTaskInput = z.infer<typeof getTaskInput>;

export const answerQuestionInput = z.strictObject({
  taskId: opaqueId,
  questionId: opaqueId,
  answer: meaningfulText(1, 2000),
});
export type AnswerQuestionInput = z.infer<typeof answerQuestionInput>;

export const getProposalInput = z.strictObject({ taskId: opaqueId, proposalId: opaqueId });
export type GetProposalInput = z.infer<typeof getProposalInput>;

// The approver's identity and role come from CallerContext, never from this object (spec Step 5).
export const resolveApprovalInput = z.strictObject({
  taskId: opaqueId,
  approvalId: opaqueId,
  decision: z.enum(["approve", "deny"]),
});
export type ResolveApprovalInput = z.infer<typeof resolveApprovalInput>;

export const getAuditInput = z.strictObject({
  taskId: opaqueId,
  cursor: opaqueId.optional(),
  limit: z.int().min(1).max(100).default(25),
});
export type GetAuditInput = z.infer<typeof getAuditInput>;

export const cancelTaskInput = z.strictObject({ taskId: opaqueId });
export type CancelTaskInput = z.infer<typeof cancelTaskInput>;

export const listScenariosInput = z.strictObject({});
export type ListScenariosInput = z.infer<typeof listScenariosInput>;

export const startEvaluationInput = z.strictObject({
  suiteId: opaqueId,
  split: z.enum(["development", "held_out"]),
  repeats: z.int().min(1).max(5).default(3),
});
export type StartEvaluationInput = z.infer<typeof startEvaluationInput>;

export const getEvaluationInput = z.strictObject({ evaluationId: opaqueId });
export type GetEvaluationInput = z.infer<typeof getEvaluationInput>;

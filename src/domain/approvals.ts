import type { ActionProposal, Approval } from "../contracts/canonical.js";
import { parseUtcTimestamp } from "./clock.js";
import { canonicalJson } from "./digest.js";

// Approval binding (spec Step 5, §Policy rules). An approval authorizes exactly one stored proposal:
// same digest, policy version, and record versions, still within its expiry. Anything else is a reason
// it cannot be used. Pure: callers supply the records and the time.

export type ApprovalProblem =
  | "not_approved"
  | "expired"
  | "digest_mismatch"
  | "policy_changed"
  | "state_changed"
  | "wrong_proposal";

export function isExpired(approval: Pick<Approval, "expiresAt">, now: number): boolean {
  return now >= parseUtcTimestamp(approval.expiresAt);
}

export function approvalProblems(
  approval: Approval,
  proposal: ActionProposal,
  current: { policyVersion: string; now: number },
): ApprovalProblem[] {
  const problems: ApprovalProblem[] = [];
  if (approval.proposalId !== proposal.id || approval.taskId !== proposal.taskId) problems.push("wrong_proposal");
  if (approval.status !== "approved") problems.push("not_approved");
  if (isExpired(approval, current.now)) problems.push("expired");
  if (approval.actionDigest !== proposal.actionDigest) problems.push("digest_mismatch");
  if (approval.policyVersion !== current.policyVersion || proposal.policyVersion !== current.policyVersion) {
    problems.push("policy_changed");
  }
  if (canonicalJson(approval.stateVersions) !== canonicalJson(proposal.stateVersions)) problems.push("state_changed");
  return problems;
}

export const APPROVAL_PROBLEM_TEXT: Record<ApprovalProblem, string> = {
  not_approved: "the proposal has not been approved",
  expired: "the approval has expired",
  digest_mismatch: "the approval does not match this exact action",
  policy_changed: "the policy version changed",
  state_changed: "the records changed",
  wrong_proposal: "the approval belongs to a different proposal",
};

import type { TaskStatus } from "../contracts/canonical.js";

// Completion checks and terminal classification (spec Step 6, §Reliability and limits; owner-defined
// checks in DECISIONS.md "Completion checks for finish"). Pure functions over facts the coordinator
// reads from records. Nothing here looks at model text: a planner can request finish, but only these
// checks decide whether the task completed and which status it ends with.

export interface ResolutionFacts {
  // The accepted case-level conclusion, if any.
  resolution: { orderId: string; resolution: "refund" | "no_refund" } | null;
  // Whether that order is inside the task's trusted scope, judged from the stored record.
  orderInScope: boolean;
  // A refund operation by this task on that order that verify_refund confirmed against the ledger.
  verifiedRefundOnOrder: boolean;
  // Current eligibility of the order under policy, from records.
  eligibility: "eligible" | "ineligible" | "unknown" | null;
  // The ledger shows nothing left to refund on the order (refunded in full, possibly before this task).
  fullyRefunded: boolean;
}

export interface CompletionFacts extends ResolutionFacts {
  openQuestion: boolean;
  pendingApproval: boolean;
  unknownCommitOutcome: boolean;
  // Operations by this task on orders other than the resolved one (R14: no unrelated actions).
  operationsOutsideCase: number;
  resolutionNoteRecorded: boolean;
}

export type CompletionCheck =
  | "resolution_accepted"
  | "resolution_backed_by_facts"
  | "nothing_pending"
  | "no_action_outside_case"
  | "outcome_recorded";

export const COMPLETION_CHECK_TEXT: Record<CompletionCheck, string> = {
  resolution_accepted: "an accepted propose_resolution for an order in scope",
  resolution_backed_by_facts:
    "facts backing the resolution (a verified refund, or an ineligible or fully refunded order for no_refund)",
  nothing_pending: "no unanswered question, pending approval, or unreconciled commit",
  no_action_outside_case: "no operations on orders outside the resolved case",
  outcome_recorded: "a resolution note recorded with record_resolution for the order",
};

// Checks 1 and 2: whether a propose_resolution can be accepted.
export function resolutionUnmet(facts: ResolutionFacts): CompletionCheck[] {
  if (facts.resolution === null || !facts.orderInScope) return ["resolution_accepted"];
  const backed =
    facts.resolution.resolution === "refund"
      ? facts.verifiedRefundOnOrder
      : facts.eligibility === "ineligible" || facts.fullyRefunded;
  return backed ? [] : ["resolution_backed_by_facts"];
}

export function completionUnmet(facts: CompletionFacts): CompletionCheck[] {
  const unmet = resolutionUnmet(facts);
  if (facts.openQuestion || facts.pendingApproval || facts.unknownCommitOutcome) unmet.push("nothing_pending");
  if (facts.operationsOutsideCase > 0) unmet.push("no_action_outside_case");
  if (!facts.resolutionNoteRecorded) unmet.push("outcome_recorded");
  return unmet;
}

// Why a task is ending without a completed outcome.
export type StopReason =
  | "finish_rejected" // the planner gave up, or kept asking to finish with checks unmet
  | "budget_exhausted"
  | "timeout"
  | "invalid_model_output"
  | "wait_expired"
  | "error";

export interface StopFacts {
  reason: StopReason;
  // The gate refused a refund proposal, or a lookup was refused for scope, during this task.
  refusalOccurred: boolean;
  refundCommitted: boolean;
  // Any successful record lookup or committed operation.
  usefulWork: boolean;
}

// refused: policy blocks the goal and nothing was done that would make it partial; partial: useful
// work but the goal is unfinished; failed: no useful work, or an unrecoverable error. Budget and time
// exhaustion are never refused or completed (spec Step 6, §Reliability and limits).
export function stopStatus(facts: StopFacts): Extract<TaskStatus, "refused" | "partial" | "failed"> {
  switch (facts.reason) {
    case "wait_expired":
      return "partial";
    case "finish_rejected":
      if (facts.refusalOccurred && !facts.refundCommitted) return "refused";
      return facts.usefulWork ? "partial" : "failed";
    case "budget_exhausted":
    case "timeout":
      return facts.usefulWork ? "partial" : "failed";
    case "invalid_model_output":
    case "error":
      return facts.refundCommitted ? "partial" : "failed";
  }
}

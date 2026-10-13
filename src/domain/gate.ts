import { z } from "zod";
import type { CallerContext } from "../contracts/caller-context.js";
import {
  refundArguments,
  resolutionArguments,
  stateVersions,
  type ActionDecision,
  type Precondition,
  type StateVersions,
} from "../contracts/canonical.js";
import { parseInput } from "../contracts/errors.js";
import type { RefundPolicy } from "../contracts/policy.js";
import { canAccessOrder } from "./authorization.js";
import {
  evaluateEligibility,
  factsFromRecords,
  type CheckStatus,
  type EligibilityCheckId,
  type OrderFacts,
  type PaymentFacts,
} from "./eligibility.js";

// Deterministic policy and execution gate (spec Step 4, §Policy rules). A pure function of trusted
// caller context, the exact action, current records, and the versioned policy. It reads no free text:
// refund reasons, record notes, model rationale, and confidence cannot reach a verdict. Rules run in a
// fixed order: prohibitions and scope, unresolved facts, approval requirements, then allowed.

export const RULE_IDS = [
  "ORDER_SCOPE",
  "POSITIVE_AMOUNT",
  "ORDER_CURRENCY",
  "DUPLICATE_OPERATION",
  "ELIGIBLE_ORDER",
  "AVAILABLE_BALANCE",
  "ORIGINAL_DESTINATION",
  "FRESH_STATE",
  "APPROVAL_THRESHOLD",
  "APPROVAL_PATH",
] as const;
export type RuleId = (typeof RULE_IDS)[number];

// The exact action under evaluation. stateVersions is present when rechecking a stored proposal and
// absent when forming a new one. Strict: there is nowhere to put a rationale or a confidence score.
export const gateAction = z.discriminatedUnion("tool", [
  z.strictObject({ tool: z.literal("commit_refund"), arguments: refundArguments, stateVersions: stateVersions.optional() }),
  z.strictObject({
    tool: z.literal("record_resolution"),
    arguments: resolutionArguments,
    stateVersions: stateVersions.optional(),
  }),
]);
export type GateAction = z.infer<typeof gateAction>;

export interface GateOrder extends OrderFacts {
  id: string;
  customerId: string;
  currency: string;
  version: number;
}

export interface GatePayment extends PaymentFacts {
  id: string;
  orderId: string;
  destination: string;
  version: number;
}

// Earlier operations by this task on this order. "unknown" is an attempt whose outcome has not been
// reconciled yet (for example, a lost acknowledgment).
export interface PriorOperation {
  kind: "refund" | "resolution_note";
  status: "committed" | "verified" | "unknown";
}

// Current state, read from trusted records by the application. The gate never fetches anything.
export interface GateState {
  order: GateOrder | null;
  payment: GatePayment | null;
  priorOperations: readonly PriorOperation[];
  now: number;
  // Whether a trusted operator holding the approver role can act on approvals in this deployment.
  approvalPathAvailable: boolean;
}

export type RuleOutcome = "pass" | "fail" | "unresolved";

export interface RuleCheck {
  ruleId: RuleId;
  outcome: RuleOutcome;
  detail: string;
}

export interface GateResult {
  decision: ActionDecision;
  // Rules that determined the decision.
  ruleIds: RuleId[];
  preconditions: Precondition[];
  missingPreconditionIds: string[];
  explanation: string;
  requiredRole: string | null;
  // Current versions of the records the action depends on; a new proposal binds to these.
  stateVersions: StateVersions;
  // Every rule evaluated, in order, for audit and display.
  checks: RuleCheck[];
}

const ELIGIBILITY_PRECONDITIONS: Record<EligibilityCheckId, { id: string; description: string }> = {
  order_paid: { id: "pre_order_paid", description: "Order payment status is established from the order record" },
  within_refund_window: { id: "pre_refund_window", description: "Refund window is established and current" },
  no_exclusion: { id: "pre_no_exclusion", description: "Refund exclusions for the order are established" },
  positive_refundable_balance: {
    id: "pre_refundable_balance",
    description: "Paid and refunded amounts are established from the payment record",
  },
};

// A precondition is about knowledge: a definite pass or fail both establish the fact.
function factStatus(check: CheckStatus): Precondition["status"] {
  return check === "missing" ? "missing" : check === "conflicting" ? "conflicting" : "satisfied";
}

function precondition(id: string, description: string, status: Precondition["status"]): Precondition {
  return { id, description, status };
}

function currentVersions(order: GateOrder, payment: GatePayment | null): StateVersions {
  return payment ? { [order.id]: order.version, [payment.id]: payment.version } : { [order.id]: order.version };
}

function isStale(bound: StateVersions | undefined, current: StateVersions): boolean {
  if (bound === undefined) return false;
  const keys = new Set([...Object.keys(bound), ...Object.keys(current)]);
  return [...keys].some((key) => bound[key] !== current[key]);
}

function result(
  decision: ActionDecision,
  decisive: RuleCheck[],
  checks: RuleCheck[],
  preconditions: Precondition[],
  versions: StateVersions,
  requiredRole: string | null = null,
): GateResult {
  return {
    decision,
    ruleIds: decisive.map((c) => c.ruleId),
    preconditions,
    missingPreconditionIds: preconditions.filter((p) => p.status !== "satisfied").map((p) => p.id),
    explanation: decisive.map((c) => c.detail).join(" "),
    requiredRole,
    stateVersions: versions,
    checks,
  };
}

export function evaluateAction(
  context: CallerContext,
  input: GateAction,
  state: GateState,
  policy: RefundPolicy,
): GateResult {
  const action = parseInput(gateAction, input);
  const checks: RuleCheck[] = [];
  const check = (ruleId: RuleId, outcome: RuleOutcome, detail: string): RuleCheck => {
    const entry = { ruleId, outcome, detail };
    checks.push(entry);
    return entry;
  };

  // 1. Scope. Unknown and out-of-scope orders get the same answer, and nothing else about the order is
  // evaluated or revealed.
  const { order, payment } = state;
  if (
    !order ||
    order.id !== action.arguments.orderId ||
    !canAccessOrder(context, { orderId: order.id, customerId: order.customerId })
  ) {
    const scope = check("ORDER_SCOPE", "fail", "The order is not available to this caller.");
    return result("REFUSE", [scope], checks, [], {});
  }
  if (payment && payment.orderId !== order.id) throw new Error("Gate state pairs a payment with a different order");
  check("ORDER_SCOPE", "pass", "The order belongs to an authorized customer.");
  const versions = currentVersions(order, payment);

  const priorOfKind = state.priorOperations.filter(
    (op) => op.kind === (action.tool === "commit_refund" ? "refund" : "resolution_note"),
  );
  const alreadyDone = priorOfKind.some((op) => op.status !== "unknown");
  const outcomeUnknown = priorOfKind.some((op) => op.status === "unknown");
  const stale = isStale(action.stateVersions, versions);
  const sharedPreconditions = [
    precondition("pre_prior_outcome", "Outcomes of earlier attempts are known", outcomeUnknown ? "missing" : "satisfied"),
    precondition("pre_fresh_state", "Records are unchanged since the action was formed", stale ? "stale" : "satisfied"),
  ];

  if (action.tool === "record_resolution") {
    if (alreadyDone) {
      const dup = check("DUPLICATE_OPERATION", "fail", "A resolution note was already recorded for this order.");
      return result("REFUSE", [dup], checks, sharedPreconditions, versions);
    }
    const unresolved = [
      ...(outcomeUnknown
        ? [check("DUPLICATE_OPERATION", "unresolved", "An earlier note attempt has an unknown outcome; reconcile it first.")]
        : []),
      ...(stale ? [check("FRESH_STATE", "unresolved", "The order changed since the action was formed.")] : []),
    ];
    if (unresolved.length > 0) return result("VERIFY_FIRST", unresolved, checks, sharedPreconditions, versions);
    const ok = check("DUPLICATE_OPERATION", "pass", "No resolution note exists yet for this order.");
    return result("AUTO_EXECUTE", [ok], checks, sharedPreconditions, versions);
  }

  // Refund. 2. Explicit prohibitions on known facts.
  const args = action.arguments;
  const eligibility = evaluateEligibility(factsFromRecords(order, payment), state.now);
  const preconditions = [
    ...Object.entries(ELIGIBILITY_PRECONDITIONS).map(([checkId, p]) =>
      precondition(p.id, p.description, factStatus(eligibility.checks[checkId as EligibilityCheckId])),
    ),
    precondition("pre_original_destination", "The original payment destination is known", payment ? "satisfied" : "missing"),
    ...sharedPreconditions,
  ];

  const prohibited: RuleCheck[] = [];
  if (args.amountMinor <= 0 || !Number.isSafeInteger(args.amountMinor)) {
    prohibited.push(check("POSITIVE_AMOUNT", "fail", "The refund amount must be a positive whole number of minor units."));
  }
  if (args.currency !== order.currency) {
    prohibited.push(check("ORDER_CURRENCY", "fail", `The refund must use the order currency ${order.currency}.`));
  }
  if (alreadyDone) {
    prohibited.push(check("DUPLICATE_OPERATION", "fail", "This task already refunded this order; it will not be repeated."));
  }
  if (eligibility.status === "ineligible") {
    const reasons = Object.entries(eligibility.checks)
      .filter(([, status]) => status === "fail")
      .map(([id]) => id)
      .join(", ");
    prohibited.push(check("ELIGIBLE_ORDER", "fail", `The order is not eligible for a refund (${reasons}).`));
  }
  const remaining = eligibility.remainingRefundable;
  if (remaining && args.currency === remaining.currency && args.amountMinor > remaining.amountMinor) {
    prohibited.push(
      check("AVAILABLE_BALANCE", "fail", `The amount exceeds the remaining refundable balance of ${remaining.amountMinor}.`),
    );
  }
  if (prohibited.length > 0) return result("REFUSE", prohibited, checks, preconditions, versions);

  // 3. Unresolved facts: look up, reconcile, or ask before anything else.
  const unresolved: RuleCheck[] = [];
  if (!payment) {
    unresolved.push(check("ORIGINAL_DESTINATION", "unresolved", "The original payment record has not been established."));
  }
  if (eligibility.status === "unknown") {
    const open = Object.entries(eligibility.checks)
      .filter(([, status]) => status === "missing" || status === "conflicting")
      .map(([id, status]) => `${id} is ${status}`)
      .join(", ");
    unresolved.push(check("ELIGIBLE_ORDER", "unresolved", `Eligibility cannot be determined yet (${open}).`));
  }
  if (outcomeUnknown) {
    unresolved.push(
      check("DUPLICATE_OPERATION", "unresolved", "An earlier refund attempt has an unknown outcome; reconcile it first."),
    );
  }
  if (stale) unresolved.push(check("FRESH_STATE", "unresolved", "Records changed since the action was formed."));
  if (unresolved.length > 0) return result("VERIFY_FIRST", unresolved, checks, preconditions, versions);

  check("ELIGIBLE_ORDER", "pass", "The order is eligible for a refund.");
  check("AVAILABLE_BALANCE", "pass", "The amount is within the remaining refundable balance.");
  check("ORIGINAL_DESTINATION", "pass", "The refund goes to the original payment destination.");

  // 4. Approval requirements. A currency without a configured threshold never executes automatically.
  const threshold = policy.currencies[args.currency]?.autoExecuteMaxMinor;
  if (threshold === undefined || args.amountMinor > threshold) {
    const why =
      threshold === undefined
        ? `Policy ${policy.version} sets no automatic threshold for ${args.currency}.`
        : `Refunds above ${threshold} ${args.currency} minor units require approval under policy ${policy.version}.`;
    if (!state.approvalPathAvailable) {
      const alternative =
        threshold === undefined ? "" : ` A refund of at most ${threshold} minor units can execute automatically.`;
      const path = check("APPROVAL_PATH", "fail", `${why} No trusted approval path is configured.${alternative}`);
      return result("REFUSE", [path], checks, preconditions, versions);
    }
    const approval = check("APPROVAL_THRESHOLD", "fail", `${why} Approver role: ${policy.approverRole}.`);
    return result("HUMAN_APPROVAL", [approval], checks, preconditions, versions, policy.approverRole);
  }
  const auto = check("APPROVAL_THRESHOLD", "pass", `The amount is within the automatic threshold of ${threshold}.`);
  return result("AUTO_EXECUTE", [auto], checks, preconditions, versions);
}

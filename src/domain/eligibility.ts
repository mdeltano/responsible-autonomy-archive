import { z } from "zod";
import { currencyCode, minorUnits, positiveMinorUnits, utcTimestamp } from "../contracts/primitives.js";
import { parseUtcTimestamp } from "./clock.js";
import { compareMoney, money, subtractMoney, type Money } from "./money.js";

// Deterministic refund eligibility (spec Step 2, §Policy rules). An order is eligible when it is paid,
// inside its fixture-configured refund window, has no fixture-defined exclusion, and has a positive
// refundable balance. Facts come from trusted records; null means the fact is not known. A missing or
// conflicting fact yields "unknown" (which the gate turns into VERIFY_FIRST), never invented eligibility.

const DAY_MS = 24 * 60 * 60 * 1000;

const amount = z.strictObject({ amountMinor: minorUnits, currency: currencyCode });

export const eligibilityFacts = z.strictObject({
  paymentStatus: z.enum(["paid", "unpaid", "voided"]).nullable(),
  // The fixture chooses what starts the window (e.g. payment or delivery) and how long it lasts.
  refundWindow: z.strictObject({ startsAt: utcTimestamp, days: positiveMinorUnits }).nullable(),
  // Exclusion codes defined by the fixture; [] means checked and none apply, null means not known.
  exclusions: z.array(z.string().min(1).max(64)).max(20).nullable(),
  paidAmount: amount.nullable(),
  refundedAmount: amount.nullable(),
});
export type EligibilityFacts = z.infer<typeof eligibilityFacts>;

export const ELIGIBILITY_CHECKS = [
  "order_paid",
  "within_refund_window",
  "no_exclusion",
  "positive_refundable_balance",
] as const;
export type EligibilityCheckId = (typeof ELIGIBILITY_CHECKS)[number];
export type CheckStatus = "pass" | "fail" | "missing" | "conflicting";

export interface EligibilityResult {
  status: "eligible" | "ineligible" | "unknown";
  checks: Record<EligibilityCheckId, CheckStatus>;
  remainingRefundable: Money | null;
}

function checkPaid(facts: EligibilityFacts): CheckStatus {
  if (facts.paymentStatus === null) return "missing";
  return facts.paymentStatus === "paid" ? "pass" : "fail";
}

// The window includes its final millisecond: eligible while now <= startsAt + days.
function checkWindow(facts: EligibilityFacts, now: number): CheckStatus {
  if (facts.refundWindow === null) return "missing";
  const start = parseUtcTimestamp(facts.refundWindow.startsAt);
  if (start > now) return "conflicting";
  return now <= start + facts.refundWindow.days * DAY_MS ? "pass" : "fail";
}

function checkExclusions(facts: EligibilityFacts): CheckStatus {
  if (facts.exclusions === null) return "missing";
  return facts.exclusions.length === 0 ? "pass" : "fail";
}

function checkBalance(facts: EligibilityFacts): { status: CheckStatus; remaining: Money | null } {
  if (facts.paidAmount === null || facts.refundedAmount === null) return { status: "missing", remaining: null };
  const paid = money(facts.paidAmount.amountMinor, facts.paidAmount.currency);
  const refunded = money(facts.refundedAmount.amountMinor, facts.refundedAmount.currency);
  // Records that disagree on currency, or refunds exceeding payment, are conflicting data.
  if (paid.currency !== refunded.currency || compareMoney(refunded, paid) > 0) {
    return { status: "conflicting", remaining: null };
  }
  const remaining = subtractMoney(paid, refunded);
  return { status: remaining.amountMinor > 0 ? "pass" : "fail", remaining };
}

export function evaluateEligibility(input: EligibilityFacts, now: number): EligibilityResult {
  const facts = eligibilityFacts.parse(input);
  const balance = checkBalance(facts);
  const checks: Record<EligibilityCheckId, CheckStatus> = {
    order_paid: checkPaid(facts),
    within_refund_window: checkWindow(facts, now),
    no_exclusion: checkExclusions(facts),
    positive_refundable_balance: balance.status,
  };
  const statuses = Object.values(checks);
  // A definite failure settles the question even if other facts are unknown.
  const status = statuses.includes("fail")
    ? "ineligible"
    : statuses.every((s) => s === "pass")
      ? "eligible"
      : "unknown";
  return { status, checks, remainingRefundable: balance.remaining };
}

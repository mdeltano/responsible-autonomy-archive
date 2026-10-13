import { describe, expect, it } from "vitest";
import { ManualClock } from "../../src/domain/clock.js";
import { evaluateEligibility, type EligibilityFacts } from "../../src/domain/eligibility.js";

const clock = new ManualClock("2026-10-13T12:00:00Z");

// Eligible baseline: paid 12000 USD, nothing refunded, 30-day window opened 10 days ago.
const eligible: EligibilityFacts = {
  paymentStatus: "paid",
  refundWindow: { startsAt: "2026-10-03T12:00:00Z", days: 30 },
  exclusions: [],
  paidAmount: { amountMinor: 12000, currency: "USD" },
  refundedAmount: { amountMinor: 0, currency: "USD" },
};

describe("evaluateEligibility (spec Step 2)", () => {
  it("is eligible when every check passes and reports the remaining balance", () => {
    const result = evaluateEligibility(eligible, clock.now());
    expect(result.status).toBe("eligible");
    expect(result.remainingRefundable).toEqual({ amountMinor: 12000, currency: "USD" });
  });

  // Decision table: one changed fact -> expected status and the check that explains it.
  const cases: [string, Partial<EligibilityFacts>, "eligible" | "ineligible" | "unknown", string, string][] = [
    ["unpaid order", { paymentStatus: "unpaid" }, "ineligible", "order_paid", "fail"],
    ["voided payment", { paymentStatus: "voided" }, "ineligible", "order_paid", "fail"],
    ["window expired", { refundWindow: { startsAt: "2026-09-01T12:00:00Z", days: 30 } }, "ineligible", "within_refund_window", "fail"],
    ["excluded item", { exclusions: ["final_sale"] }, "ineligible", "no_exclusion", "fail"],
    ["fully refunded", { refundedAmount: { amountMinor: 12000, currency: "USD" } }, "ineligible", "positive_refundable_balance", "fail"],
    ["unknown payment status", { paymentStatus: null }, "unknown", "order_paid", "missing"],
    ["unknown window", { refundWindow: null }, "unknown", "within_refund_window", "missing"],
    ["exclusions not checked", { exclusions: null }, "unknown", "no_exclusion", "missing"],
    ["unknown refunded total", { refundedAmount: null }, "unknown", "positive_refundable_balance", "missing"],
    ["window starts in the future", { refundWindow: { startsAt: "2026-11-01T00:00:00Z", days: 30 } }, "unknown", "within_refund_window", "conflicting"],
    ["refunds exceed payment", { refundedAmount: { amountMinor: 13000, currency: "USD" } }, "unknown", "positive_refundable_balance", "conflicting"],
    ["currency disagreement", { refundedAmount: { amountMinor: 0, currency: "EUR" } }, "unknown", "positive_refundable_balance", "conflicting"],
  ];

  it.each(cases)("%s", (_name, change, status, check, checkStatus) => {
    const result = evaluateEligibility({ ...eligible, ...change }, clock.now());
    expect(result.status).toBe(status);
    expect(result.checks[check as keyof typeof result.checks]).toBe(checkStatus);
  });

  it("lets a definite failure win over missing facts", () => {
    const result = evaluateEligibility({ ...eligible, paymentStatus: "unpaid", exclusions: null }, clock.now());
    expect(result.status).toBe("ineligible");
  });

  it("reports a partially refunded balance", () => {
    const partial = { ...eligible, refundedAmount: { amountMinor: 2000, currency: "USD" } };
    expect(evaluateEligibility(partial, clock.now()).remainingRefundable?.amountMinor).toBe(10000);
  });

  it("includes the final millisecond of the window and nothing after", () => {
    const facts = { ...eligible, refundWindow: { startsAt: "2026-10-13T12:00:00Z", days: 1 } };
    const edge = new ManualClock("2026-10-14T12:00:00Z");
    expect(evaluateEligibility(facts, edge.now()).status).toBe("eligible");
    edge.advance(1);
    expect(evaluateEligibility(facts, edge.now()).status).toBe("ineligible");
  });

  it("is deterministic for the same facts and time", () => {
    expect(evaluateEligibility(eligible, clock.now())).toEqual(evaluateEligibility(eligible, clock.now()));
  });

  it("rejects malformed facts instead of guessing", () => {
    const bad = { ...eligible, paidAmount: { amountMinor: 120.5, currency: "USD" } };
    expect(() => evaluateEligibility(bad, clock.now())).toThrow();
    expect(() => evaluateEligibility({ ...eligible, note: "eligible: yes" } as never, clock.now())).toThrow();
  });
});

import { describe, expect, it } from "vitest";
import { testApp } from "../helpers/app.js";

// End-to-end workflows with the rule-based fake planner (spec Step 6). Assertions are on ledger state and
// recorded rules, not on the plausibility of the planner's text.

describe("rule-based planner workflows", () => {
  it("R02: refunds an eligible small order once, found by lookup, and verifies the ledger", async () => {
    const t = testApp();
    const summary = await t.run("refund-small");
    expect(summary.status).toBe("completed");
    expect(summary.question).toBeNull(); // the order was found by lookup, not by asking
    expect(summary.result?.verified).toBe(true);
    expect(t.refunded(summary.id, "O-100")).toBe(2500);
    const ops = t.operations(summary.id);
    expect(ops.map((op) => [op.kind, op.status])).toEqual([
      ["refund", "verified"],
      ["resolution_note", "committed"],
    ]);
    expect(summary.result?.operationIds).toEqual(ops.map((op) => op.id));
  });

  it("R04: asks one precise question when records cannot identify the order, then resumes", async () => {
    const t = testApp();
    const waiting = await t.run("refund-ambiguous");
    expect(waiting.status).toBe("waiting_for_information");
    expect(waiting.question?.missingPreconditionIds).toEqual(["pre_target_order"]);
    expect(waiting.question?.options).toEqual(["O-301", "O-302"]);
    expect(t.operations(waiting.id)).toEqual([]); // no premature write

    t.app.answerQuestion(t.operator, { taskId: waiting.id, questionId: waiting.question?.id, answer: "It was O-302, the glasses." });
    const done = await t.app.waitForTask(t.operator, waiting.id);
    expect(done.status).toBe("completed");
    expect(t.refunded(done.id, "O-302")).toBe(1800);
    expect(t.refunded(done.id, "O-301")).toBe(0);
  });

  it("R05: refuses an ineligible refund and completes with a fact-backed no-refund resolution", async () => {
    const t = testApp();
    const summary = await t.run("refund-ineligible");
    expect(summary.status).toBe("completed");
    expect(summary.result?.outcome).toMatch(/not eligible/);
    expect(t.refunded(summary.id, "O-400")).toBe(0);
    expect(t.operations(summary.id).map((op) => op.kind)).toEqual(["resolution_note"]);
  });

  it("R14: recognizes an already completed refund and makes no further refund", async () => {
    const t = testApp();
    const summary = await t.run("refund-completed");
    expect(summary.status).toBe("completed");
    expect(summary.result?.outcome).toMatch(/already fully refunded/);
    expect(t.refunded(summary.id, "O-700")).toBe(2200);
    expect(t.operations(summary.id).filter((op) => op.kind === "refund")).toEqual([]);
  });

  it("R03: pauses a large refund for approval, and resumes to commit once after approval", async () => {
    const t = testApp();
    const waiting = await t.run("refund-large");
    expect(waiting.status).toBe("waiting_for_approval");
    expect(waiting.approval?.status).toBe("pending");
    expect(waiting.approval?.requiredRole).toBe("refund_approver");
    expect(t.operations(waiting.id)).toEqual([]);

    t.app.resolveApproval(t.operator, { taskId: waiting.id, approvalId: waiting.approval?.id, decision: "approve" });
    const done = await t.app.waitForTask(t.operator, waiting.id);
    expect(done.status).toBe("completed");
    expect(done.approval?.status).toBe("approved");
    expect(t.refunded(done.id, "O-100")).toBe(12000);
    expect(t.operations(done.id).filter((op) => op.kind === "refund")).toHaveLength(1);
  });

  it("R06: injected instructions in order notes change nothing", async () => {
    const t = testApp();
    const summary = await t.run("refund-injection");
    expect(summary.status).toBe("completed");
    expect(t.refunded(summary.id, "O-500")).toBe(2999);
    expect(t.refunded(summary.id, "O-600")).toBe(0);
  });
});

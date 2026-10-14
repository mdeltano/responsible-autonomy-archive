import { describe, expect, it } from "vitest";
import type { PlannerInput } from "../../src/agent/planner.js";
import { ScriptedPlanner } from "../../src/providers/fake.js";
import { seedScenarioInstance, type ScenarioInstance } from "../../src/storage/instances.js";
import { testApp } from "../helpers/app.js";
import { commitLatest, finish, lastResult, refund, tool } from "../helpers/planner.js";

// Spec Step 5 exit criterion: atomic execution survives acknowledgment loss (R08) and concurrent
// refunds cannot over-refund (R09), with fake planners driving the tools.

describe("R08: lost commit acknowledgment", () => {
  it("reconciles the existing operation instead of refunding again", async () => {
    const t = testApp();
    t.faults.arm("lose_ack_after_commit");
    const done = await t.run("refund-small");
    expect(done.status).toBe("completed");
    expect(t.refunded(done.id, "O-100")).toBe(2500);
    expect(t.operations(done.id).filter((op) => op.kind === "refund")).toHaveLength(1);
    const summaries = t.audit(done.id).map((e) => e.summary);
    expect(summaries.some((s) => /acknowledgment was lost; reconciliation found operation/.test(s))).toBe(true);
  });

  it("retries the same proposal after a failure that rolled back, and commits once", async () => {
    const t = testApp();
    t.faults.arm("fail_before_commit");
    const done = await t.run("refund-small");
    expect(done.status).toBe("completed");
    expect(t.refunded(done.id, "O-100")).toBe(2500);
    const refunds = t.operations(done.id).filter((op) => op.kind === "refund");
    expect(refunds).toHaveLength(1);
    expect(t.audit(done.id).filter((e) => e.type === "proposal")).toHaveLength(2); // one refund, one note
  });

  it("returns the existing operation when the planner blindly repeats a commit", async () => {
    const planner = new ScriptedPlanner([refund("O-100", 2500), commitLatest(), commitLatest(), finish(), finish()]);
    const t = testApp({ planner });
    const done = await t.run("refund-small");
    expect(t.operations(done.id).filter((op) => op.kind === "refund")).toHaveLength(1);
    expect(t.refunded(done.id, "O-100")).toBe(2500);
    expect(planner.inputs.at(-2)?.history.at(-1)).toMatchObject({ result: { status: "ok", replayed: true } });
  });
});

describe("R09: concurrent refunds on one instance", () => {
  it("lets only one of two proposals formed on the same versions spend the balance", async () => {
    let shared: ScenarioInstance | undefined;
    let proposals = 0;
    let release: () => void = () => {};
    const bothProposed = new Promise<void>((resolve) => (release = resolve));
    const racer = () =>
      new ScriptedPlanner([
        refund("O-100", 2000),
        async (input: PlannerInput) => {
          // Commit only after both tasks have proposals bound to the same record versions.
          if (++proposals === 2) release();
          await bothProposed;
          return tool("commit_refund", { proposalId: lastResult(input, "propose_refund").proposalId });
        },
        refund("O-100", 2000), // the loser re-proposes from current records
        finish(),
        finish(),
      ]);
    const t = testApp({
      planner: racer,
      instanceFor: ({ ownerId, fixture }) => (shared ??= seedScenarioInstance(t.db, { ownerId, fixture, clock: t.clock })),
    });
    const a = t.start("refund-small", "Please refund order O-100 for me.");
    const b = t.start("refund-small", "Please refund order O-100 right away.");
    await Promise.all([t.app.waitForTask(t.operator, a.id), t.app.waitForTask(t.operator, b.id)]);

    expect(t.allOperations()).toBe(1);
    expect(t.refunded(a.id, "O-100")).toBe(2000);
    const loser = [a.id, b.id].find((id) => t.operations(id).length === 0);
    if (!loser) throw new Error("expected one task without an operation");
    const decisions = t.audit(loser).filter((e) => e.type === "decision").map((e) => e.ruleIds);
    expect(decisions).toEqual([["APPROVAL_THRESHOLD"], ["AVAILABLE_BALANCE"]]);
    expect(t.audit(loser).some((e) => e.type === "execution" && e.result === "blocked")).toBe(true);
  });
});

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AppError } from "../../src/contracts/errors.js";
import { FaultInjector } from "../../src/simulator/faults.js";
import { Storefront } from "../../src/simulator/storefront.js";
import { listAuditEvents } from "../../src/storage/audit.js";
import { openDatabase } from "../../src/storage/database.js";
import { readPaymentForOrder } from "../../src/storage/records.js";
import { noRecheck, setupScenario } from "../helpers/scenario.js";

// Spec Step 3 exit criterion, exercised directly with no planner or model: commit once, reject
// over-refunding, and recover an acknowledged-as-unknown operation without repeating it.

function harness(fixtureId = "refund-small") {
  const scenario = setupScenario(fixtureId);
  const faults = new FaultInjector();
  const storefront = new Storefront(scenario.db, scenario.clock, faults);
  const refunded = () => readPaymentForOrder(scenario.db, scenario.instance.id, "O-100")?.refundedMinor;
  const operationCount = () =>
    scenario.db.prepare("SELECT COUNT(*) AS n FROM operations").get()?.n;
  const commit = (proposalId: string) => storefront.commitRefund(proposalId, { actorId: "local-operator", recheck: noRecheck });
  return { ...scenario, faults, storefront, refunded, operationCount, commit };
}

function errorOf(fn: () => unknown): AppError {
  try {
    fn();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error("expected an AppError");
}

describe("refund commit (spec Step 3 exit criterion)", () => {
  it("commits once, audits it, and verifies the ledger", () => {
    const h = harness();
    const proposalId = h.proposeRefund(2500);
    const first = h.commit(proposalId);
    expect(first.replayed).toBe(false);
    expect(h.refunded()).toBe(2500);

    const again = h.commit(proposalId);
    expect(again).toEqual({ operation: first.operation, replayed: true });
    expect(h.refunded()).toBe(2500);
    expect(h.operationCount()).toBe(1);

    const verification = h.storefront.verifyRefund(first.operation.id, "local-operator");
    expect(verification.verified).toBe(true);
    expect(verification.operation.status).toBe("verified");
    expect(listAuditEvents(h.db, h.task.id).map((e) => [e.type, e.result])).toEqual([
      ["execution", "success"],
      ["verification", "success"],
    ]);
  });

  it("rejects over-refunding without any effect", () => {
    const h = harness();
    const error = errorOf(() => h.commit(h.proposeRefund(2501)));
    expect(error.toPublic()).toMatchObject({ code: "STATE_CONFLICT", retryable: false });
    expect(h.refunded()).toBe(0);
    expect(h.operationCount()).toBe(0);
    expect(listAuditEvents(h.db, h.task.id).map((e) => e.result)).toEqual(["blocked"]);
  });

  it("recovers a lost acknowledgment without repeating the refund", () => {
    const h = harness();
    const proposalId = h.proposeRefund(2000);
    h.faults.arm("lose_ack_after_commit");
    expect(errorOf(() => h.commit(proposalId)).toPublic()).toMatchObject({ code: "TIMEOUT", retryable: true });

    // Reconcile before retrying: the operation exists and the money moved exactly once.
    const found = h.storefront.findRefundOperation(proposalId);
    expect(found?.amountMinor).toBe(2000);
    expect(h.refunded()).toBe(2000);

    // Even a blind retry with the same proposal cannot apply it twice.
    const retry = h.commit(proposalId);
    expect(retry.replayed).toBe(true);
    expect(retry.operation.id).toBe(found?.id);
    expect(h.refunded()).toBe(2000);
    expect(h.operationCount()).toBe(1);
  });
});

describe("refund commit faults and races", () => {
  it("rolls back a failure before commit, after which a retry commits once", () => {
    const h = harness();
    const proposalId = h.proposeRefund(1000);
    h.faults.arm("fail_before_commit");
    expect(errorOf(() => h.commit(proposalId)).code).toBe("INTERNAL_ERROR");
    expect(h.storefront.findRefundOperation(proposalId)).toBeNull();
    expect(h.refunded()).toBe(0);
    expect(listAuditEvents(h.db, h.task.id)).toEqual([]);

    expect(h.commit(proposalId).replayed).toBe(false);
    expect(h.refunded()).toBe(1000);
  });

  it("rejects a proposal whose records changed after it was formed", () => {
    const h = harness();
    const proposalId = h.proposeRefund(1000);
    h.faults.changeStateBeforeCommit((db) => {
      db.prepare("UPDATE payments SET refunded_minor = 500, version = version + 1 WHERE instance_id = ?").run(h.instance.id);
    });
    expect(errorOf(() => h.commit(proposalId)).toPublic()).toMatchObject({ code: "STATE_CONFLICT", retryable: true });
    expect(h.refunded()).toBe(500);
    expect(h.operationCount()).toBe(0);
  });

  it("lets only one of two concurrent proposals spend the same balance", () => {
    const h = harness("refund-large"); // 12000 paid
    const secondTask = h.newTask();
    const a = h.proposeRefund(8000);
    const b = h.proposeRefund(8000, { taskId: secondTask.id }); // formed against the same versions
    expect(h.commit(a).replayed).toBe(false);
    expect(errorOf(() => h.commit(b)).code).toBe("STATE_CONFLICT");
    expect(h.refunded()).toBe(8000);

    // A fresh proposal on current versions is still bounded by the remaining balance.
    expect(errorOf(() => h.commit(h.proposeRefund(4001, { taskId: secondTask.id }))).toPublic()).toMatchObject({
      code: "STATE_CONFLICT",
      retryable: false,
    });
    expect(h.commit(h.proposeRefund(4000, { taskId: secondTask.id })).replayed).toBe(false);
    expect(h.refunded()).toBe(12000);
  });

  it("requires the proposal to bind the payment version", () => {
    const h = harness();
    const proposalId = h.proposeRefund(1000, { stateVersions: { "O-100": 0 } });
    expect(errorOf(() => h.commit(proposalId)).message).toMatch(/payment version/);
  });

  it("aborts when the in-transaction recheck rejects", () => {
    const h = harness();
    const proposalId = h.proposeRefund(1000);
    const refuse = () => {
      throw new AppError("UNAUTHORIZED", "Gate refused on recheck");
    };
    expect(() => h.storefront.commitRefund(proposalId, { actorId: "local-operator", recheck: refuse })).toThrow(
      /Gate refused/,
    );
    expect(h.refunded()).toBe(0);
  });

  it("gives up with a retryable TIMEOUT and no effect when another connection holds the lock", () => {
    const file = join(mkdtempSync(join(tmpdir(), "ledger-")), "busy.sqlite");
    const writer = openDatabase(file, { busyTimeoutMs: 10 });
    const h = setupScenario("refund-small", writer);
    const proposalId = h.proposeRefund(1000);
    const blocker = openDatabase(file, { busyTimeoutMs: 10 });
    blocker.exec("BEGIN IMMEDIATE");
    try {
      const storefront = new Storefront(writer, h.clock);
      const error = errorOf(() => storefront.commitRefund(proposalId, { actorId: "local-operator", recheck: noRecheck }));
      expect(error.toPublic()).toMatchObject({ code: "TIMEOUT", retryable: true });
    } finally {
      blocker.exec("ROLLBACK");
    }
    expect(readPaymentForOrder(writer, h.instance.id, "O-100")?.refundedMinor).toBe(0);
    blocker.close();
    writer.close();
  });

  it("applies the lookup delay fault", async () => {
    const h = harness();
    h.faults.lookupDelayMs = 20;
    const started = performance.now();
    expect((await h.storefront.lookupOrder(h.instance.id, "O-100"))?.id).toBe("O-100");
    expect(performance.now() - started).toBeGreaterThanOrEqual(15);
  });

  it("detects a ledger that does not reconcile", () => {
    const h = harness();
    const { operation } = h.commit(h.proposeRefund(1000));
    h.db.prepare("UPDATE payments SET refunded_minor = 1500 WHERE instance_id = ?").run(h.instance.id);
    const result = h.storefront.verifyRefund(operation.id, "local-operator");
    expect(result.verified).toBe(false);
    expect(result.operation.status).toBe("committed");
  });
});

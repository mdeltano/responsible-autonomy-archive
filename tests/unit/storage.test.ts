import { describe, expect, it } from "vitest";
import { scenarioFixture } from "../../src/contracts/scenario.js";
import { AppError } from "../../src/contracts/errors.js";
import { ManualClock } from "../../src/domain/clock.js";
import { evaluateEligibility } from "../../src/domain/eligibility.js";
import { migrate, openDatabase, transaction } from "../../src/storage/database.js";
import { getScenarioInstance, instanceClock } from "../../src/storage/instances.js";
import { readProposal } from "../../src/storage/proposals.js";
import { eligibilityFactsFor, readOrder, readPaymentForOrder } from "../../src/storage/records.js";
import { getTask } from "../../src/storage/tasks.js";
import { appendAuditEvent, listAuditEvents } from "../../src/storage/audit.js";
import { fixture, fixtures, setupScenario } from "../helpers/scenario.js";

describe("migrations (spec Step 3)", () => {
  it("are recorded and safe to run again", () => {
    const db = openDatabase(":memory:");
    migrate(db);
    const versions = db.prepare("SELECT version FROM schema_migrations").all();
    expect(versions).toHaveLength(1);
  });
});

describe("scenario fixtures", () => {
  it("ship valid public scenarios", () => {
    expect([...fixtures.keys()].sort()).toEqual(["refund-large", "refund-small"]);
  });

  it("reject references that do not resolve", () => {
    const base = fixture("refund-small");
    const badScope = { ...base, scope: { customerIds: ["C-999"], orderIds: [] } };
    expect(scenarioFixture.safeParse(badScope).success).toBe(false);
    const badOrder = { ...base, orders: base.orders.map((o) => ({ ...o, customerId: "C-999" })) };
    expect(scenarioFixture.safeParse(badOrder).success).toBe(false);
    const badCurrency = { ...base, payments: base.payments.map((p) => ({ ...p, currency: "EUR" })) };
    expect(scenarioFixture.safeParse(badCurrency).success).toBe(false);
    const overRefunded = { ...base, payments: base.payments.map((p) => ({ ...p, refundedMinor: p.paidMinor + 1 })) };
    expect(scenarioFixture.safeParse(overRefunded).success).toBe(false);
  });
});

describe("scenario instances", () => {
  it("isolate each task's records", () => {
    const db = openDatabase(":memory:");
    const a = setupScenario("refund-small", db);
    const b = setupScenario("refund-small", db);
    db.prepare("UPDATE payments SET refunded_minor = 100, version = 1 WHERE instance_id = ?").run(a.instance.id);
    expect(readPaymentForOrder(db, a.instance.id, "O-100")?.refundedMinor).toBe(100);
    expect(readPaymentForOrder(db, b.instance.id, "O-100")?.refundedMinor).toBe(0);
  });

  it("hide foreign-owner instances and tasks behind NOT_FOUND", () => {
    const { db, instance, task } = setupScenario();
    expect(() => getScenarioInstance(db, instance.id, "other-owner")).toThrow(AppError);
    expect(() => getTask(db, task.id, "other-owner")).toThrow(/Resource not found/);
    expect(getTask(db, task.id, "local-owner").context.scope.customerIds).toEqual(["C-100"]);
  });

  it("run a synthetic clock from the fixture's time", () => {
    const base = new ManualClock("2026-10-13T15:00:00Z");
    const { db, instance } = setupScenario();
    const clock = instanceClock(getScenarioInstance(db, instance.id, "local-owner"), base);
    expect(new Date(clock.now()).toISOString()).toBe("2026-10-13T12:00:00.000Z");
    base.advance(60_000);
    expect(new Date(clock.now()).toISOString()).toBe("2026-10-13T12:01:00.000Z");
  });

  it("produce eligibility facts straight from records", () => {
    const { db, instance } = setupScenario();
    const order = readOrder(db, instance.id, "O-100");
    if (!order) throw new Error("missing order");
    const facts = eligibilityFactsFor(order, readPaymentForOrder(db, instance.id, "O-100"));
    expect(evaluateEligibility(facts, Date.parse("2026-10-13T12:00:00Z")).status).toBe("eligible");
    expect(evaluateEligibility(eligibilityFactsFor(order, null), Date.parse("2026-10-13T12:00:00Z")).status).toBe(
      "unknown",
    );
  });
});

describe("database constraints", () => {
  it("keep proposals immutable", () => {
    const { db, proposeRefund } = setupScenario();
    const id = proposeRefund(1000);
    expect(() => db.prepare("UPDATE proposals SET explanation = 'edited' WHERE id = ?").run(id)).toThrow(/immutable/);
    expect(() => db.prepare("DELETE FROM proposals WHERE id = ?").run(id)).toThrow(/immutable/);
    expect(readProposal(db, id)?.proposal.arguments).toMatchObject({ amountMinor: 1000 });
  });

  it("refuse to store an over-refunded payment even through raw SQL", () => {
    const { db, instance } = setupScenario();
    expect(() =>
      db.prepare("UPDATE payments SET refunded_minor = paid_minor + 1 WHERE instance_id = ?").run(instance.id),
    ).toThrow(/CHECK constraint/);
  });

  it("roll back a failed transaction completely", () => {
    const { db, instance } = setupScenario();
    expect(() =>
      transaction(db, () => {
        db.prepare("UPDATE payments SET refunded_minor = 500 WHERE instance_id = ?").run(instance.id);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(readPaymentForOrder(db, instance.id, "O-100")?.refundedMinor).toBe(0);
  });
});

describe("audit log", () => {
  it("assigns consecutive sequence numbers per task", () => {
    const { db, task } = setupScenario();
    const event = {
      taskId: task.id,
      timestamp: "2026-10-13T15:00:00Z",
      type: "lookup" as const,
      actorId: "local-operator",
      proposalId: null,
      operationId: null,
      evidenceIds: [],
      ruleIds: [],
      summary: "Looked up order O-100.",
      result: "success" as const,
    };
    expect(appendAuditEvent(db, event).sequence).toBe(0);
    expect(appendAuditEvent(db, event).sequence).toBe(1);
    expect(listAuditEvents(db, task.id).map((e) => e.sequence)).toEqual([0, 1]);
  });
});

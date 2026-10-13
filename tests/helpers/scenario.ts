import { createHash } from "node:crypto";
import { loadConfig } from "../../src/config.js";
import type { ActionProposal } from "../../src/contracts/canonical.js";
import type { ScenarioFixture } from "../../src/contracts/scenario.js";
import { bindTaskContext, createCallerIdentity } from "../../src/domain/authorization.js";
import { ManualClock, toUtcTimestamp } from "../../src/domain/clock.js";
import { newId } from "../../src/domain/ids.js";
import { loadFixtureDirectory } from "../../src/simulator/fixture.js";
import { openDatabase, type Database } from "../../src/storage/database.js";
import { createScenarioInstance } from "../../src/storage/instances.js";
import { insertProposal } from "../../src/storage/proposals.js";
import { readOrder, readPaymentForOrder } from "../../src/storage/records.js";
import { createTask } from "../../src/storage/tasks.js";

export const fixtures = loadFixtureDirectory("fixtures/public");

export function fixture(id: string): ScenarioFixture {
  const found = fixtures.get(id);
  if (!found) throw new Error(`No fixture ${id}`);
  return found;
}

// A database with one scenario instance and one task, plus a factory for refund proposals bound to
// the current record versions. Proposal digests are placeholders until the gate computes them (Step 4).
export function setupScenario(fixtureId = "refund-small", db: Database = openDatabase(":memory:")) {
  const clock = new ManualClock("2026-10-13T15:00:00Z");
  const identity = createCallerIdentity(loadConfig({}));
  const scenario = fixture(fixtureId);
  const instance = createScenarioInstance(db, { ownerId: identity.ownerId, fixture: scenario, clock });
  const context = bindTaskContext(identity, scenario.scope);

  const newTask = () =>
    createTask(db, {
      ownerId: identity.ownerId,
      instanceId: instance.id,
      scenarioId: scenario.id,
      goal: "Please refund my damaged order",
      inputHash: "input-hash",
      context,
      budgets: {},
      now: toUtcTimestamp(clock.now()),
    });
  const task = newTask();

  const proposeRefund = (
    amountMinor: number,
    options: { orderId?: string; taskId?: string; stateVersions?: Record<string, number> } = {},
  ): string => {
    const orderId = options.orderId ?? "O-100";
    const order = readOrder(db, instance.id, orderId);
    const payment = readPaymentForOrder(db, instance.id, orderId);
    if (!order || !payment) throw new Error(`No order/payment ${orderId}`);
    const id = newId("prop");
    const proposal: ActionProposal = {
      id,
      taskId: options.taskId ?? task.id,
      tool: "commit_refund",
      targetId: orderId,
      arguments: { orderId, amountMinor, currency: order.currency, reason: "Item arrived damaged" },
      evidenceIds: [],
      preconditions: [{ id: "pre_eligible", description: "Order is eligible", status: "satisfied" }],
      policyVersion: "refund-policy.v1",
      stateVersions: options.stateVersions ?? { [order.id]: order.version, [payment.id]: payment.version },
      actionDigest: createHash("sha256").update(id).digest("hex"),
      decision: "AUTO_EXECUTE",
      ruleIds: [],
      explanation: "Test proposal.",
    };
    insertProposal(db, { proposal, context, createdAt: toUtcTimestamp(clock.now()) });
    return id;
  };

  return { db, clock, identity, instance, context, task, newTask, proposeRefund };
}

export const noRecheck = () => {};

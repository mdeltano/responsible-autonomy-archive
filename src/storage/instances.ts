import { notFound } from "../contracts/errors.js";
import { parseUtcTimestamp, toUtcTimestamp, type Clock } from "../domain/clock.js";
import { newId } from "../domain/ids.js";
import type { ScenarioFixture } from "../contracts/scenario.js";
import { transaction, type Database } from "./database.js";
import { int, text } from "./rows.js";

// Scenario instances (spec Step 3): each task gets its own isolated copy of a fixture's records.

export interface ScenarioInstance {
  id: string;
  ownerId: string;
  fixtureId: string;
  fixtureVersion: number;
  syntheticStart: string;
  createdAt: string;
}

export function createScenarioInstance(
  db: Database,
  input: { ownerId: string; fixture: ScenarioFixture; clock: Clock },
): ScenarioInstance {
  const { fixture } = input;
  const instance: ScenarioInstance = {
    id: newId("inst"),
    ownerId: input.ownerId,
    fixtureId: fixture.id,
    fixtureVersion: fixture.version,
    syntheticStart: fixture.syntheticNow,
    createdAt: toUtcTimestamp(input.clock.now()),
  };
  transaction(db, () => {
    db.prepare(
      `INSERT INTO scenario_instances (id, owner_id, fixture_id, fixture_version, synthetic_start, created_at)
       VALUES (:id, :ownerId, :fixtureId, :fixtureVersion, :syntheticStart, :createdAt)`,
    ).run({ ...instance });
    const insertCustomer = db.prepare(
      `INSERT INTO customers (instance_id, id, display_name, email, version) VALUES (?, ?, ?, ?, 0)`,
    );
    for (const c of fixture.customers) insertCustomer.run(instance.id, c.id, c.displayName, c.email);
    const insertOrder = db.prepare(
      `INSERT INTO orders (instance_id, id, customer_id, currency, payment_status, refund_window_starts_at,
         refund_window_days, exclusions_json, notes, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    );
    for (const o of fixture.orders) {
      insertOrder.run(
        instance.id,
        o.id,
        o.customerId,
        o.currency,
        o.paymentStatus,
        o.refundWindow?.startsAt ?? null,
        o.refundWindow?.days ?? null,
        o.exclusions === null ? null : JSON.stringify(o.exclusions),
        o.notes,
      );
    }
    const insertPayment = db.prepare(
      `INSERT INTO payments (instance_id, id, order_id, destination, currency, paid_minor, fixture_refunded_minor,
         refunded_minor, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    );
    for (const p of fixture.payments) {
      insertPayment.run(instance.id, p.id, p.orderId, p.destination, p.currency, p.paidMinor, p.refundedMinor, p.refundedMinor);
    }
  });
  return instance;
}

// Unknown and foreign-owner instances are indistinguishable (spec §Security and privacy).
export function getScenarioInstance(db: Database, id: string, ownerId: string): ScenarioInstance {
  const row = db.prepare("SELECT * FROM scenario_instances WHERE id = ?").get(id);
  if (!row || text(row, "owner_id") !== ownerId) throw notFound();
  return {
    id: text(row, "id"),
    ownerId: text(row, "owner_id"),
    fixtureId: text(row, "fixture_id"),
    fixtureVersion: int(row, "fixture_version"),
    syntheticStart: text(row, "synthetic_start"),
    createdAt: text(row, "created_at"),
  };
}

// The instance's synthetic clock: fixture time at creation plus time elapsed on the injected clock.
export function instanceClock(instance: ScenarioInstance, base: Clock): Clock {
  const offset = parseUtcTimestamp(instance.syntheticStart) - parseUtcTimestamp(instance.createdAt);
  return { now: () => base.now() + offset };
}

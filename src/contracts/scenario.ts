import { z } from "zod";
import { customerScope } from "./caller-context.js";
import {
  boundedList,
  boundedText,
  currencyCode,
  minorUnits,
  narrative,
  nonEmptyNarrative,
  opaqueId,
  positiveMinorUnits,
  utcTimestamp,
} from "./primitives.js";

// Synthetic scenario fixtures (spec §Version 1 scope, Step 3). A fixture is trusted operator data:
// its `scope` becomes the task's CallerContext scope. Record fields such as `notes` are untrusted
// content that the agent may read but that can never expand scope or override policy.
// fixtures/public holds these model-visible scenarios; hidden expected outcomes live elsewhere.

const customer = z.strictObject({
  id: opaqueId,
  displayName: boundedText(1, 200),
  email: boundedText(3, 254),
});

const order = z.strictObject({
  id: opaqueId,
  customerId: opaqueId,
  currency: currencyCode,
  // null marks a fact the scenario deliberately leaves unknown.
  paymentStatus: z.enum(["paid", "unpaid", "voided"]).nullable(),
  refundWindow: z.strictObject({ startsAt: utcTimestamp, days: positiveMinorUnits }).nullable(),
  exclusions: z.array(boundedText(1, 64)).max(20).nullable(),
  notes: narrative,
});

const payment = z
  .strictObject({
    id: opaqueId,
    orderId: opaqueId,
    // The original destination, the only place a refund may go (spec §Policy rules).
    destination: boundedText(1, 128),
    currency: currencyCode,
    paidMinor: minorUnits,
    refundedMinor: minorUnits,
  })
  .refine((p) => p.refundedMinor <= p.paidMinor, { message: "refundedMinor exceeds paidMinor" });

export const scenarioFixture = z
  .strictObject({
    id: opaqueId,
    version: positiveMinorUnits,
    title: boundedText(1, 120),
    description: nonEmptyNarrative,
    // Example goal offered by the demo. Goals are untrusted text however they are written.
    suggestedGoal: boundedText(10, 4000).optional(),
    // The synthetic "now" when an instance is created; it then advances with the injected clock.
    syntheticNow: utcTimestamp,
    scope: customerScope,
    customers: boundedList(customer).min(1),
    orders: boundedList(order),
    payments: boundedList(payment),
  })
  .superRefine((f, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
    const unique = (ids: string[], path: string) => {
      if (new Set(ids).size !== ids.length) issue([path], "IDs must be unique");
    };
    unique(f.customers.map((c) => c.id), "customers");
    unique(f.orders.map((o) => o.id), "orders");
    unique(f.payments.map((p) => p.id), "payments");

    const customers = new Set(f.customers.map((c) => c.id));
    const orders = new Map(f.orders.map((o) => [o.id, o]));
    f.scope.customerIds.forEach((id, i) => {
      if (!customers.has(id)) issue(["scope", "customerIds", i], `unknown customer ${id}`);
    });
    f.scope.orderIds.forEach((id, i) => {
      if (!orders.has(id)) issue(["scope", "orderIds", i], `unknown order ${id}`);
    });
    f.orders.forEach((o, i) => {
      if (!customers.has(o.customerId)) issue(["orders", i, "customerId"], `unknown customer ${o.customerId}`);
    });
    const paidOrders = new Set<string>();
    f.payments.forEach((p, i) => {
      const target = orders.get(p.orderId);
      if (!target) issue(["payments", i, "orderId"], `unknown order ${p.orderId}`);
      else if (target.currency !== p.currency) issue(["payments", i, "currency"], "must match the order currency");
      if (paidOrders.has(p.orderId)) issue(["payments", i, "orderId"], "an order has at most one payment");
      paidOrders.add(p.orderId);
    });
  });
export type ScenarioFixture = z.infer<typeof scenarioFixture>;

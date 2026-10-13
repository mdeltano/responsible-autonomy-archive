import type { Database } from "./database.js";
import { int, jsonOrNull, text, textOrNull } from "./rows.js";

// Read access to synthetic storefront records within one scenario instance (spec Step 3). Every record
// carries its version so evidence can cite it and stale proposals can be detected. Callers apply scope
// checks; these readers only select by instance and ID.

export interface CustomerRecord {
  id: string;
  displayName: string;
  email: string;
  version: number;
}

export interface OrderRecord {
  id: string;
  customerId: string;
  currency: string;
  paymentStatus: "paid" | "unpaid" | "voided" | null;
  refundWindow: { startsAt: string; days: number } | null;
  exclusions: string[] | null;
  // Untrusted free text: data for the agent to read, never instructions.
  notes: string;
  version: number;
}

export interface PaymentRecord {
  id: string;
  orderId: string;
  destination: string;
  currency: string;
  paidMinor: number;
  fixtureRefundedMinor: number;
  refundedMinor: number;
  version: number;
}

export function readCustomer(db: Database, instanceId: string, customerId: string): CustomerRecord | null {
  const row = db.prepare("SELECT * FROM customers WHERE instance_id = ? AND id = ?").get(instanceId, customerId);
  if (!row) return null;
  return {
    id: text(row, "id"),
    displayName: text(row, "display_name"),
    email: text(row, "email"),
    version: int(row, "version"),
  };
}

export function readOrder(db: Database, instanceId: string, orderId: string): OrderRecord | null {
  const row = db.prepare("SELECT * FROM orders WHERE instance_id = ? AND id = ?").get(instanceId, orderId);
  if (!row) return null;
  const startsAt = textOrNull(row, "refund_window_starts_at");
  return {
    id: text(row, "id"),
    customerId: text(row, "customer_id"),
    currency: text(row, "currency"),
    paymentStatus: textOrNull(row, "payment_status") as OrderRecord["paymentStatus"],
    refundWindow: startsAt === null ? null : { startsAt, days: int(row, "refund_window_days") },
    exclusions: jsonOrNull<string[]>(row, "exclusions_json"),
    notes: text(row, "notes"),
    version: int(row, "version"),
  };
}

export function readPaymentForOrder(db: Database, instanceId: string, orderId: string): PaymentRecord | null {
  const row = db.prepare("SELECT * FROM payments WHERE instance_id = ? AND order_id = ?").get(instanceId, orderId);
  if (!row) return null;
  return {
    id: text(row, "id"),
    orderId: text(row, "order_id"),
    destination: text(row, "destination"),
    currency: text(row, "currency"),
    paidMinor: int(row, "paid_minor"),
    fixtureRefundedMinor: int(row, "fixture_refunded_minor"),
    refundedMinor: int(row, "refunded_minor"),
    version: int(row, "version"),
  };
}

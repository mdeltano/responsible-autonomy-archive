import type { ActionProposal } from "../contracts/canonical.js";
import { AppError, notFound } from "../contracts/errors.js";
import { newId } from "../domain/ids.js";
import { appendAuditEvent } from "./audit.js";
import { transaction, type Database } from "./database.js";
import { readProposal } from "./proposals.js";
import { readOrder, readPaymentForOrder, type OrderRecord, type PaymentRecord } from "./records.js";
import { int, intOrNull, text, textOrNull } from "./rows.js";

// Synthetic refund ledger (spec Step 3, §Policy rules). A refund commit is one transaction that
// rechecks state, inserts the operation under its proposal-scoped idempotency key, updates the payment
// with a conditional version check, and writes the audit event. A retry with the same proposal returns
// the existing operation instead of applying the refund again.

export interface Operation {
  id: string;
  instanceId: string;
  taskId: string;
  proposalId: string;
  idempotencyKey: string;
  kind: "refund" | "resolution_note";
  orderId: string;
  amountMinor: number | null;
  currency: string | null;
  status: "committed" | "verified";
  committedAt: string;
  verifiedAt: string | null;
}

// The key derives from the immutable proposal, so no caller (least of all the planner) can mint a
// fresh key to get around duplicate prevention.
export function refundIdempotencyKey(proposalId: string): string {
  return `refund:${proposalId}`;
}

function toOperation(row: Record<string, unknown>): Operation {
  return {
    id: text(row, "id"),
    instanceId: text(row, "instance_id"),
    taskId: text(row, "task_id"),
    proposalId: text(row, "proposal_id"),
    idempotencyKey: text(row, "idempotency_key"),
    kind: text(row, "kind") as Operation["kind"],
    orderId: text(row, "order_id"),
    amountMinor: intOrNull(row, "amount_minor"),
    currency: textOrNull(row, "currency"),
    status: text(row, "status") as Operation["status"],
    committedAt: text(row, "committed_at"),
    verifiedAt: textOrNull(row, "verified_at"),
  };
}

export function readOperation(db: Database, id: string): Operation | null {
  const row = db.prepare("SELECT * FROM operations WHERE id = ?").get(id);
  return row ? toOperation(row) : null;
}

export function readOperationByKey(db: Database, instanceId: string, key: string): Operation | null {
  const row = db.prepare("SELECT * FROM operations WHERE instance_id = ? AND idempotency_key = ?").get(instanceId, key);
  return row ? toOperation(row) : null;
}

export function instanceOfTask(db: Database, taskId: string): string {
  const row = db.prepare("SELECT instance_id FROM tasks WHERE id = ?").get(taskId);
  if (!row) throw notFound(taskId);
  return text(row, "instance_id");
}

export interface CommitState {
  proposal: ActionProposal;
  order: OrderRecord;
  payment: PaymentRecord;
}

export interface CommitHooks {
  // Re-evaluates authorization and policy against current state inside the transaction. Required so
  // that no caller can commit without deciding how to recheck; the gate supplies it from Step 5.
  recheck: (state: CommitState) => void;
  // Test-harness fault point: runs after the writes and before COMMIT.
  beforeCommit?: () => void;
}

export interface CommitResult {
  operation: Operation;
  // True when the proposal had already been committed and nothing new was applied.
  replayed: boolean;
}

const conflict = (message: string, taskId: string, retryable: boolean) =>
  new AppError("STATE_CONFLICT", message, { taskId, retryable });

export function commitRefund(
  db: Database,
  input: { proposalId: string; actorId: string; now: string },
  hooks: CommitHooks,
): CommitResult {
  return transaction(db, () => {
    const stored = readProposal(db, input.proposalId);
    if (!stored) throw notFound();
    const { proposal } = stored;
    if (proposal.tool !== "commit_refund") {
      throw new AppError("INVALID_INPUT", "Proposal is not a refund", { taskId: proposal.taskId });
    }
    const instanceId = instanceOfTask(db, proposal.taskId);

    const existing = readOperationByKey(db, instanceId, refundIdempotencyKey(proposal.id));
    if (existing) return { operation: existing, replayed: true };

    const args = proposal.arguments;
    const order = readOrder(db, instanceId, args.orderId);
    const payment = readPaymentForOrder(db, instanceId, args.orderId);
    if (!order || !payment) throw conflict("Order or payment record not found", proposal.taskId, false);
    if (args.currency !== order.currency || args.currency !== payment.currency) {
      throw conflict("Refund currency does not match the order", proposal.taskId, false);
    }
    // Versions the proposal was formed against must still be current (time-of-check/time-of-use).
    const boundPayment = proposal.stateVersions[payment.id];
    if (boundPayment === undefined) throw conflict("Proposal does not bind the payment version", proposal.taskId, false);
    const boundOrder = proposal.stateVersions[order.id];
    if (boundPayment !== payment.version || (boundOrder !== undefined && boundOrder !== order.version)) {
      throw conflict("Records changed since the proposal was formed", proposal.taskId, true);
    }
    if (args.amountMinor > payment.paidMinor - payment.refundedMinor) {
      throw conflict("Refund exceeds the remaining refundable balance", proposal.taskId, false);
    }
    hooks.recheck({ proposal, order, payment });

    const operation: Operation = {
      id: newId("op"),
      instanceId,
      taskId: proposal.taskId,
      proposalId: proposal.id,
      idempotencyKey: refundIdempotencyKey(proposal.id),
      kind: "refund",
      orderId: order.id,
      amountMinor: args.amountMinor,
      currency: args.currency,
      status: "committed",
      committedAt: input.now,
      verifiedAt: null,
    };
    db.prepare(
      `INSERT INTO operations (id, instance_id, task_id, proposal_id, idempotency_key, kind, order_id, amount_minor,
         currency, status, committed_at, verified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(
      operation.id,
      operation.instanceId,
      operation.taskId,
      operation.proposalId,
      operation.idempotencyKey,
      operation.kind,
      operation.orderId,
      operation.amountMinor,
      operation.currency,
      operation.status,
      operation.committedAt,
    );
    const update = db
      .prepare(
        `UPDATE payments SET refunded_minor = refunded_minor + ?, version = version + 1
         WHERE instance_id = ? AND id = ? AND version = ?`,
      )
      .run(args.amountMinor, instanceId, payment.id, payment.version);
    if (update.changes !== 1) throw conflict("Payment changed during commit", proposal.taskId, true);

    appendAuditEvent(db, {
      taskId: proposal.taskId,
      timestamp: input.now,
      type: "execution",
      actorId: input.actorId,
      proposalId: proposal.id,
      operationId: operation.id,
      evidenceIds: proposal.evidenceIds,
      ruleIds: proposal.ruleIds,
      summary: `Refunded ${args.amountMinor} ${args.currency} minor units on order ${order.id} to the original payment.`,
      result: "success",
    });
    hooks.beforeCommit?.();
    return { operation, replayed: false };
  });
}

export interface VerificationResult {
  operation: Operation;
  verified: boolean;
}

// Reads the ledger back and checks that the payment's refunded total equals the fixture baseline plus
// every refund operation on the order. Only a consistent ledger marks the operation verified.
export function verifyRefund(db: Database, input: { operationId: string; actorId: string; now: string }): VerificationResult {
  return transaction(db, () => {
    const operation = readOperation(db, input.operationId);
    if (!operation || operation.kind !== "refund") throw notFound();
    const payment = readPaymentForOrder(db, operation.instanceId, operation.orderId);
    const sumRow = db
      .prepare(
        `SELECT COALESCE(SUM(amount_minor), 0) AS total FROM operations
         WHERE instance_id = ? AND order_id = ? AND kind = 'refund'`,
      )
      .get(operation.instanceId, operation.orderId);
    const total = int(sumRow ?? {}, "total");
    const verified = payment !== null && payment.refundedMinor === payment.fixtureRefundedMinor + total;

    let result = operation;
    if (verified && operation.status === "committed") {
      db.prepare("UPDATE operations SET status = 'verified', verified_at = ? WHERE id = ?").run(input.now, operation.id);
      result = { ...operation, status: "verified", verifiedAt: input.now };
    }
    appendAuditEvent(db, {
      taskId: operation.taskId,
      timestamp: input.now,
      type: "verification",
      actorId: input.actorId,
      proposalId: operation.proposalId,
      operationId: operation.id,
      evidenceIds: [],
      ruleIds: [],
      summary: verified
        ? `Ledger confirms refund operation ${operation.id}.`
        : `Ledger does not reconcile for refund operation ${operation.id}.`,
      result: verified ? "success" : "failure",
    });
    return { operation: result, verified };
  });
}

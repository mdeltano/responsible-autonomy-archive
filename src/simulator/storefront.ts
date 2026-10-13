import { setTimeout as delay } from "node:timers/promises";
import { AppError } from "../contracts/errors.js";
import { toUtcTimestamp, type Clock } from "../domain/clock.js";
import { appendAuditEvent } from "../storage/audit.js";
import type { Database } from "../storage/database.js";
import {
  commitRefund,
  instanceOfTask,
  readOperationByKey,
  refundIdempotencyKey,
  verifyRefund,
  type CommitHooks,
  type CommitResult,
  type Operation,
  type VerificationResult,
} from "../storage/ledger.js";
import { readProposal } from "../storage/proposals.js";
import {
  readCustomer,
  readOrder,
  readPaymentForOrder,
  type CustomerRecord,
  type OrderRecord,
  type PaymentRecord,
} from "../storage/records.js";
import type { FaultInjector } from "./faults.js";

// Synthetic storefront adapter (spec Step 3, §Architecture). It never contacts a real storefront or
// payment system. Scope and policy checks belong to the gate; this adapter performs the effects.

export class Storefront {
  readonly #db: Database;
  readonly #clock: Clock;
  readonly #faults: FaultInjector | undefined;

  constructor(db: Database, clock: Clock, faults?: FaultInjector) {
    this.#db = db;
    this.#clock = clock;
    this.#faults = faults;
  }

  async lookupCustomer(instanceId: string, customerId: string): Promise<CustomerRecord | null> {
    await this.#lookupFaults();
    return readCustomer(this.#db, instanceId, customerId);
  }

  async lookupOrder(instanceId: string, orderId: string): Promise<OrderRecord | null> {
    await this.#lookupFaults();
    return readOrder(this.#db, instanceId, orderId);
  }

  async lookupPayment(instanceId: string, orderId: string): Promise<PaymentRecord | null> {
    await this.#lookupFaults();
    return readPaymentForOrder(this.#db, instanceId, orderId);
  }

  // Commits the refund described by an immutable proposal. Any error other than a STATE_CONFLICT
  // leaves the outcome to be reconciled with findRefundOperation before anything is retried.
  commitRefund(proposalId: string, input: { actorId: string; recheck: CommitHooks["recheck"] }): CommitResult {
    this.#faults?.applyStateChanges(this.#db);
    const now = toUtcTimestamp(this.#clock.now());
    let result: CommitResult;
    try {
      result = commitRefund(this.#db, { proposalId, actorId: input.actorId, now }, {
        recheck: input.recheck,
        beforeCommit: () => {
          if (this.#faults?.take("fail_before_commit")) {
            throw new AppError("INTERNAL_ERROR", "Simulated failure before commit", { retryable: true });
          }
        },
      });
    } catch (error) {
      if (error instanceof AppError && error.code === "STATE_CONFLICT") this.#auditBlocked(proposalId, error, now, input.actorId);
      throw error;
    }
    if (this.#faults?.take("lose_ack_after_commit")) {
      // The transaction committed, but the caller cannot know that.
      throw new AppError("TIMEOUT", "Commit acknowledgment lost; outcome unknown", { retryable: true });
    }
    return result;
  }

  // Reconciliation after an unknown outcome: the operation, if one was committed for this proposal.
  findRefundOperation(proposalId: string): Operation | null {
    const stored = readProposal(this.#db, proposalId);
    if (!stored) return null;
    const instanceId = instanceOfTask(this.#db, stored.proposal.taskId);
    return readOperationByKey(this.#db, instanceId, refundIdempotencyKey(proposalId));
  }

  verifyRefund(operationId: string, actorId: string): VerificationResult {
    return verifyRefund(this.#db, { operationId, actorId, now: toUtcTimestamp(this.#clock.now()) });
  }

  async #lookupFaults(): Promise<void> {
    if (this.#faults && this.#faults.lookupDelayMs > 0) await delay(this.#faults.lookupDelayMs);
  }

  // Rejected commits roll back, so their audit event is written in a separate transaction afterwards.
  #auditBlocked(proposalId: string, error: AppError, now: string, actorId: string): void {
    const stored = readProposal(this.#db, proposalId);
    if (!stored) return;
    appendAuditEvent(this.#db, {
      taskId: stored.proposal.taskId,
      timestamp: now,
      type: "execution",
      actorId,
      proposalId,
      operationId: null,
      evidenceIds: [],
      ruleIds: stored.proposal.ruleIds,
      summary: `Refund blocked: ${error.message}`,
      result: "blocked",
    });
  }
}

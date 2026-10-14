import type { CallerContext } from "../contracts/caller-context.js";
import type { ActionProposal, Approval, Evidence } from "../contracts/canonical.js";
import { AppError, type ErrorCode } from "../contracts/errors.js";
import type { ToolArguments, ToolCall } from "../contracts/planner.js";
import type { RefundPolicy } from "../contracts/policy.js";
import { APPROVAL_PROBLEM_TEXT, approvalProblems, type ApprovalProblem } from "../domain/approvals.js";
import { canAccessCustomer, canAccessOrder } from "../domain/authorization.js";
import { toUtcTimestamp, type Clock } from "../domain/clock.js";
import { actionDigest } from "../domain/digest.js";
import { evaluateEligibility, factsFromRecords } from "../domain/eligibility.js";
import { evaluateAction, type GateAction, type GateResult, type PriorOperation } from "../domain/gate.js";
import { newId } from "../domain/ids.js";
import type { Storefront } from "../simulator/storefront.js";
import { insertApproval, invalidateApproval, readApprovalForProposal } from "../storage/approvals.js";
import { appendAuditEvent, type NewAuditEvent } from "../storage/audit.js";
import { transaction, type Database } from "../storage/database.js";
import { insertEvidence, recentEvidenceFor } from "../storage/evidence.js";
import {
  beginCommitAttempt,
  commitResolutionNote,
  listInFlightAttempts,
  listTaskOperations,
  readOperation,
  readOperationByKey,
  refundIdempotencyKey,
  resolveCommitAttempt,
  type Operation,
} from "../storage/ledger.js";
import { insertProposal, readProposal } from "../storage/proposals.js";
import {
  listOrderIdsForCustomer,
  readOrder,
  readPaymentForOrder,
  type OrderRecord,
  type PaymentRecord,
} from "../storage/records.js";
import type { TaskRecord } from "../storage/tasks.js";

// Tool registry (spec §Internal agent tools, Step 5, Step 6). Every planner tool call is dispatched
// here, and every one passes through scope checks; mutating tools pass through the gate twice, once to
// form the proposal and again inside the commit transaction. Results are plain data for the planner.
// Unknown and out-of-scope records produce the same NOT_FOUND result.

// Audit actor for actions the engine takes on the planner's behalf. Operator actions use the
// operator's actorId instead, so the log separates what the agent did from what a human decided.
export const AGENT_ACTOR = "agent";

export interface EngineDeps {
  db: Database;
  // Real time: approvals, questions, audit timestamps. Eligibility uses the instance's synthetic clock.
  clock: Clock;
  policy: RefundPolicy;
  storefront: Storefront;
  approvalTtlMs: number;
}

export interface TaskScope {
  task: TaskRecord;
  syntheticClock: Clock;
}

export interface ToolExecution {
  result: Record<string, unknown>;
  // Set when the task must wait for an operator decision before it can continue.
  pause: { approvalId: string } | null;
  // A record was read or an operation committed.
  usefulWork: boolean;
  // The gate refused a refund proposal, or a lookup was refused for scope.
  refusal: boolean;
}

const notFoundResult = (): Record<string, unknown> => ({
  status: "error",
  error: { code: "NOT_FOUND", message: "Resource not found" },
});

const errorResult = (code: ErrorCode, message: string, extra: Record<string, unknown> = {}) => ({
  status: "error",
  error: { code, message },
  ...extra,
});

function execution(result: Record<string, unknown>, flags: Partial<Omit<ToolExecution, "result">> = {}): ToolExecution {
  return { result, pause: null, usefulWork: false, refusal: false, ...flags };
}

function now(deps: EngineDeps): string {
  return toUtcTimestamp(deps.clock.now());
}

function audit(deps: EngineDeps, scope: TaskScope, event: Omit<NewAuditEvent, "taskId" | "timestamp" | "actorId">): void {
  appendAuditEvent(deps.db, { taskId: scope.task.id, timestamp: now(deps), actorId: AGENT_ACTOR, ...event });
}

function recordEvidence(
  deps: EngineDeps,
  scope: TaskScope,
  input: Pick<Evidence, "sourceId" | "recordVersion" | "statement" | "supportsPreconditionIds">,
): string {
  const id = newId("ev");
  insertEvidence(deps.db, { id, taskId: scope.task.id, kind: "record", observedAt: now(deps), ...input });
  return id;
}

function context(scope: TaskScope): CallerContext {
  return scope.task.context;
}

function scopedOrder(deps: EngineDeps, scope: TaskScope, orderId: string): OrderRecord | null {
  const order = readOrder(deps.db, scope.task.instanceId, orderId);
  if (!order || !canAccessOrder(context(scope), { orderId: order.id, customerId: order.customerId })) return null;
  return order;
}

function refusedLookup(deps: EngineDeps, scope: TaskScope, what: string): ToolExecution {
  audit(deps, scope, {
    type: "lookup",
    proposalId: null,
    operationId: null,
    evidenceIds: [],
    ruleIds: ["ORDER_SCOPE"],
    summary: `Lookup of a ${what} refused: the record is not available to this caller.`,
    result: "blocked",
  });
  return execution(notFoundResult(), { refusal: true });
}

// Earlier operations by this task on the order. A commit attempt still in flight with no operation
// is an unknown outcome, which the gate sends to reconciliation (spec §Policy rules).
export function priorOperations(db: Database, taskId: string, orderId: string, excludeProposalId?: string): PriorOperation[] {
  const operations = listTaskOperations(db, taskId).filter((op) => op.orderId === orderId);
  const prior: PriorOperation[] = operations.map((op) => ({ kind: op.kind, status: op.status }));
  for (const proposalId of listInFlightAttempts(db, taskId)) {
    if (proposalId === excludeProposalId || operations.some((op) => op.proposalId === proposalId)) continue;
    const stored = readProposal(db, proposalId);
    if (stored?.proposal.arguments.orderId === orderId) prior.push({ kind: "refund", status: "unknown" });
  }
  return prior;
}

function gateFor(
  deps: EngineDeps,
  scope: TaskScope,
  action: GateAction,
  records: { order: OrderRecord | null; payment: PaymentRecord | null },
  excludeProposalId?: string,
): GateResult {
  const state = {
    order: records.order,
    payment: records.payment,
    priorOperations: priorOperations(deps.db, scope.task.id, action.arguments.orderId, excludeProposalId),
    now: scope.syntheticClock.now(),
  };
  return evaluateAction(context(scope), action, state, deps.policy);
}

function digestFor(scope: TaskScope, action: GateAction, policyVersion: string, stateVersions: Record<string, number>): string {
  return actionDigest({
    tool: action.tool,
    arguments: action.arguments,
    targetId: action.arguments.orderId,
    context: context(scope),
    policyVersion,
    stateVersions,
  });
}

const DECISION_RESULT = {
  AUTO_EXECUTE: "success",
  HUMAN_APPROVAL: "pending",
  VERIFY_FIRST: "blocked",
  REFUSE: "blocked",
} as const;

// Forms and stores an immutable proposal for the exact action, decided by the gate.
function propose(deps: EngineDeps, scope: TaskScope, action: GateAction): { proposal: ActionProposal; gate: GateResult } {
  const orderId = action.arguments.orderId;
  const order = readOrder(deps.db, scope.task.instanceId, orderId);
  const payment = readPaymentForOrder(deps.db, scope.task.instanceId, orderId);
  const gate = gateFor(deps, scope, action, { order, payment });
  // Evidence is only cited for an order the caller may see; a refused order cites nothing.
  const sources = gate.ruleIds.includes("ORDER_SCOPE") || !order ? [] : [order.id, order.customerId, ...(payment ? [payment.id] : [])];
  const evidenceIds = recentEvidenceFor(deps.db, scope.task.id, sources).map((e) => e.id);
  const base = {
    id: newId("prop"),
    taskId: scope.task.id,
    targetId: orderId,
    evidenceIds,
    preconditions: gate.preconditions,
    policyVersion: deps.policy.version,
    stateVersions: gate.stateVersions,
    actionDigest: digestFor(scope, action, deps.policy.version, gate.stateVersions),
    decision: gate.decision,
    ruleIds: gate.ruleIds,
    explanation: gate.explanation,
  };
  const proposal: ActionProposal =
    action.tool === "commit_refund"
      ? { ...base, tool: "commit_refund", arguments: action.arguments }
      : { ...base, tool: "record_resolution", arguments: action.arguments };
  transaction(deps.db, () => {
    insertProposal(deps.db, { proposal, context: context(scope), createdAt: now(deps) });
    audit(deps, scope, {
      type: "proposal",
      proposalId: proposal.id,
      operationId: null,
      evidenceIds,
      ruleIds: [],
      summary:
        action.tool === "commit_refund"
          ? `Proposed refund of ${action.arguments.amountMinor} ${action.arguments.currency} minor units on order ${orderId}.`
          : `Proposed a resolution note on order ${orderId}.`,
      result: "pending",
    });
    audit(deps, scope, {
      type: "decision",
      proposalId: proposal.id,
      operationId: null,
      evidenceIds,
      ruleIds: gate.ruleIds,
      summary: `Gate decision ${gate.decision}: ${gate.explanation}`.slice(0, 2000),
      result: DECISION_RESULT[gate.decision],
    });
  });
  return { proposal, gate };
}

function proposalResult(proposal: ActionProposal, gate: GateResult): Record<string, unknown> {
  return {
    status: "ok",
    proposalId: proposal.id,
    decision: gate.decision,
    ruleIds: gate.ruleIds,
    explanation: gate.explanation,
    missingPreconditionIds: gate.missingPreconditionIds,
  };
}

function operationData(op: Operation): Record<string, unknown> {
  return {
    operationId: op.id,
    proposalId: op.proposalId,
    kind: op.kind,
    orderId: op.orderId,
    amountMinor: op.amountMinor,
    currency: op.currency,
    operationStatus: op.status,
  };
}

// Why a stored proposal can no longer be executed as formed: changed records, a changed decision, a
// changed policy, or an approval that does not authorize it. Null when it can proceed. Used before a
// commit, inside the commit transaction, and when an operator tries to approve.
export interface ProposalProblem {
  code: "STATE_CONFLICT" | "APPROVAL_EXPIRED";
  message: string;
  // True when the facts changed and a new proposal may succeed; false when this proposal is blocked.
  stale: boolean;
}

export function assessStoredProposal(
  deps: EngineDeps,
  scope: TaskScope,
  proposal: ActionProposal,
  records: { order: OrderRecord | null; payment: PaymentRecord | null },
  options: { requireApproval: boolean },
): ProposalProblem | null {
  const action: GateAction =
    proposal.tool === "commit_refund"
      ? { tool: "commit_refund", arguments: proposal.arguments, stateVersions: proposal.stateVersions }
      : { tool: "record_resolution", arguments: proposal.arguments, stateVersions: proposal.stateVersions };
  const gate = gateFor(deps, scope, action, records, proposal.id);
  if (gate.decision !== proposal.decision) {
    return {
      code: "STATE_CONFLICT",
      message: `The gate now decides ${gate.decision} (${gate.ruleIds.join(", ")}); form a new proposal from current records.`,
      stale: true,
    };
  }
  if (deps.policy.version !== proposal.policyVersion) {
    return { code: "STATE_CONFLICT", message: "The policy version changed; form a new proposal.", stale: true };
  }
  if (digestFor(scope, action, deps.policy.version, gate.stateVersions) !== proposal.actionDigest) {
    return { code: "STATE_CONFLICT", message: "The action no longer matches its digest; form a new proposal.", stale: true };
  }
  if (!options.requireApproval || proposal.decision !== "HUMAN_APPROVAL") return null;
  const stored = readApprovalForProposal(deps.db, proposal.id);
  const problems: ApprovalProblem[] = stored
    ? approvalProblems(stored.approval, proposal, { policyVersion: deps.policy.version, now: deps.clock.now() })
    : ["not_approved"];
  if (problems.length === 0) return null;
  const text = problems.map((p) => APPROVAL_PROBLEM_TEXT[p]).join("; ");
  return problems.includes("expired")
    ? { code: "APPROVAL_EXPIRED", message: `Cannot commit: ${text}.`, stale: false }
    : { code: "STATE_CONFLICT", message: `Cannot commit: ${text}.`, stale: false };
}

// Voids an approval whose proposal went stale, so it can never authorize anything again (R07).
export function invalidateStaleApproval(deps: EngineDeps, taskId: string, proposalId: string, reason: string, actorId: string): Approval | null {
  const stored = readApprovalForProposal(deps.db, proposalId);
  if (!stored || !invalidateApproval(deps.db, stored.approval.id, now(deps))) return null;
  appendAuditEvent(deps.db, {
    taskId,
    timestamp: now(deps),
    type: "approval",
    actorId,
    proposalId,
    operationId: null,
    evidenceIds: [],
    ruleIds: ["FRESH_STATE"],
    summary: `Approval ${stored.approval.id} invalidated: ${reason}`.slice(0, 2000),
    result: "blocked",
  });
  return { ...stored.approval, status: "invalidated", approverId: null };
}

async function lookupOrder(deps: EngineDeps, scope: TaskScope, args: ToolArguments<"lookup_order">): Promise<ToolExecution> {
  const order = await deps.storefront.lookupOrder(scope.task.instanceId, args.orderId);
  if (!order || !canAccessOrder(context(scope), { orderId: order.id, customerId: order.customerId })) {
    return refusedLookup(deps, scope, "order");
  }
  const window = order.refundWindow ? `${order.refundWindow.days} days from ${order.refundWindow.startsAt}` : "unknown";
  const exclusions = order.exclusions === null ? "unknown" : order.exclusions.length === 0 ? "none" : order.exclusions.join(", ");
  const evidenceId = recordEvidence(deps, scope, {
    sourceId: order.id,
    recordVersion: order.version,
    statement: `Order ${order.id} (version ${order.version}) belongs to customer ${order.customerId}, currency ${order.currency}; payment status ${order.paymentStatus ?? "unknown"}; refund window ${window}; exclusions ${exclusions}.`,
    supportsPreconditionIds: ["pre_order_paid", "pre_refund_window", "pre_no_exclusion"],
  });
  audit(deps, scope, {
    type: "lookup",
    proposalId: null,
    operationId: null,
    evidenceIds: [evidenceId],
    ruleIds: [],
    summary: `Looked up order ${order.id} (version ${order.version}).`,
    result: "success",
  });
  return execution(
    {
      status: "ok",
      evidenceId,
      order: {
        id: order.id,
        customerId: order.customerId,
        currency: order.currency,
        paymentStatus: order.paymentStatus,
        refundWindow: order.refundWindow,
        exclusions: order.exclusions,
        version: order.version,
      },
      // Free text written by people. It is data to read, never an instruction to follow.
      untrustedNotes: order.notes,
    },
    { usefulWork: true },
  );
}

async function lookupCustomer(deps: EngineDeps, scope: TaskScope, args: ToolArguments<"lookup_customer">): Promise<ToolExecution> {
  const customer = await deps.storefront.lookupCustomer(scope.task.instanceId, args.customerId);
  if (!customer || !canAccessCustomer(context(scope), customer.id)) return refusedLookup(deps, scope, "customer");
  const orderIds = listOrderIdsForCustomer(deps.db, scope.task.instanceId, customer.id).filter((orderId) =>
    canAccessOrder(context(scope), { orderId, customerId: customer.id }),
  );
  const evidenceId = recordEvidence(deps, scope, {
    sourceId: customer.id,
    recordVersion: customer.version,
    statement: `Customer ${customer.id} (version ${customer.version}) has ${orderIds.length} order(s) in scope: ${orderIds.join(", ") || "none"}.`,
    supportsPreconditionIds: ["pre_target_order"],
  });
  audit(deps, scope, {
    type: "lookup",
    proposalId: null,
    operationId: null,
    evidenceIds: [evidenceId],
    ruleIds: [],
    summary: `Looked up customer ${customer.id} (version ${customer.version}).`,
    result: "success",
  });
  return execution(
    {
      status: "ok",
      evidenceId,
      customer: { id: customer.id, displayName: customer.displayName, email: customer.email, version: customer.version },
      orderIds,
    },
    { usefulWork: true },
  );
}

async function lookupPayment(deps: EngineDeps, scope: TaskScope, args: ToolArguments<"lookup_payment">): Promise<ToolExecution> {
  if (!scopedOrder(deps, scope, args.orderId)) return refusedLookup(deps, scope, "payment");
  const payment = await deps.storefront.lookupPayment(scope.task.instanceId, args.orderId);
  if (!payment) {
    audit(deps, scope, {
      type: "lookup",
      proposalId: null,
      operationId: null,
      evidenceIds: [],
      ruleIds: [],
      summary: `No payment record exists for order ${args.orderId}.`,
      result: "success",
    });
    return execution({ status: "ok", payment: null }, { usefulWork: true });
  }
  const remaining = payment.paidMinor - payment.refundedMinor;
  const evidenceId = recordEvidence(deps, scope, {
    sourceId: payment.id,
    recordVersion: payment.version,
    statement: `Payment ${payment.id} (version ${payment.version}) for order ${payment.orderId}: paid ${payment.paidMinor}, refunded ${payment.refundedMinor}, remaining ${remaining} ${payment.currency} minor units; original destination ${payment.destination}.`,
    supportsPreconditionIds: ["pre_refundable_balance", "pre_original_destination"],
  });
  audit(deps, scope, {
    type: "lookup",
    proposalId: null,
    operationId: null,
    evidenceIds: [evidenceId],
    ruleIds: [],
    summary: `Looked up payment ${payment.id} (version ${payment.version}).`,
    result: "success",
  });
  return execution(
    {
      status: "ok",
      evidenceId,
      payment: {
        id: payment.id,
        orderId: payment.orderId,
        currency: payment.currency,
        paidMinor: payment.paidMinor,
        refundedMinor: payment.refundedMinor,
        remainingMinor: remaining,
        destination: payment.destination,
        version: payment.version,
      },
    },
    { usefulWork: true },
  );
}

function checkEligibility(deps: EngineDeps, scope: TaskScope, args: ToolArguments<"check_refund_eligibility">): ToolExecution {
  const order = scopedOrder(deps, scope, args.orderId);
  if (!order) return refusedLookup(deps, scope, "order");
  const payment = readPaymentForOrder(deps.db, scope.task.instanceId, order.id);
  const eligibility = evaluateEligibility(factsFromRecords(order, payment), scope.syntheticClock.now());
  const checks = Object.entries(eligibility.checks)
    .map(([id, status]) => `${id}=${status}`)
    .join(", ");
  const evidenceId = recordEvidence(deps, scope, {
    sourceId: order.id,
    recordVersion: order.version,
    statement: `Eligibility of order ${order.id} under policy ${deps.policy.version}: ${eligibility.status} (${checks}); payment version ${payment?.version ?? "none"}.`,
    supportsPreconditionIds: ["pre_order_paid", "pre_refund_window", "pre_no_exclusion", "pre_refundable_balance"],
  });
  audit(deps, scope, {
    type: "lookup",
    proposalId: null,
    operationId: null,
    evidenceIds: [evidenceId],
    ruleIds: ["ELIGIBLE_ORDER"],
    summary: `Checked refund eligibility of order ${order.id}: ${eligibility.status}.`,
    result: "success",
  });
  return execution(
    {
      status: "ok",
      evidenceId,
      orderId: order.id,
      eligibility: eligibility.status,
      checks: eligibility.checks,
      remainingRefundableMinor: eligibility.remainingRefundable?.amountMinor ?? null,
      currency: eligibility.remainingRefundable?.currency ?? order.currency,
      policyVersion: deps.policy.version,
    },
    { usefulWork: true },
  );
}

function proposeRefund(deps: EngineDeps, scope: TaskScope, args: ToolArguments<"propose_refund">): ToolExecution {
  const { proposal, gate } = propose(deps, scope, { tool: "commit_refund", arguments: args });
  const result = proposalResult(proposal, gate);
  if (gate.decision !== "HUMAN_APPROVAL" || gate.requiredRole === null) {
    return execution(result, { refusal: gate.decision === "REFUSE" });
  }
  const approval: Approval = {
    id: newId("apr"),
    taskId: scope.task.id,
    proposalId: proposal.id,
    actionDigest: proposal.actionDigest,
    policyVersion: proposal.policyVersion,
    stateVersions: proposal.stateVersions,
    requiredRole: gate.requiredRole,
    expiresAt: toUtcTimestamp(deps.clock.now() + deps.approvalTtlMs),
    status: "pending",
    approverId: null,
  };
  transaction(deps.db, () => {
    insertApproval(deps.db, { approval, createdAt: now(deps) });
    audit(deps, scope, {
      type: "approval",
      proposalId: proposal.id,
      operationId: null,
      evidenceIds: proposal.evidenceIds,
      ruleIds: gate.ruleIds,
      summary: `Approval ${approval.id} requested from role ${approval.requiredRole}; expires ${approval.expiresAt}.`,
      result: "pending",
    });
  });
  return execution(
    { ...result, approval: { id: approval.id, requiredRole: approval.requiredRole, expiresAt: approval.expiresAt } },
    { pause: { approvalId: approval.id } },
  );
}

function commitRefundTool(deps: EngineDeps, scope: TaskScope, args: ToolArguments<"commit_refund">): ToolExecution {
  const stored = readProposal(deps.db, args.proposalId);
  if (!stored || stored.proposal.taskId !== scope.task.id || stored.proposal.tool !== "commit_refund") {
    return execution(notFoundResult());
  }
  const { proposal } = stored;

  // Idempotent: a committed proposal returns its existing operation and writes nothing.
  const existing = readOperationByKey(deps.db, scope.task.instanceId, refundIdempotencyKey(proposal.id));
  if (existing) return execution({ status: "ok", replayed: true, ...operationData(existing) }, { usefulWork: true });

  if (proposal.decision !== "AUTO_EXECUTE" && proposal.decision !== "HUMAN_APPROVAL") {
    return execution(
      errorResult("STATE_CONFLICT", `Proposal ${proposal.id} was decided ${proposal.decision} and cannot be committed.`),
    );
  }

  const block = (problem: ProposalProblem): ToolExecution => {
    if (problem.stale) invalidateStaleApproval(deps, scope.task.id, proposal.id, problem.message, AGENT_ACTOR);
    audit(deps, scope, {
      type: "execution",
      proposalId: proposal.id,
      operationId: null,
      evidenceIds: [],
      ruleIds: proposal.ruleIds,
      summary: `Refund blocked before commit: ${problem.message}`.slice(0, 2000),
      result: "blocked",
    });
    return execution(errorResult(problem.code, problem.message, { retryable: problem.stale }));
  };

  // Check before writing anything, then again inside the transaction (spec Step 5). The first check
  // gives a precise answer and invalidates a stale approval; the second closes the race.
  const order = readOrder(deps.db, scope.task.instanceId, proposal.arguments.orderId);
  const payment = readPaymentForOrder(deps.db, scope.task.instanceId, proposal.arguments.orderId);
  const before = assessStoredProposal(deps, scope, proposal, { order, payment }, { requireApproval: true });
  if (before) return block(before);

  beginCommitAttempt(deps.db, { proposalId: proposal.id, taskId: scope.task.id, now: now(deps) });
  try {
    const { operation, replayed } = deps.storefront.commitRefund(proposal.id, {
      actorId: AGENT_ACTOR,
      recheck: (state) => {
        const problem = assessStoredProposal(deps, scope, state.proposal, state, { requireApproval: true });
        if (problem) throw new AppError(problem.code, problem.message, { taskId: scope.task.id, retryable: problem.stale });
      },
    });
    resolveCommitAttempt(deps.db, proposal.id, now(deps));
    return execution({ status: "ok", replayed, ...operationData(operation) }, { usefulWork: true });
  } catch (error) {
    if (error instanceof AppError && (error.code === "STATE_CONFLICT" || error.code === "APPROVAL_EXPIRED")) {
      // Rejected inside the transaction: it rolled back, so nothing was written.
      resolveCommitAttempt(deps.db, proposal.id, now(deps));
      if (error.retryable) invalidateStaleApproval(deps, scope.task.id, proposal.id, error.message, AGENT_ACTOR);
      return execution(errorResult(error.code, error.message, { retryable: error.retryable }));
    }
    // Unknown outcome (lost acknowledgment, failure around COMMIT). Look the operation up instead of
    // writing again (spec Step 5, R08).
    return reconcileAfterError(deps, scope, proposal.id, error);
  }
}

function reconcileAfterError(deps: EngineDeps, scope: TaskScope, proposalId: string, error: unknown): ToolExecution {
  const operation = deps.storefront.findRefundOperation(proposalId);
  resolveCommitAttempt(deps.db, proposalId, now(deps));
  audit(deps, scope, {
    type: "execution",
    proposalId,
    operationId: operation?.id ?? null,
    evidenceIds: [],
    ruleIds: ["DUPLICATE_OPERATION"],
    summary: operation
      ? `Commit acknowledgment was lost; reconciliation found operation ${operation.id}, so nothing was repeated.`
      : "Commit failed before it took effect; reconciliation found no operation.",
    result: operation ? "success" : "failure",
  });
  if (operation) return execution({ status: "ok", replayed: true, reconciled: true, ...operationData(operation) }, { usefulWork: true });
  if (!(error instanceof AppError)) throw error;
  return execution(
    errorResult(error.code, "The commit did not take effect. Retrying the same proposal is safe.", { retryable: true }),
  );
}

// Restart and cancellation safety: settle every commit attempt this task left in flight by looking up
// its operation. Never writes to the ledger.
export function reconcileInFlight(deps: EngineDeps, scope: TaskScope): Operation[] {
  const found: Operation[] = [];
  for (const proposalId of listInFlightAttempts(deps.db, scope.task.id)) {
    const operation = deps.storefront.findRefundOperation(proposalId);
    resolveCommitAttempt(deps.db, proposalId, now(deps));
    audit(deps, scope, {
      type: "execution",
      proposalId,
      operationId: operation?.id ?? null,
      evidenceIds: [],
      ruleIds: ["DUPLICATE_OPERATION"],
      summary: operation
        ? `Reconciled an interrupted commit: operation ${operation.id} had been committed.`
        : "Reconciled an interrupted commit: it had not taken effect.",
      result: operation ? "success" : "unknown",
    });
    if (operation) found.push(operation);
  }
  return found;
}

function verifyRefundTool(deps: EngineDeps, scope: TaskScope, args: ToolArguments<"verify_refund">): ToolExecution {
  const operation = readOperation(deps.db, args.operationId);
  if (!operation || operation.taskId !== scope.task.id || operation.kind !== "refund") return execution(notFoundResult());
  const verification = deps.storefront.verifyRefund(operation.id, AGENT_ACTOR);
  return execution(
    { status: "ok", verified: verification.verified, ...operationData(verification.operation) },
    { usefulWork: true },
  );
}

function recordResolution(deps: EngineDeps, scope: TaskScope, args: ToolArguments<"record_resolution">): ToolExecution {
  const { proposal, gate } = propose(deps, scope, { tool: "record_resolution", arguments: args });
  const result = proposalResult(proposal, gate);
  if (gate.decision !== "AUTO_EXECUTE") return execution(result);
  try {
    const { operation } = commitResolutionNote(
      deps.db,
      { proposalId: proposal.id, actorId: AGENT_ACTOR, now: now(deps) },
      {
        recheck: (state) => {
          const payment = readPaymentForOrder(deps.db, scope.task.instanceId, state.order.id);
          const problem = assessStoredProposal(deps, scope, state.proposal, { order: state.order, payment }, { requireApproval: false });
          if (problem) throw new AppError(problem.code, problem.message, { taskId: scope.task.id, retryable: problem.stale });
        },
      },
    );
    return execution({ ...result, operationId: operation.id }, { usefulWork: true });
  } catch (error) {
    if (error instanceof AppError && error.code === "STATE_CONFLICT") {
      return execution(errorResult(error.code, error.message, { proposalId: proposal.id, retryable: error.retryable }));
    }
    throw error;
  }
}

export async function executeTool(deps: EngineDeps, scope: TaskScope, call: ToolCall): Promise<ToolExecution> {
  switch (call.tool) {
    case "lookup_order":
      return lookupOrder(deps, scope, call.arguments);
    case "lookup_customer":
      return lookupCustomer(deps, scope, call.arguments);
    case "lookup_payment":
      return lookupPayment(deps, scope, call.arguments);
    case "check_refund_eligibility":
      return checkEligibility(deps, scope, call.arguments);
    case "propose_refund":
      return proposeRefund(deps, scope, call.arguments);
    case "commit_refund":
      return commitRefundTool(deps, scope, call.arguments);
    case "verify_refund":
      return verifyRefundTool(deps, scope, call.arguments);
    case "record_resolution":
      return recordResolution(deps, scope, call.arguments);
  }
}

import { createHash } from "node:crypto";
import { Coordinator, finalizeTask, type TaskBudgets } from "../agent/coordinator.js";
import { silentLogger, type Logger } from "../agent/log.js";
import type { PlannerFactory } from "../agent/planner.js";
import { AGENT_ACTOR, assessStoredProposal, invalidateStaleApproval, type EngineDeps, type TaskScope } from "../agent/tools.js";
import { ConfigError, type Config } from "../config.js";
import type { CallerIdentity } from "../contracts/caller-context.js";
import { isTerminalStatus, type ActionProposal, type Approval, type AuditEvent, type Evidence, type TaskSummary } from "../contracts/canonical.js";
import { AppError, notFound, parseInput } from "../contracts/errors.js";
import type { RefundPolicy } from "../contracts/policy.js";
import type { ScenarioFixture } from "../contracts/scenario.js";
import {
  answerQuestionInput,
  cancelTaskInput,
  getAuditInput,
  getProposalInput,
  getTaskInput,
  resolveApprovalInput,
  startTaskInput,
} from "../contracts/services.js";
import { isExpired } from "../domain/approvals.js";
import { bindTaskContext, canAccessOrder, requirePermission, requireRole } from "../domain/authorization.js";
import { parseUtcTimestamp, toUtcTimestamp, type Clock } from "../domain/clock.js";
import { canonicalJson } from "../domain/digest.js";
import { newId } from "../domain/ids.js";
import type { FaultInjector } from "../simulator/faults.js";
import { Storefront } from "../simulator/storefront.js";
import { decideApproval, expireApproval, pendingApprovalForTask, readApproval, readApprovalForProposal } from "../storage/approvals.js";
import { appendAuditEvent, listAuditPage } from "../storage/audit.js";
import { transaction, type Database } from "../storage/database.js";
import { insertEvidence, listEvidenceByIds } from "../storage/evidence.js";
import { getScenarioInstance, instanceClock, seedScenarioInstance, type ScenarioInstance } from "../storage/instances.js";
import { readOperationByKey, refundIdempotencyKey, resolutionIdempotencyKey, type Operation } from "../storage/ledger.js";
import { readProposal } from "../storage/proposals.js";
import { openQuestionForTask, readQuestion, recordAnswer } from "../storage/questions.js";
import { readOrder, readPaymentForOrder } from "../storage/records.js";
import { findRequestKey, insertRequestKey } from "../storage/request-keys.js";
import {
  createTask,
  getTask as readOwnedTask,
  listTasks as readOwnedTasks,
  listTasksByStatus,
  loadTask,
  requestCancel,
  transitionTask,
  type TaskRecord,
} from "../storage/tasks.js";
import { TaskRunner } from "./runner.js";
import { summarize } from "./summary.js";

// Transport-independent application services (spec §Application service interface, Steps 5–7).
// Every service takes the trusted caller identity separately from its untrusted input, validates the
// input strictly, checks permission and ownership, and returns typed results or throws AppError. The
// CLI (and any later web interface) only formats what these return.

export interface ApplicationDeps {
  db: Database;
  config: Config;
  policy: RefundPolicy;
  fixtures: ReadonlyMap<string, ScenarioFixture>;
  clock: Clock;
  plannerFor: PlannerFactory;
  faults?: FaultInjector;
  log?: Logger;
  // Test and evaluation harness only: supply the scenario instance for a new task, for example so that
  // concurrency tests share one. Runs inside startTask's transaction and must not open its own.
  instanceFor?: (input: { ownerId: string; fixture: ScenarioFixture }) => ScenarioInstance;
}

export interface ScenarioDescription {
  id: string;
  version: number;
  title: string;
  description: string;
  suggestedGoal: string | null;
}

export interface ProposalView {
  proposal: ActionProposal;
  evidence: Evidence[];
  approval: Approval | null;
  operation: Pick<Operation, "id" | "kind" | "status" | "amountMinor" | "currency"> | null;
  // The original payment destination a refund would go to; null if the order is not in scope.
  destination: string | null;
}

export interface AuditPage {
  events: AuditEvent[];
  nextCursor: string | null;
}

export type Application = ReturnType<typeof createApplication>;

function formatDuration(ms: number): string {
  const units: [number, string][] = [
    [24 * 60 * 60 * 1000, "day"],
    [60 * 60 * 1000, "hour"],
    [60 * 1000, "minute"],
    [1000, "second"],
  ];
  for (const [size, name] of units) {
    if (ms >= size && ms % size === 0) return `${ms / size} ${name}${ms / size === 1 ? "" : "s"}`;
  }
  return `${ms} ms`;
}

function inputHash(input: { goal: string; scenarioId: string }): string {
  return createHash("sha256").update(canonicalJson({ goal: input.goal, scenarioId: input.scenarioId }), "utf8").digest("hex");
}

export function createApplication(deps: ApplicationDeps) {
  const { db, config, policy, clock } = deps;
  const log = deps.log ?? silentLogger;
  // Startup check (DECISIONS.md "Version 1 is USD-only"): the configured currency must have a policy threshold.
  if (policy.currencies[config.currency] === undefined) {
    throw new ConfigError(`CURRENCY ${config.currency} is not configured in policy ${policy.version}`);
  }
  const storefront = new Storefront(db, clock, deps.faults);
  const engine: EngineDeps = { db, clock, policy, storefront, approvalTtlMs: config.approvalTtlMs };
  const coordinator = new Coordinator({ ...engine, plannerFor: deps.plannerFor, log });
  const runner = new TaskRunner({
    maxActivePerOwner: config.maxActiveTasks,
    maxQueuedPerOwner: config.maxQueuedTasks,
    execute: (taskId, signal) => coordinator.run(taskId, signal),
    log,
  });
  const budgets: TaskBudgets = {
    maxPlanningSteps: config.maxPlanningSteps,
    maxToolCalls: config.maxToolCalls,
    maxQuestions: config.maxQuestions,
    maxProviderRetries: config.maxProviderRetries,
    activeTimeoutMs: config.activeTimeoutMs,
    maxTokens: config.maxTokensPerTask ?? 0,
  };

  const now = () => toUtcTimestamp(clock.now());

  const scopeOf = (task: TaskRecord): TaskScope => ({
    task,
    syntheticClock: instanceClock(getScenarioInstance(db, task.instanceId, task.ownerId), clock),
  });

  const operatorAudit = (taskId: string, actorId: string, event: Pick<AuditEvent, "type" | "summary" | "result"> & Partial<AuditEvent>) =>
    appendAuditEvent(db, {
      taskId,
      timestamp: now(),
      actorId,
      proposalId: null,
      operationId: null,
      evidenceIds: [],
      ruleIds: [],
      ...event,
    });

  // Expired waits are settled lazily against stored expiry times and the injected clock, so nothing
  // has to run while a task waits (DECISIONS.md "Approvals wait for an assigned approver").
  function expireWaits(task: TaskRecord): TaskRecord {
    if (task.status === "waiting_for_approval") {
      const pending = pendingApprovalForTask(db, task.id);
      if (pending && isExpired(pending.approval, clock.now())) {
        transaction(db, () => {
          if (!expireApproval(db, pending.approval.id, now())) return;
          operatorAudit(task.id, AGENT_ACTOR, {
            type: "approval",
            proposalId: pending.approval.proposalId,
            summary: `Approval ${pending.approval.id} expired without a decision.`,
            result: "blocked",
          });
        });
        finalizeTask(engine, task.id, {
          from: ["waiting_for_approval"],
          status: "partial",
          limitations: [`Approval not received within ${formatDuration(config.approvalTtlMs)}.`],
          outcome: () => "The refund was not made because no approver decided before the approval expired.",
        });
      }
    } else if (task.status === "waiting_for_information") {
      const open = openQuestionForTask(db, task.id);
      if (open && clock.now() >= parseUtcTimestamp(open.createdAt) + config.pendingTaskTtlMs) {
        finalizeTask(engine, task.id, {
          from: ["waiting_for_information"],
          status: "partial",
          limitations: [`No answer received within ${formatDuration(config.pendingTaskTtlMs)}.`],
          outcome: () => "The task stopped while waiting for information it needed.",
        });
      }
    }
    return loadTask(db, task.id) ?? task;
  }

  function ownedTask(caller: CallerIdentity, taskId: string): TaskRecord {
    return expireWaits(readOwnedTask(db, taskId, caller.ownerId));
  }

  function resume(task: TaskRecord, from: "waiting_for_information" | "waiting_for_approval", actorId: string, summary: string): void {
    const moved = transitionTask(db, task.id, { from: [from], to: "queued", stage: "resuming", now: now() });
    if (!moved) throw new AppError("STATE_CONFLICT", "The task is no longer waiting", { taskId: task.id, retryable: false });
    operatorAudit(task.id, actorId, { type: "state_change", summary, result: "success" });
  }

  return {
    startTask(caller: CallerIdentity, raw: unknown): TaskSummary {
      requirePermission(caller, "task:start");
      const input = parseInput(startTaskInput, raw);
      const fixture = deps.fixtures.get(input.scenarioId);
      if (!fixture) throw notFound();
      const hash = inputHash(input);
      if (input.idempotencyKey !== undefined) {
        const existing = findRequestKey(db, caller.ownerId, input.idempotencyKey);
        if (existing) {
          if (existing.inputHash !== hash) {
            throw new AppError("IDEMPOTENCY_CONFLICT", "This idempotency key was already used with different input");
          }
          return summarize(db, readOwnedTask(db, existing.taskId, caller.ownerId));
        }
      }
      if (!runner.hasCapacity(caller.ownerId)) {
        throw new AppError("BUDGET_EXCEEDED", `At most ${config.maxQueuedTasks} tasks may be queued; try again later`, {
          retryable: true,
        });
      }
      const task = transaction(db, () => {
        const instance =
          deps.instanceFor?.({ ownerId: caller.ownerId, fixture }) ??
          seedScenarioInstance(db, { ownerId: caller.ownerId, fixture, clock });
        const created = createTask(db, {
          ownerId: caller.ownerId,
          instanceId: instance.id,
          scenarioId: fixture.id,
          goal: input.goal,
          inputHash: hash,
          // Scope comes from the trusted scenario definition, never from the goal (spec Step 2).
          context: bindTaskContext(caller, fixture.scope),
          budgets: { ...budgets },
          now: now(),
        });
        if (input.idempotencyKey !== undefined) {
          insertRequestKey(db, { ownerId: caller.ownerId, key: input.idempotencyKey, inputHash: hash, taskId: created.id, now: now() });
        }
        operatorAudit(created.id, caller.actorId, {
          type: "state_change",
          summary: `Task started on scenario ${fixture.id} (version ${fixture.version}) under policy ${policy.version}.`,
          result: "success",
        });
        return created;
      });
      runner.enqueue(task.id, task.ownerId);
      return summarize(db, task);
    },

    getTask(caller: CallerIdentity, raw: unknown): TaskSummary {
      requirePermission(caller, "task:read");
      const input = parseInput(getTaskInput, raw);
      return summarize(db, ownedTask(caller, input.taskId));
    },

    // Not in the spec's service table; lets an interface find tasks to resume in a later session.
    listTasks(caller: CallerIdentity): TaskSummary[] {
      requirePermission(caller, "task:read");
      return readOwnedTasks(db, caller.ownerId).map((t) => summarize(db, expireWaits(t)));
    },

    answerQuestion(caller: CallerIdentity, raw: unknown): TaskSummary {
      requirePermission(caller, "task:answer");
      const input = parseInput(answerQuestionInput, raw);
      const task = ownedTask(caller, input.taskId);
      const stored = readQuestion(db, input.questionId);
      if (!stored || stored.question.taskId !== task.id) throw notFound(task.id);
      if (task.status !== "waiting_for_information" || stored.question.answer !== null) {
        throw new AppError("STATE_CONFLICT", "This question is not waiting for an answer", { taskId: task.id, retryable: false });
      }
      transaction(db, () => {
        if (!recordAnswer(db, { id: stored.question.id, answer: input.answer, now: now() })) {
          throw new AppError("STATE_CONFLICT", "This question was already answered", { taskId: task.id, retryable: false });
        }
        // The answer is a user statement: data the planner may use, never authority (spec §Policy rules).
        insertEvidence(db, {
          id: newId("ev"),
          taskId: task.id,
          kind: "user_statement",
          sourceId: stored.question.id,
          recordVersion: null,
          observedAt: now(),
          statement: `Answer to question ${stored.question.id}: ${input.answer}`.slice(0, 2000),
          supportsPreconditionIds: stored.question.missingPreconditionIds,
        });
        resume(task, "waiting_for_information", caller.actorId, `Question ${stored.question.id} answered; task resumes.`);
      });
      runner.enqueue(task.id, task.ownerId);
      return summarize(db, loadTask(db, task.id) ?? task);
    },

    getProposal(caller: CallerIdentity, raw: unknown): ProposalView {
      requirePermission(caller, "task:read");
      const input = parseInput(getProposalInput, raw);
      const task = ownedTask(caller, input.taskId);
      const stored = readProposal(db, input.proposalId);
      if (!stored || stored.proposal.taskId !== task.id) throw notFound(task.id);
      const { proposal } = stored;
      const key = proposal.tool === "commit_refund" ? refundIdempotencyKey(proposal.id) : resolutionIdempotencyKey(proposal.id);
      const operation = readOperationByKey(db, task.instanceId, key);
      const order = readOrder(db, task.instanceId, proposal.targetId);
      const inScope = order !== null && canAccessOrder(task.context, { orderId: order.id, customerId: order.customerId });
      return {
        proposal,
        evidence: listEvidenceByIds(db, task.id, proposal.evidenceIds),
        approval: readApprovalForProposal(db, proposal.id)?.approval ?? null,
        operation: operation && {
          id: operation.id,
          kind: operation.kind,
          status: operation.status,
          amountMinor: operation.amountMinor,
          currency: operation.currency,
        },
        destination: inScope ? (readPaymentForOrder(db, task.instanceId, proposal.targetId)?.destination ?? null) : null,
      };
    },

    // Only explicit operator input reaches this service; the planner has no path to it (spec Step 5).
    resolveApproval(caller: CallerIdentity, raw: unknown): TaskSummary {
      const input = parseInput(resolveApprovalInput, raw);
      const task = readOwnedTask(db, input.taskId, caller.ownerId);
      const found = readApproval(db, input.approvalId);
      if (!found || found.approval.taskId !== task.id) throw notFound(task.id);
      // Ownership is checked first so a foreign approval reveals nothing, then the role.
      requireRole(caller, found.approval.requiredRole, task.id);
      const current = expireWaits(task);
      const stored = readApproval(db, input.approvalId);
      if (stored?.approval.status === "expired") {
        throw new AppError("APPROVAL_EXPIRED", "This approval expired before a decision was made", { taskId: task.id });
      }
      if (!stored || stored.approval.status !== "pending" || current.status !== "waiting_for_approval") {
        throw new AppError("STATE_CONFLICT", `This approval is no longer pending (${stored?.approval.status ?? "unknown"})`, {
          taskId: task.id,
          retryable: false,
        });
      }
      const proposal = readProposal(db, stored.approval.proposalId)?.proposal;
      if (!proposal) throw notFound(task.id);

      if (input.decision === "deny") {
        transaction(db, () => {
          if (!decideApproval(db, { id: stored.approval.id, status: "denied", approverId: caller.actorId, now: now() })) {
            throw new AppError("STATE_CONFLICT", "This approval is no longer pending", { taskId: task.id, retryable: false });
          }
          operatorAudit(task.id, caller.actorId, {
            type: "approval",
            proposalId: proposal.id,
            summary: `Approval ${stored.approval.id} denied by ${caller.actorId}.`,
            result: "blocked",
          });
        });
        // Owner decision: a denial ends the task as refused, so the agent cannot route around the
        // approver with a different refund (DECISIONS.md "Denial ends the task").
        finalizeTask(engine, task.id, {
          from: ["waiting_for_approval"],
          status: "refused",
          actorId: caller.actorId,
          limitations: [],
          outcome: () => `The approver denied proposal ${proposal.id}; no refund was made.`,
        });
        return summarize(db, loadTask(db, task.id) ?? task);
      }

      // The approval must still describe current records and policy (spec Step 5, R07).
      const records = {
        order: readOrder(db, task.instanceId, proposal.targetId),
        payment: readPaymentForOrder(db, task.instanceId, proposal.targetId),
      };
      const problem = assessStoredProposal(engine, scopeOf(current), proposal, records, { requireApproval: false });
      if (problem) {
        transaction(db, () => {
          invalidateStaleApproval(engine, task.id, proposal.id, problem.message, caller.actorId);
          resume(current, "waiting_for_approval", caller.actorId, "Approval invalidated by a relevant change; task resumes to form a new proposal.");
        });
        runner.enqueue(task.id, task.ownerId);
        throw new AppError("STATE_CONFLICT", `The approval was not applied: ${problem.message}`, { taskId: task.id, retryable: false });
      }
      transaction(db, () => {
        if (!decideApproval(db, { id: stored.approval.id, status: "approved", approverId: caller.actorId, now: now() })) {
          throw new AppError("STATE_CONFLICT", "This approval is no longer pending", { taskId: task.id, retryable: false });
        }
        operatorAudit(task.id, caller.actorId, {
          type: "approval",
          proposalId: proposal.id,
          summary: `Approval ${stored.approval.id} granted by ${caller.actorId} for digest ${proposal.actionDigest}.`,
          result: "success",
        });
        resume(current, "waiting_for_approval", caller.actorId, "Approval granted; task resumes.");
      });
      runner.enqueue(task.id, task.ownerId);
      return summarize(db, loadTask(db, task.id) ?? task);
    },

    getAudit(caller: CallerIdentity, raw: unknown): AuditPage {
      requirePermission(caller, "task:read");
      const input = parseInput(getAuditInput, raw);
      const task = readOwnedTask(db, input.taskId, caller.ownerId);
      let from = 0;
      if (input.cursor !== undefined) {
        const match = /^s(\d{1,9})$/.exec(input.cursor);
        if (!match) throw new AppError("INVALID_INPUT", "Invalid input: cursor: not a cursor from this service", { taskId: task.id });
        from = Number(match[1]);
      }
      const page = listAuditPage(db, task.id, from, input.limit);
      return { events: page.events, nextCursor: page.nextSequence === null ? null : `s${page.nextSequence}` };
    },

    // Stops new actions. An already committed refund cannot be undone; the result reports it with its
    // verified outcome (spec §Reliability and limits, R12).
    async cancelTask(caller: CallerIdentity, raw: unknown): Promise<TaskSummary> {
      requirePermission(caller, "task:cancel");
      const input = parseInput(cancelTaskInput, raw);
      const task = ownedTask(caller, input.taskId);
      if (isTerminalStatus(task.status)) {
        throw new AppError("STATE_CONFLICT", `The task already ended (${task.status})`, { taskId: task.id, retryable: false });
      }
      requestCancel(db, task.id, now());
      operatorAudit(task.id, caller.actorId, { type: "state_change", summary: "Cancellation requested by the operator.", result: "pending" });
      if (runner.isActive(task.id)) {
        runner.abort(task.id);
        await runner.whenIdle(task.id);
      } else {
        runner.dequeue(task.id);
      }
      finalizeTask(engine, task.id, {
        from: ["queued", "waiting_for_information", "waiting_for_approval"],
        status: "cancelled",
        actorId: caller.actorId,
        limitations: ["Work stopped at the operator's request; anything not listed in the outcome was not done."],
        outcome: (operations) => {
          const refunds = operations.filter((op) => op.kind === "refund");
          return refunds.length === 0
            ? "Cancelled. No refund was made."
            : `Cancelled. ${refunds.map((op) => `Refund ${op.id} of ${op.amountMinor} ${op.currency} minor units on order ${op.orderId} was already committed${op.status === "verified" ? " and verified" : ""}.`).join(" ")}`;
        },
      });
      return summarize(db, loadTask(db, task.id) ?? task);
    },

    listScenarios(caller: CallerIdentity): ScenarioDescription[] {
      requirePermission(caller, "task:read");
      return [...deps.fixtures.values()]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((f) => ({ id: f.id, version: f.version, title: f.title, description: f.description, suggestedGoal: f.suggestedGoal ?? null }));
    },

    // Waits until the task is neither queued nor running, then returns its summary.
    async waitForTask(caller: CallerIdentity, taskId: string): Promise<TaskSummary> {
      readOwnedTask(db, taskId, caller.ownerId);
      await runner.whenIdle(taskId);
      return summarize(db, ownedTask(caller, taskId));
    },

    // Restart recovery (spec Step 6, R15): tasks left running by a process that died are re-queued. The
    // coordinator reconciles their in-flight commits before planning resumes. Assumes one process
    // works on a database at a time (DECISIONS.md).
    recoverInterruptedTasks(): number {
      let recovered = 0;
      for (const task of listTasksByStatus(db, ["running", "queued"])) {
        if (runner.isBusy(task.id)) continue;
        if (task.status === "running") {
          transaction(db, () => {
            transitionTask(db, task.id, { from: ["running"], to: "queued", stage: "recovered", now: now() });
            operatorAudit(task.id, AGENT_ACTOR, {
              type: "state_change",
              summary: "Recovered after a restart; interrupted commits are reconciled before planning resumes.",
              result: "pending",
            });
          });
        }
        runner.enqueue(task.id, task.ownerId);
        recovered += 1;
      }
      return recovered;
    },
  };
}

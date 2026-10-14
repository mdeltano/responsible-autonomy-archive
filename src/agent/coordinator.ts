import { z } from "zod";
import type { TaskResult, TaskStatus } from "../contracts/canonical.js";
import { AppError } from "../contracts/errors.js";
import { plannerOutput, TOOL_NAMES, type PlannerOutput } from "../contracts/planner.js";
import { canAccessOrder } from "../domain/authorization.js";
import { toUtcTimestamp } from "../domain/clock.js";
import {
  COMPLETION_CHECK_TEXT,
  completionUnmet,
  resolutionUnmet,
  stopStatus,
  type CompletionCheck,
  type ResolutionFacts,
  type StopReason,
} from "../domain/completion.js";
import { evaluateEligibility, factsFromRecords } from "../domain/eligibility.js";
import { newId } from "../domain/ids.js";
import { invalidateApproval, pendingApprovalForTask, readApproval } from "../storage/approvals.js";
import { appendAuditEvent } from "../storage/audit.js";
import { transaction } from "../storage/database.js";
import { getScenarioInstance, instanceClock } from "../storage/instances.js";
import { listInFlightAttempts, listTaskOperations, type Operation } from "../storage/ledger.js";
import { insertQuestion, openQuestionForTask, readQuestion } from "../storage/questions.js";
import { readOrder, readPaymentForOrder } from "../storage/records.js";
import { loadTask, saveCheckpoint, transitionTask, type TaskRecord } from "../storage/tasks.js";
import { readCheckpoint, type Checkpoint } from "./checkpoint.js";
import type { Logger } from "./log.js";
import { PLANNER_INSTRUCTIONS, type PlannerFactory, type PlannerInput, type PlannerResponse, type Planner } from "./planner.js";
import { AGENT_ACTOR, executeTool, reconcileInFlight, type EngineDeps, type TaskScope } from "./tools.js";

// Task coordinator (spec §Agent control loop, Step 6). The engine owns the loop: it asks the planner
// for one bounded next step, validates it, dispatches it through the tool registry and gate, records
// the result, and saves a checkpoint. It stops on completion, refusal, cancellation, an expired wait, or
// budget exhaustion, and pauses (releasing its worker slot) for answers and approvals. The terminal
// status always comes from records and completion checks, never from the planner.

// Per-task limits, snapshotted when the task starts (spec §Reliability and limits).
export const taskBudgets = z.strictObject({
  maxPlanningSteps: z.int().positive(),
  maxToolCalls: z.int().positive(),
  maxQuestions: z.int().nonnegative(),
  maxProviderRetries: z.int().nonnegative(),
  activeTimeoutMs: z.int().positive(),
  // 0 means no token cap (offline fake planner; see DECISIONS.md "Token budget").
  maxTokens: z.int().nonnegative(),
});
export type TaskBudgets = z.infer<typeof taskBudgets>;

export interface CoordinatorDeps extends EngineDeps {
  plannerFor: PlannerFactory;
  log: Logger;
}

// Preconditions a question may target: the gate's, plus the two facts only the customer can supply.
export const QUESTION_PRECONDITIONS = new Set([
  "pre_target_order",
  "pre_customer_identity",
  "pre_order_paid",
  "pre_refund_window",
  "pre_no_exclusion",
  "pre_refundable_balance",
  "pre_original_destination",
]);

const HISTORY_WINDOW = 30;
const MAX_TOOL_PAYLOAD_BYTES = 256 * 1024;
const MAX_FINISH_REJECTIONS = 2;

class StopTask extends Error {
  constructor(readonly reason: StopReason, readonly detail: string) {
    super(detail);
  }
}

function describeOperations(operations: readonly Operation[]): string {
  const refunds = operations.filter((op) => op.kind === "refund");
  if (refunds.length === 0) return "No refund was made.";
  return refunds
    .map((op) => `Refund ${op.id} of ${op.amountMinor} ${op.currency} minor units on order ${op.orderId} was committed${op.status === "verified" ? " and verified" : ""}.`)
    .join(" ");
}

const TERMINAL_AUDIT_RESULT: Partial<Record<TaskStatus, "success" | "blocked" | "failure" | "unknown">> = {
  completed: "success",
  refused: "blocked",
  partial: "unknown",
  failed: "failure",
  cancelled: "success",
};

export interface FinalizeInput {
  from: readonly TaskStatus[];
  status: TaskStatus;
  // Builds the outcome once the ledger has been reconciled and verified.
  outcome: (operations: readonly Operation[]) => string;
  limitations: string[];
  actorId?: string;
}

// Ends a task. Before reporting, settles in-flight commits and verifies every committed refund, so the
// result states what the ledger shows (spec §Agent control loop step 9, §Reliability and limits).
// Returns false when the task had already moved on.
export function finalizeTask(deps: EngineDeps, taskId: string, input: FinalizeInput): boolean {
  const task = loadTask(deps.db, taskId);
  if (!task || !input.from.includes(task.status)) return false;
  const scope: TaskScope = { task, syntheticClock: deps.clock };
  reconcileInFlight(deps, scope);
  for (const op of listTaskOperations(deps.db, taskId)) {
    if (op.kind === "refund" && op.status === "committed") deps.storefront.verifyRefund(op.id, AGENT_ACTOR);
  }
  const operations = listTaskOperations(deps.db, taskId);
  const verified = operations.filter((op) => op.kind === "refund").every((op) => op.status === "verified");
  let status = input.status;
  const limitations = [...input.limitations];
  if (status === "completed" && !verified) {
    status = "partial";
    limitations.push("The ledger did not reconcile, so the outcome is not reported as completed.");
  }
  const result: TaskResult = {
    outcome: input.outcome(operations).slice(0, 2000),
    operationIds: operations.map((op) => op.id).slice(0, 20),
    verified,
    limitations: limitations.slice(0, 20).map((l) => l.slice(0, 2000)),
  };
  const now = toUtcTimestamp(deps.clock.now());
  return transaction(deps.db, () => {
    const moved = transitionTask(deps.db, taskId, { from: input.from, to: status, stage: status, now, result });
    if (!moved) return false;
    // Nothing is left waiting on a finished task.
    const pending = pendingApprovalForTask(deps.db, taskId);
    if (pending) invalidateApproval(deps.db, pending.approval.id, now);
    appendAuditEvent(deps.db, {
      taskId,
      timestamp: now,
      type: "state_change",
      actorId: input.actorId ?? AGENT_ACTOR,
      proposalId: null,
      operationId: null,
      evidenceIds: [],
      ruleIds: [],
      summary: `Task ${status}. ${describeOperations(operations)}`.slice(0, 2000),
      result: TERMINAL_AUDIT_RESULT[status] ?? "failure",
    });
    return true;
  });
}

export class Coordinator {
  readonly #deps: CoordinatorDeps;

  constructor(deps: CoordinatorDeps) {
    this.#deps = deps;
  }

  // Runs a queued task until it waits, finishes, or is cancelled. Safe to call for a task that is not
  // queued: it does nothing, so a duplicate resume cannot start a second loop.
  async run(taskId: string, signal: AbortSignal): Promise<void> {
    const deps = this.#deps;
    const queued = loadTask(deps.db, taskId);
    if (!queued || queued.status !== "queued") return;
    if (queued.cancelRequested) {
      this.#finalizeCancelled(taskId, ["queued"]);
      return;
    }
    if (!transitionTask(deps.db, taskId, { from: ["queued"], to: "running", stage: "planning", now: this.#now() })) return;
    const task = loadTask(deps.db, taskId);
    if (!task) return;
    const instance = getScenarioInstance(deps.db, task.instanceId, task.ownerId);
    const scope: TaskScope = { task, syntheticClock: instanceClock(instance, deps.clock) };
    const budgets = taskBudgets.parse(task.budgets);
    const checkpoint = readCheckpoint(task.checkpoint);
    try {
      // Restart safety: settle interrupted commits before planning anything (spec Step 6).
      for (const op of reconcileInFlight(deps, scope)) {
        checkpoint.history.push({ type: "event", event: { event: "commit_reconciled", operationId: op.id, proposalId: op.proposalId } });
      }
      this.#resumeEvents(checkpoint);
      this.#save(task, checkpoint, "planning");
      await this.#loop(scope, budgets, checkpoint, deps.plannerFor({ id: task.id, scenarioId: task.scenarioId }), signal);
    } catch (error) {
      if (error instanceof StopTask) {
        this.#stop(scope, checkpoint, error.reason, error.detail);
        return;
      }
      deps.log.log("error", "task loop failed", {
        taskId,
        code: error instanceof AppError ? error.code : "INTERNAL_ERROR",
      });
      this.#stop(scope, checkpoint, "error", "The task stopped after an internal error.");
    }
  }

  async #loop(scope: TaskScope, budgets: TaskBudgets, cp: Checkpoint, planner: Planner, signal: AbortSignal): Promise<void> {
    const deps = this.#deps;
    const taskId = scope.task.id;
    for (;;) {
      if (this.#cancelRequested(taskId) || signal.aborted) {
        this.#finalizeCancelled(taskId, ["running"]);
        return;
      }
      this.#checkBudgets(cp, budgets);
      const started = deps.clock.now();

      const output = await this.#nextOutput(scope, budgets, cp, planner, signal);
      if (output === null || this.#cancelRequested(taskId)) {
        // Aborted mid-request, or cancelled while the planner was thinking: take no further action.
        this.#finalizeCancelled(taskId, ["running"]);
        return;
      }
      this.#checkBudgets(cp, budgets);
      const step = cp.counters.planningSteps;

      let pausedFor: "question" | "approval" | null = null;
      switch (output.kind) {
        case "tool_call": {
          if (cp.counters.toolCalls >= budgets.maxToolCalls) {
            throw new StopTask("budget_exhausted", `The tool call budget (${budgets.maxToolCalls}) was exhausted.`);
          }
          cp.counters.toolCalls += 1;
          const exec = await executeTool(deps, scope, output.call);
          let result = exec.result;
          if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_TOOL_PAYLOAD_BYTES) {
            result = { status: "error", error: { code: "INTERNAL_ERROR", message: "Tool result exceeded the payload limit" } };
          }
          cp.usefulWork ||= exec.usefulWork;
          cp.refusalOccurred ||= exec.refusal;
          cp.history.push({ type: "step", step, output, result });
          if (exec.pause) {
            cp.awaiting = { kind: "approval", id: exec.pause.approvalId };
            pausedFor = "approval";
          }
          break;
        }
        case "ask_question":
          pausedFor = this.#askQuestion(scope, budgets, cp, step, output);
          break;
        case "propose_resolution":
          cp.history.push({ type: "step", step, output, result: this.#proposeResolution(scope, cp, output) });
          break;
        case "finish": {
          const unmet = completionUnmet(this.#completionFacts(scope, cp));
          if (unmet.length === 0) {
            cp.activeMs += deps.clock.now() - started;
            this.#save(scope.task, cp, "completing");
            this.#complete(scope, cp);
            return;
          }
          cp.counters.finishRejections += 1;
          if (cp.counters.finishRejections >= MAX_FINISH_REJECTIONS) {
            throw new StopTask("finish_rejected", `The task ended with completion checks unmet: ${describeUnmet(unmet)}.`);
          }
          cp.history.push({ type: "step", step, output, result: { status: "rejected", unmetChecks: unmet.map((c) => COMPLETION_CHECK_TEXT[c]) } });
          break;
        }
      }
      cp.activeMs += deps.clock.now() - started;
      if (pausedFor) {
        this.#pause(scope.task, cp, pausedFor);
        return;
      }
      this.#save(scope.task, cp, output.kind === "tool_call" ? `ran ${output.call.tool}` : output.kind);
    }
  }

  // One validated planner output, with bounded provider retries and a single schema repair. Returns
  // null when the request was aborted by cancellation.
  async #nextOutput(scope: TaskScope, budgets: TaskBudgets, cp: Checkpoint, planner: Planner, signal: AbortSignal): Promise<PlannerOutput | null> {
    let repair: { issues: string[] } | null = null;
    for (;;) {
      const response = await this.#request(scope, budgets, cp, planner, this.#input(scope, budgets, cp, planner, repair), signal);
      if (response === null) return null;
      const parsed = plannerOutput.safeParse(response.output);
      if (parsed.success) return parsed.data;
      const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`.slice(0, 200));
      cp.history.push({ type: "invalid_output", step: cp.counters.planningSteps, issues });
      appendAuditEvent(this.#deps.db, {
        taskId: scope.task.id,
        timestamp: this.#now(),
        type: "error",
        actorId: AGENT_ACTOR,
        proposalId: null,
        operationId: null,
        evidenceIds: [],
        ruleIds: [],
        summary: `Planner output failed validation${repair ? " after the repair attempt" : ""}: ${issues.join("; ")}`.slice(0, 2000),
        result: "failure",
      });
      if (repair) throw new StopTask("invalid_model_output", "The planner returned invalid output twice; no action was taken on it.");
      cp.counters.repairs += 1;
      repair = { issues };
    }
  }

  async #request(
    scope: TaskScope,
    budgets: TaskBudgets,
    cp: Checkpoint,
    planner: Planner,
    input: PlannerInput,
    signal: AbortSignal,
  ): Promise<PlannerResponse | null> {
    for (let attempt = 0; ; attempt++) {
      // Budgets are rechecked before every provider request (spec Step 8).
      this.#checkBudgets(cp, budgets);
      cp.counters.planningSteps += 1;
      try {
        const response = await planner.plan(input, signal);
        cp.counters.tokens += response.usage.inputTokens + response.usage.outputTokens;
        return response;
      } catch (error) {
        if (signal.aborted) return null;
        if (error instanceof AppError && error.code === "PROVIDER_UNAVAILABLE" && attempt < budgets.maxProviderRetries) continue;
        if (error instanceof AppError && error.code === "PROVIDER_UNAVAILABLE") {
          throw new StopTask("error", `The model provider was unavailable after ${attempt + 1} attempts.`);
        }
        throw error;
      }
    }
  }

  #input(scope: TaskScope, budgets: TaskBudgets, cp: Checkpoint, planner: Planner, repair: { issues: string[] } | null): PlannerInput {
    const policy = this.#deps.policy;
    return structuredClone({
      promptVersion: planner.promptVersion,
      instructions: PLANNER_INSTRUCTIONS,
      task: { goal: scope.task.goal, scope: scope.task.context.scope },
      policy: {
        version: policy.version,
        approverRole: policy.approverRole,
        autoExecuteMaxMinor: Object.fromEntries(Object.entries(policy.currencies).map(([c, v]) => [c, v.autoExecuteMaxMinor])),
      },
      tools: TOOL_NAMES,
      history: cp.history.slice(-HISTORY_WINDOW),
      budget: {
        planningStepsRemaining: Math.max(0, budgets.maxPlanningSteps - cp.counters.planningSteps),
        toolCallsRemaining: Math.max(0, budgets.maxToolCalls - cp.counters.toolCalls),
        questionsRemaining: Math.max(0, budgets.maxQuestions - cp.counters.questions),
      },
      repair,
    });
  }

  #checkBudgets(cp: Checkpoint, budgets: TaskBudgets): void {
    if (cp.counters.planningSteps >= budgets.maxPlanningSteps) {
      throw new StopTask("budget_exhausted", `The planning step budget (${budgets.maxPlanningSteps}) was exhausted.`);
    }
    if (budgets.maxTokens > 0 && cp.counters.tokens >= budgets.maxTokens) {
      throw new StopTask("budget_exhausted", `The token budget (${budgets.maxTokens}) was exhausted.`);
    }
    if (cp.activeMs >= budgets.activeTimeoutMs) {
      throw new StopTask("timeout", `The active execution time limit (${budgets.activeTimeoutMs} ms) was reached.`);
    }
  }

  #askQuestion(scope: TaskScope, budgets: TaskBudgets, cp: Checkpoint, step: number, output: Extract<PlannerOutput, { kind: "ask_question" }>): "question" | null {
    const unknown = output.missingPreconditionIds.filter((id) => !QUESTION_PRECONDITIONS.has(id));
    const rejection =
      cp.counters.questions >= budgets.maxQuestions
        ? `The question budget (${budgets.maxQuestions}) is exhausted.`
        : unknown.length > 0
          ? `A question must target a known missing precondition; unknown: ${unknown.join(", ")}.`
          : null;
    if (rejection) {
      cp.history.push({ type: "step", step, output, result: { status: "rejected", reason: rejection } });
      return null;
    }
    const question = {
      id: newId("q"),
      taskId: scope.task.id,
      missingPreconditionIds: output.missingPreconditionIds,
      text: output.text,
      options: output.options,
      answer: null,
    };
    transaction(this.#deps.db, () => {
      insertQuestion(this.#deps.db, { question, createdAt: this.#now() });
      appendAuditEvent(this.#deps.db, {
        taskId: scope.task.id,
        timestamp: this.#now(),
        type: "question",
        actorId: AGENT_ACTOR,
        proposalId: null,
        operationId: null,
        evidenceIds: [],
        ruleIds: [],
        summary: `Asked question ${question.id} about ${question.missingPreconditionIds.join(", ")}.`,
        result: "pending",
      });
    });
    cp.counters.questions += 1;
    cp.awaiting = { kind: "question", id: question.id };
    cp.history.push({ type: "step", step, output, result: { status: "ok", questionId: question.id } });
    return "question";
  }

  #resolutionFacts(scope: TaskScope, resolution: Checkpoint["resolution"]): ResolutionFacts {
    const deps = this.#deps;
    if (!resolution) {
      return { resolution: null, orderInScope: false, verifiedRefundOnOrder: false, eligibility: null, fullyRefunded: false };
    }
    const order = readOrder(deps.db, scope.task.instanceId, resolution.orderId);
    const inScope = order !== null && canAccessOrder(scope.task.context, { orderId: order.id, customerId: order.customerId });
    const payment = inScope ? readPaymentForOrder(deps.db, scope.task.instanceId, resolution.orderId) : null;
    return {
      resolution,
      orderInScope: inScope,
      verifiedRefundOnOrder: listTaskOperations(deps.db, scope.task.id).some(
        (op) => op.kind === "refund" && op.orderId === resolution.orderId && op.status === "verified",
      ),
      eligibility: order && inScope ? evaluateEligibility(factsFromRecords(order, payment), scope.syntheticClock.now()).status : null,
      fullyRefunded: payment !== null && payment.refundedMinor >= payment.paidMinor,
    };
  }

  #proposeResolution(scope: TaskScope, cp: Checkpoint, output: Extract<PlannerOutput, { kind: "propose_resolution" }>): Record<string, unknown> {
    const candidate = { orderId: output.orderId, resolution: output.resolution, reason: output.reason };
    const unmet = resolutionUnmet(this.#resolutionFacts(scope, candidate));
    if (unmet.length > 0) return { status: "rejected", unmetChecks: unmet.map((c) => COMPLETION_CHECK_TEXT[c]) };
    cp.resolution = candidate;
    return { status: "accepted", orderId: candidate.orderId, resolution: candidate.resolution };
  }

  #completionFacts(scope: TaskScope, cp: Checkpoint) {
    const deps = this.#deps;
    const operations = listTaskOperations(deps.db, scope.task.id);
    const orderId = cp.resolution?.orderId;
    return {
      ...this.#resolutionFacts(scope, cp.resolution),
      openQuestion: openQuestionForTask(deps.db, scope.task.id) !== null,
      pendingApproval: pendingApprovalForTask(deps.db, scope.task.id) !== null,
      unknownCommitOutcome: listInFlightAttempts(deps.db, scope.task.id).length > 0,
      operationsOutsideCase: operations.filter((op) => op.orderId !== orderId).length,
      resolutionNoteRecorded: operations.some((op) => op.kind === "resolution_note" && op.orderId === orderId),
    };
  }

  #complete(scope: TaskScope, cp: Checkpoint): void {
    const resolution = cp.resolution;
    if (!resolution) throw new Error("Completion checks passed without a resolution");
    const facts = this.#resolutionFacts(scope, resolution);
    finalizeTask(this.#deps, scope.task.id, {
      from: ["running"],
      status: "completed",
      limitations: [],
      outcome: (operations) => {
        if (resolution.resolution === "refund") return `${describeOperations(operations)} Resolution recorded on order ${resolution.orderId}.`;
        const why = facts.fullyRefunded ? "it is already fully refunded" : "it is not eligible for a refund under policy";
        return `No refund was due on order ${resolution.orderId}: ${why}. Resolution recorded.`;
      },
    });
  }

  #stop(scope: TaskScope, cp: Checkpoint, reason: StopReason, detail: string): void {
    const status = stopStatus({
      reason,
      refusalOccurred: cp.refusalOccurred,
      refundCommitted: listTaskOperations(this.#deps.db, scope.task.id).some((op) => op.kind === "refund"),
      usefulWork: cp.usefulWork,
    });
    try {
      this.#save(scope.task, cp, "stopping");
    } catch {
      // The checkpoint is best effort here; the terminal result below is what matters.
    }
    finalizeTask(this.#deps, scope.task.id, {
      from: ["running"],
      status,
      limitations: [detail],
      outcome: (operations) =>
        status === "refused"
          ? `The request could not proceed under policy. ${describeOperations(operations)}`
          : `The task stopped before the goal was finished. ${describeOperations(operations)}`,
    });
  }

  #finalizeCancelled(taskId: string, from: readonly TaskStatus[]): void {
    finalizeTask(this.#deps, taskId, {
      from,
      status: "cancelled",
      limitations: ["Work stopped at the operator's request; anything not listed in the outcome was not done."],
      outcome: (operations) => `Cancelled. ${describeOperations(operations)}`,
    });
  }

  // On resume, tell the planner what happened while the task waited.
  #resumeEvents(cp: Checkpoint): void {
    const awaiting = cp.awaiting;
    if (!awaiting) return;
    if (awaiting.kind === "question") {
      const stored = readQuestion(this.#deps.db, awaiting.id);
      if (stored?.question.answer == null) return;
      cp.history.push({
        type: "event",
        event: { event: "question_answered", questionId: awaiting.id, untrustedAnswer: stored.question.answer },
      });
    } else {
      const stored = readApproval(this.#deps.db, awaiting.id);
      if (!stored || stored.approval.status === "pending") return;
      cp.history.push({
        type: "event",
        event: {
          event: "approval_resolved",
          approvalId: stored.approval.id,
          proposalId: stored.approval.proposalId,
          status: stored.approval.status,
        },
      });
    }
    cp.awaiting = null;
  }

  #pause(task: TaskRecord, cp: Checkpoint, kind: "question" | "approval"): void {
    this.#save(task, cp, kind === "question" ? "awaiting answer" : "awaiting approval");
    transitionTask(this.#deps.db, task.id, {
      from: ["running"],
      to: kind === "question" ? "waiting_for_information" : "waiting_for_approval",
      stage: kind === "question" ? "awaiting answer" : "awaiting approval",
      now: this.#now(),
    });
  }

  #save(task: TaskRecord, cp: Checkpoint, stage: string): void {
    saveCheckpoint(this.#deps.db, task.id, { checkpoint: cp, stage: stage.slice(0, 64), now: this.#now() });
  }

  #cancelRequested(taskId: string): boolean {
    return loadTask(this.#deps.db, taskId)?.cancelRequested ?? true;
  }

  #now(): string {
    return toUtcTimestamp(this.#deps.clock.now());
  }
}

function describeUnmet(unmet: readonly CompletionCheck[]): string {
  return unmet.map((c) => COMPLETION_CHECK_TEXT[c]).join("; ");
}

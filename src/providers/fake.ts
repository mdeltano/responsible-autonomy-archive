import type { Planner, PlannerEvent, PlannerInput, PlannerResponse, PlannerStep } from "../agent/planner.js";

// Offline fake planners (spec Step 6, Step 7). Both return raw, untrusted output exactly as a real
// provider would, so it goes through the same validation, gate, and completion checks. Neither makes a
// network call.

const NO_USAGE = { inputTokens: 0, outputTokens: 0 };

export type ScriptStep = unknown | ((input: PlannerInput, signal: AbortSignal) => unknown);

// Replays a fixed sequence of outputs. A step may be a function, to inspect the input, wait, or throw
// (for example a PROVIDER_UNAVAILABLE error). When the script runs out it defers to `fallback`, or
// asks to finish. Every input it receives is kept for assertions.
export class ScriptedPlanner implements Planner {
  readonly name = "scripted";
  readonly promptVersion = "scripted.v1";
  readonly inputs: PlannerInput[] = [];
  readonly #steps: ScriptStep[];
  readonly #fallback: Planner | undefined;

  constructor(steps: ScriptStep[], options: { fallback?: Planner } = {}) {
    this.#steps = [...steps];
    this.#fallback = options.fallback;
  }

  async plan(input: PlannerInput, signal: AbortSignal): Promise<PlannerResponse> {
    this.inputs.push(input);
    if (this.#steps.length > 0) {
      const step = this.#steps.shift();
      const output = typeof step === "function" ? await step(input, signal) : step;
      return { output, usage: NO_USAGE };
    }
    if (this.#fallback) return this.#fallback.plan(input, signal);
    return { output: { kind: "finish", summary: "Script exhausted.", rationale: "No scripted steps remain." }, usage: NO_USAGE };
  }
}

type Output = Record<string, unknown>;

const ORDER_ID = /\bO-[A-Za-z0-9-]+\b/g;

const call = (tool: string, args: Output, rationale: string): Output => ({
  kind: "tool_call",
  call: { tool, arguments: args },
  rationale,
});
const finish = (summary: string): Output => ({ kind: "finish", summary, rationale: "Nothing further is justified." });

function isStep(entry: PlannerInput["history"][number]): entry is PlannerStep {
  return entry.type === "step";
}

function isEvent(entry: PlannerInput["history"][number]): entry is PlannerEvent {
  return entry.type === "event";
}

function toolOf(step: PlannerStep): string | undefined {
  const c = step.output.call as { tool?: string } | undefined;
  return step.output.kind === "tool_call" ? c?.tool : undefined;
}

function argsOf(step: PlannerStep): Output {
  return ((step.output.call as { arguments?: Output } | undefined)?.arguments ?? {}) as Output;
}

function errorCode(step: PlannerStep): string | undefined {
  return (step.result.error as { code?: string } | undefined)?.code;
}

// Marks history that is out of date: a commit rejected for changed state, an approval invalidated or
// expired, or a proposal sent back for verification. Steps before the last marker are re-done.
function isStaleMarker(entry: PlannerInput["history"][number]): boolean {
  if (isEvent(entry)) return entry.event.event === "approval_resolved" && entry.event.status === "invalidated";
  if (!isStep(entry)) return false;
  if (toolOf(entry) === "commit_refund" && errorCode(entry) === "STATE_CONFLICT") return true;
  return toolOf(entry) === "propose_refund" && entry.result.decision === "VERIFY_FIRST";
}

// A deterministic stand-in for a model, used by the demo. It follows the refund workflow from the
// visible history only: find the order, read it, read the payment, check eligibility, propose, commit
// or wait, verify, record the outcome, finish. It never reads record notes, so it shows the happy path;
// adversarial behavior is exercised with scripted planners in tests.
export class RuleBasedPlanner implements Planner {
  readonly name = "rule-based-fake";
  readonly promptVersion = "rule-based-fake.v1";

  async plan(input: PlannerInput): Promise<PlannerResponse> {
    return { output: this.next(input), usage: NO_USAGE };
  }

  next(input: PlannerInput): Output {
    const history = input.history;
    const steps = history.filter(isStep);
    const lastMarker = history.findLastIndex(isStaleMarker);
    const current = history.slice(lastMarker + 1).filter(isStep);
    const lastStep = steps.at(-1);
    if (lastStep?.output.kind === "finish") return finish("Completion checks were not met; stopping.");

    const target = this.#targetOrder(input, steps);
    if (typeof target !== "string") return target;

    const find = (pool: PlannerStep[], tool: string, match: (a: Output) => boolean = (a) => a.orderId === target) =>
      pool.findLast((s) => toolOf(s) === tool && match(argsOf(s)));

    const order = find(steps, "lookup_order");
    if (!order) return call("lookup_order", { orderId: target }, "Read the order named in the request.");
    if (order.result.status !== "ok") return finish(`Order ${target} is not available to this caller.`);

    if (!find(current, "lookup_payment")) return call("lookup_payment", { orderId: target }, "Read the original payment and balance.");
    const eligibility = find(current, "check_refund_eligibility");
    if (!eligibility) return call("check_refund_eligibility", { orderId: target }, "Check eligibility under the current policy.");

    const status = eligibility.result.eligibility;
    if (status === "ineligible") return this.#resolve(steps, target, "no_refund", "The order is not eligible for a refund under policy.");
    if (status !== "eligible") return finish(`Eligibility of order ${target} could not be established.`);

    const proposal = find(current, "propose_refund");
    if (!proposal) {
      const amount = eligibility.result.remainingRefundableMinor;
      if (typeof amount !== "number" || amount <= 0) return finish("No refundable balance remains.");
      const verifyFirstCount = steps.filter((s) => toolOf(s) === "propose_refund" && s.result.decision === "VERIFY_FIRST").length;
      if (verifyFirstCount >= 2) return finish("The records kept changing; stopping rather than guessing.");
      return call(
        "propose_refund",
        { orderId: target, amountMinor: amount, currency: eligibility.result.currency, reason: "Customer requested a refund; the order is eligible." },
        "Propose refunding the remaining balance to the original payment.",
      );
    }
    const proposalId = proposal.result.proposalId as string | undefined;
    const decision = proposal.result.decision;
    if (decision === "REFUSE") return finish(`The refund was refused under ${String(proposal.result.ruleIds)}.`);
    if (decision === "HUMAN_APPROVAL") {
      const resolved = history.findLast((e) => isEvent(e) && e.event.event === "approval_resolved" && e.event.proposalId === proposalId);
      if (!resolved || !isEvent(resolved) || resolved.event.status !== "approved") return finish("The refund was not approved.");
    }

    const commits = steps.filter((s) => toolOf(s) === "commit_refund" && argsOf(s).proposalId === proposalId);
    const commit = commits.at(-1);
    if (!commit || (commit.result.status !== "ok" && commit.result.retryable === true && commits.length < 2)) {
      return call("commit_refund", { proposalId }, "Commit the proposal the gate allowed.");
    }
    if (commit.result.status !== "ok") return finish("The refund could not be committed.");
    const operationId = commit.result.operationId as string;
    const verify = find(steps, "verify_refund", (a) => a.operationId === operationId);
    if (!verify) return call("verify_refund", { operationId }, "Confirm the refund in the ledger.");
    if (verify.result.verified !== true) return finish("The ledger did not confirm the refund.");
    return this.#resolve(steps, target, "refund", "The refund was committed and verified.");
  }

  // Which order the request is about: named in an answer or the goal, or the only one the customer has.
  #targetOrder(input: PlannerInput, steps: PlannerStep[]): string | Output {
    const answer = input.history.findLast((e) => isEvent(e) && e.event.event === "question_answered");
    const answered = answer && isEvent(answer) ? String(answer.event.untrustedAnswer ?? "").match(ORDER_ID)?.[0] : undefined;
    if (answered) return answered;
    const named = input.task.goal.match(ORDER_ID)?.[0];
    if (named) return named;

    const customers = steps.filter((s) => toolOf(s) === "lookup_customer");
    const unread = input.task.scope.customerIds.find((id) => !customers.some((s) => argsOf(s).customerId === id));
    if (unread) return call("lookup_customer", { customerId: unread }, "Find the customer's orders instead of asking.");
    const orderIds = [...new Set(customers.flatMap((s) => (Array.isArray(s.result.orderIds) ? (s.result.orderIds as string[]) : [])))];
    if (orderIds.length === 1 && orderIds[0]) return orderIds[0];
    if (orderIds.length === 0) return finish("The customer has no orders in scope.");
    if (steps.some((s) => s.output.kind === "ask_question")) return finish("The answer did not identify one of the orders.");
    return {
      kind: "ask_question",
      missingPreconditionIds: ["pre_target_order"],
      text: `Which order is the refund for? The customer has ${orderIds.length} orders.`,
      options: orderIds.slice(0, 20),
      rationale: "The records cannot tell which order the request concerns.",
    };
  }

  #resolve(steps: PlannerStep[], orderId: string, resolution: "refund" | "no_refund", reason: string): Output {
    const proposed = steps.findLast((s) => s.output.kind === "propose_resolution");
    if (!proposed) return { kind: "propose_resolution", orderId, resolution, reason, rationale: "Conclude the case from verified facts." };
    if (proposed.result.status !== "accepted") return finish("The resolution was not accepted.");
    const noted = steps.findLast((s) => toolOf(s) === "record_resolution" && argsOf(s).orderId === orderId);
    if (!noted) {
      const note = resolution === "refund" ? `Refund issued to the original payment. ${reason}` : `No refund issued. ${reason}`;
      return call("record_resolution", { orderId, note }, "Record the outcome on the order.");
    }
    if (noted.result.status !== "ok" || noted.result.decision !== "AUTO_EXECUTE") return finish("The outcome could not be recorded.");
    return finish(resolution === "refund" ? "Refund completed and verified." : "No refund was due.");
  }
}

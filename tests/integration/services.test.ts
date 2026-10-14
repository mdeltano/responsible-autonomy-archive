import { describe, expect, it } from "vitest";
import { AppError } from "../../src/contracts/errors.js";
import { ScriptedPlanner } from "../../src/providers/fake.js";
import { testApp } from "../helpers/app.js";

// Application services (spec §Application service interface): R10, R13, prompt start, audit paging,
// proposal inspection, and per-owner limits.

async function errorOf(fn: () => unknown): Promise<AppError> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error("expected an AppError");
}

const tableCount = (t: ReturnType<typeof testApp>, table: string) => Number(t.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n);

describe("startTask", () => {
  it("returns a queued handle before any planning happens", async () => {
    const t = testApp();
    const summary = t.start("refund-small");
    expect(summary).toMatchObject({ status: "queued", question: null, approval: null, result: null });
    expect(t.audit(summary.id).map((e) => e.type)).toEqual(["state_change"]);
    expect((await t.app.waitForTask(t.operator, summary.id)).status).toBe("completed");
  });

  it("rejects malformed input and unknown scenarios before writing anything", async () => {
    const t = testApp();
    for (const input of [
      { scenarioId: "refund-small", goal: "short" },
      { scenarioId: "refund-small", goal: "            " },
      { scenarioId: "refund-small", goal: "Please refund my order", scope: { customerIds: ["C-200"] } },
    ]) {
      expect((await errorOf(() => t.app.startTask(t.operator, input))).code).toBe("INVALID_INPUT");
    }
    expect((await errorOf(() => t.app.startTask(t.operator, { scenarioId: "nope", goal: "Please refund my order" }))).code).toBe("NOT_FOUND");
    expect(tableCount(t, "tasks")).toBe(0);
    expect(tableCount(t, "scenario_instances")).toBe(0);
  });

  it("R10: the same key and input return the same task; altered input conflicts", async () => {
    const t = testApp();
    const input = { scenarioId: "refund-small", goal: "Please refund my cracked mug.", idempotencyKey: "req-1" };
    const first = t.app.startTask(t.operator, input);
    const again = t.app.startTask(t.operator, input);
    expect(again.id).toBe(first.id);
    const altered = await errorOf(() => t.app.startTask(t.operator, { ...input, goal: "Please refund my cracked mug!!" }));
    expect(altered.code).toBe("IDEMPOTENCY_CONFLICT");
    // Keys are per owner: another owner's identical key is a different request.
    expect(t.app.startTask(t.foreign, input).id).not.toBe(first.id);
    await t.app.waitForTask(t.operator, first.id);
    expect(t.app.startTask(t.operator, input).id).toBe(first.id);
    expect(tableCount(t, "tasks")).toBe(2);
  });

  it("runs at most two tasks per owner at once and caps the queue", async () => {
    let running = 0;
    let peak = 0;
    const slow = () =>
      new ScriptedPlanner([
        async () => {
          peak = Math.max(peak, ++running);
          await new Promise((resolve) => setTimeout(resolve, 10));
          running--;
          return { kind: "finish", summary: "x", rationale: "x" };
        },
      ]);
    const t = testApp({ planner: slow, env: { MAX_QUEUED_TASKS: "3" } });
    const ids = [1, 2, 3, 4, 5].map(() => t.start("refund-small").id);
    const overflow = await errorOf(() => t.start("refund-small"));
    expect(overflow.toPublic()).toMatchObject({ code: "BUDGET_EXCEEDED", retryable: true });
    await Promise.all(ids.map((id) => t.app.waitForTask(t.operator, id)));
    expect(peak).toBe(2);
  });
});

describe("R13: foreign owners and unknown IDs", () => {
  it("get the identical NOT_FOUND from every service, and nothing leaks", async () => {
    const t = testApp();
    const waiting = await t.run("refund-large");
    const proposalId = waiting.approval?.proposalId;
    const calls: [string, (taskId: string) => unknown][] = [
      ["getTask", (taskId) => t.app.getTask(t.foreign, { taskId })],
      ["getProposal", (taskId) => t.app.getProposal(t.foreign, { taskId, proposalId })],
      ["getAudit", (taskId) => t.app.getAudit(t.foreign, { taskId })],
      ["resolveApproval", (taskId) => t.app.resolveApproval(t.foreign, { taskId, approvalId: waiting.approval?.id, decision: "approve" })],
      ["answerQuestion", (taskId) => t.app.answerQuestion(t.foreign, { taskId, questionId: "q_1", answer: "O-100" })],
      ["cancelTask", (taskId) => t.app.cancelTask(t.foreign, { taskId })],
    ];
    for (const [, call] of calls) {
      const foreign = await errorOf(() => call(waiting.id));
      const unknown = await errorOf(() => call("task_unknown"));
      expect(foreign.toPublic()).toEqual({ code: "NOT_FOUND", message: "Resource not found", retryable: false, taskId: null });
      expect(unknown.toPublic()).toEqual(foreign.toPublic());
    }
    expect(t.app.listTasks(t.foreign)).toEqual([]);
    expect(t.app.getTask(t.operator, { taskId: waiting.id }).status).toBe("waiting_for_approval");
  });

  it("does not resolve another task's proposal or approval through one's own task", async () => {
    const t = testApp();
    const a = await t.run("refund-large");
    const b = await t.run("refund-large");
    await expect(errorOf(() => t.app.getProposal(t.operator, { taskId: b.id, proposalId: a.approval?.proposalId }))).resolves.toMatchObject({ code: "NOT_FOUND" });
    await expect(errorOf(() => t.app.resolveApproval(t.operator, { taskId: b.id, approvalId: a.approval?.id, decision: "approve" }))).resolves.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("inspection services", () => {
  it("getProposal exposes the exact action, evidence, decision, rules, destination, and approval", async () => {
    const t = testApp();
    const waiting = await t.run("refund-large");
    const view = t.app.getProposal(t.operator, { taskId: waiting.id, proposalId: waiting.approval?.proposalId });
    expect(view.proposal).toMatchObject({
      tool: "commit_refund",
      arguments: { orderId: "O-100", amountMinor: 12000, currency: "USD" },
      decision: "HUMAN_APPROVAL",
      ruleIds: ["APPROVAL_THRESHOLD"],
      stateVersions: { "O-100": 0, "P-100": 0 },
    });
    expect(view.destination).toBe("card-ending-4242");
    expect(view.approval?.actionDigest).toBe(view.proposal.actionDigest);
    expect(view.evidence.map((e) => e.sourceId)).toEqual(["O-100", "P-100", "O-100"]);
    expect(view.operation).toBeNull();
  });

  it("getAudit pages through ordered events with an opaque cursor", async () => {
    const t = testApp();
    const done = await t.run("refund-small");
    const all = t.audit(done.id);
    const seen: number[] = [];
    let cursor: string | undefined;
    do {
      const page = t.app.getAudit(t.operator, { taskId: done.id, limit: 4, ...(cursor ? { cursor } : {}) });
      expect(page.events.length).toBeLessThanOrEqual(4);
      seen.push(...page.events.map((e) => e.sequence));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(all.map((e) => e.sequence));
    expect((await errorOf(() => t.app.getAudit(t.operator, { taskId: done.id, cursor: "garbage" }))).code).toBe("INVALID_INPUT");
    expect((await errorOf(() => t.app.getAudit(t.operator, { taskId: done.id, limit: 101 }))).code).toBe("INVALID_INPUT");
  });

  it("answerQuestion only resumes the matching waiting task", async () => {
    const t = testApp();
    const waiting = await t.run("refund-ambiguous");
    const done = await t.run("refund-small");
    expect((await errorOf(() => t.app.answerQuestion(t.operator, { taskId: waiting.id, questionId: "q_other", answer: "O-301" }))).code).toBe("NOT_FOUND");
    expect((await errorOf(() => t.app.answerQuestion(t.operator, { taskId: done.id, questionId: waiting.question?.id, answer: "O-301" }))).code).toBe("NOT_FOUND");
    t.app.answerQuestion(t.operator, { taskId: waiting.id, questionId: waiting.question?.id, answer: "O-301" });
    const twice = await errorOf(() => t.app.answerQuestion(t.operator, { taskId: waiting.id, questionId: waiting.question?.id, answer: "O-302" }));
    expect(twice.code).toBe("STATE_CONFLICT");
    expect((await t.app.waitForTask(t.operator, waiting.id)).status).toBe("completed");
    expect(t.refunded(waiting.id, "O-301")).toBe(3200);
    expect(t.refunded(waiting.id, "O-302")).toBe(0);
  });

  it("expires an unanswered question after the pending TTL as partial", async () => {
    const t = testApp();
    const waiting = await t.run("refund-ambiguous");
    t.clock.advance(t.config.pendingTaskTtlMs);
    const expired = t.app.getTask(t.operator, { taskId: waiting.id });
    expect(expired.status).toBe("partial");
    expect(expired.result?.limitations).toEqual(["No answer received within 1 day."]);
    expect(expired.question).toBeNull();
  });

  it("lists installed scenarios", () => {
    const t = testApp();
    expect(t.app.listScenarios(t.operator).map((s) => s.id)).toEqual([
      "refund-ambiguous",
      "refund-completed",
      "refund-ineligible",
      "refund-injection",
      "refund-large",
      "refund-small",
    ]);
  });
});

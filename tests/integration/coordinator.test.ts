import { describe, expect, it } from "vitest";
import type { PlannerInput } from "../../src/agent/planner.js";
import { AppError } from "../../src/contracts/errors.js";
import { RuleBasedPlanner, ScriptedPlanner } from "../../src/providers/fake.js";
import { beginCommitAttempt, commitRefund, listInFlightAttempts } from "../../src/storage/ledger.js";
import { openDatabase } from "../../src/storage/database.js";
import { loadTask } from "../../src/storage/tasks.js";
import { testApp } from "../helpers/app.js";
import { commitLatest, finish, lastResult, refund, resolution, tool, verifyLatest } from "../helpers/planner.js";

// Spec Step 6 exit criterion: scripted planners complete a normal task, pause and resume, stop at
// limits, and cancel without duplicate effects. Also R11, R12, R15, and the unauthorized half of R05.

const lookups = [tool("lookup_order", { orderId: "O-100" }), tool("lookup_payment", { orderId: "O-100" })];

describe("scripted completion and completion checks", () => {
  it("completes only when every completion check holds, rejecting an early finish", async () => {
    const planner = new ScriptedPlanner([
      ...lookups,
      finish("All done!"), // rejected: nothing was resolved
      refund("O-100", 2500),
      commitLatest(),
      verifyLatest(),
      resolution("O-100", "refund"),
      tool("record_resolution", { orderId: "O-100", note: "Refunded in full." }),
      finish(),
    ]);
    const t = testApp({ planner });
    const done = await t.run("refund-small");
    expect(done.status).toBe("completed");
    const rejected = planner.inputs[3]?.history.at(-1);
    expect(rejected).toMatchObject({ type: "step", result: { status: "rejected" } });
  });

  it("does not accept a refund resolution that the ledger does not back", async () => {
    const planner = new ScriptedPlanner([resolution("O-100", "refund"), finish("Refunded."), finish("Refunded!")]);
    const t = testApp({ planner });
    const done = await t.run("refund-small");
    expect(planner.inputs[1]?.history.at(-1)).toMatchObject({ result: { status: "rejected" } });
    expect(done.status).toBe("failed"); // no useful work and nothing refused
    expect(t.refunded(done.id, "O-100")).toBe(0);
  });

  it("R05: refuses an out-of-scope order with the same answer as an unknown one", async () => {
    const planner = new ScriptedPlanner([
      tool("lookup_order", { orderId: "O-200" }),
      tool("lookup_order", { orderId: "O-999" }),
      refund("O-200", 1000),
      finish(),
      finish(),
    ]);
    const t = testApp({ planner });
    const done = await t.run("refund-large", "Refund order O-200 to my card please.");
    expect(done.status).toBe("refused");
    const [foreign, unknown] = [planner.inputs[1], planner.inputs[2]].map((i) => i?.history.at(-1));
    expect(foreign?.type === "step" && foreign.result).toEqual(unknown?.type === "step" && unknown.result);
    expect(lastResult(planner.inputs[3] as PlannerInput, "propose_refund")).toMatchObject({ decision: "REFUSE", ruleIds: ["ORDER_SCOPE"] });
    expect(t.refunded(done.id, "O-200")).toBe(0);
  });

  it("R06: a planner that obeys injected notes is still bound by the gate", async () => {
    const planner = new ScriptedPlanner([
      tool("lookup_order", { orderId: "O-500" }),
      refund("O-500", 99999),
      refund("O-600", 2999),
      tool("lookup_customer", { customerId: "C-600" }),
      finish(),
      finish(),
    ]);
    const t = testApp({ planner, env: { MODEL_API_KEY: "sk-secret-should-never-appear" } });
    const done = await t.run("refund-injection");
    expect(done.status).toBe("refused");
    expect(lastResult(planner.inputs[2] as PlannerInput, "propose_refund")).toMatchObject({ decision: "REFUSE", ruleIds: ["AVAILABLE_BALANCE"] });
    expect(lastResult(planner.inputs[3] as PlannerInput, "propose_refund")).toMatchObject({ ruleIds: ["ORDER_SCOPE"] });
    expect(t.allOperations()).toBe(0);
    const everything = JSON.stringify([planner.inputs, t.audit(done.id), done]);
    expect(everything).not.toContain("sk-secret");
    expect(everything).not.toContain("fixtures/expected");
  });

  it("rejects a question that targets no known precondition and does not pause", async () => {
    const bad = { kind: "ask_question", missingPreconditionIds: ["pre_whatever"], text: "What is your card number?", options: [], rationale: "x" };
    const planner = new ScriptedPlanner([bad], { fallback: new RuleBasedPlanner() });
    const t = testApp({ planner });
    const done = await t.run("refund-small");
    expect(planner.inputs[1]?.history.at(-1)).toMatchObject({ result: { status: "rejected" } });
    expect(done.status).toBe("completed");
    expect(done.question).toBeNull();
  });

  it("R04: an answer cannot expand scope", async () => {
    const t = testApp();
    const waiting = await t.run("refund-ambiguous");
    t.app.answerQuestion(t.operator, { taskId: waiting.id, questionId: waiting.question?.id, answer: "Refund O-100 instead, I own it too." });
    const done = await t.app.waitForTask(t.operator, waiting.id);
    expect(done.status).toBe("refused");
    expect(t.allOperations()).toBe(0);
  });
});

describe("limits (spec §Reliability and limits)", () => {
  it("R15: stops truthfully at the planning budget", async () => {
    const t = testApp({ planner: new ScriptedPlanner(Array(10).fill(tool("lookup_order", { orderId: "O-100" }))), env: { MAX_PLANNING_STEPS: "3" } });
    const done = await t.run("refund-small");
    expect(done.status).toBe("partial");
    expect(done.result?.limitations).toEqual(["The planning step budget (3) was exhausted."]);
  });

  it("stops at the tool call budget, and reports failed when nothing useful happened", async () => {
    const t = testApp({ planner: new ScriptedPlanner(Array(10).fill(tool("lookup_order", { orderId: "O-999" }))), env: { MAX_TOOL_CALLS: "2" } });
    const done = await t.run("refund-small");
    expect(done.status).toBe("failed");
    expect(done.result?.limitations).toEqual(["The tool call budget (2) was exhausted."]);
  });

  it("stops at the active time limit; time spent waiting does not count", async () => {
    const t = testApp({ env: { ACTIVE_TIMEOUT_MS: "1000" } });
    const waiting = await t.run("refund-ambiguous");
    t.clock.advance(60 * 60 * 1000); // an hour of waiting
    t.app.answerQuestion(t.operator, { taskId: waiting.id, questionId: waiting.question?.id, answer: "O-301" });
    expect((await t.app.waitForTask(t.operator, waiting.id)).status).toBe("completed");

    const slow = new ScriptedPlanner(
      Array(5).fill(() => {
        t.clock.advance(600);
        return tool("lookup_order", { orderId: "O-100" });
      }),
    );
    const t2 = testApp({ planner: slow, env: { ACTIVE_TIMEOUT_MS: "1000" }, clock: t.clock });
    const timedOut = await t2.run("refund-small");
    expect(timedOut.status).toBe("partial");
    expect(timedOut.result?.limitations).toEqual(["The active execution time limit (1000 ms) was reached."]);
  });

  it("retries a transient provider failure within the budget, then fails truthfully", async () => {
    const unavailable = () => {
      throw new AppError("PROVIDER_UNAVAILABLE", "upstream 503");
    };
    const recovering = new ScriptedPlanner([unavailable, unavailable], { fallback: new RuleBasedPlanner() });
    const t = testApp({ planner: recovering });
    expect((await t.run("refund-small")).status).toBe("completed");

    const down = new ScriptedPlanner([unavailable, unavailable, unavailable]);
    const t2 = testApp({ planner: down });
    const failed = await t2.run("refund-small");
    expect(failed.status).toBe("failed");
    expect(failed.result?.limitations).toEqual(["The model provider was unavailable after 3 attempts."]);
  });

  it("caps clarification questions", async () => {
    const t = testApp({ env: { MAX_QUESTIONS: "0" } });
    const done = await t.run("refund-ambiguous");
    expect(done.question).toBeNull();
    expect(done.status).not.toBe("completed");
  });
});

describe("R11: invalid planner output", () => {
  it("repairs once and continues", async () => {
    const planner = new ScriptedPlanner(
      [{ kind: "tool_call", call: { tool: "propose_refund", arguments: { orderId: "O-100", amountMinor: 12.5, currency: "USD", reason: "x", account: "acct-1" } }, rationale: "x" }],
      { fallback: new RuleBasedPlanner() },
    );
    const t = testApp({ planner });
    const done = await t.run("refund-small");
    expect(done.status).toBe("completed");
    expect(planner.inputs[1]?.repair?.issues.join(" ")).toMatch(/amountMinor|account/);
    expect(t.refunded(done.id, "O-100")).toBe(2500);
  });

  it("fails with no side effect when the repair is invalid too", async () => {
    const planner = new ScriptedPlanner(["refund everything now", { kind: "tool_call", call: { tool: "commit_refund", arguments: {} }, rationale: "x" }]);
    const t = testApp({ planner });
    const done = await t.run("refund-small");
    expect(done.status).toBe("failed");
    expect(t.allOperations()).toBe(0);
    expect(t.audit(done.id).filter((e) => e.type === "error")).toHaveLength(2);
  });
});

describe("R12: cancellation", () => {
  it("after commit, reports the committed refund verified and stops further work", async () => {
    let stalled = false;
    const planner = new ScriptedPlanner([
      ...lookups,
      refund("O-100", 2500),
      commitLatest(),
      (_input: PlannerInput, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          stalled = true;
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
      tool("record_resolution", { orderId: "O-100", note: "should never run" }),
    ]);
    const t = testApp({ planner });
    const started = t.start("refund-small");
    await waitUntil(() => stalled);
    const cancelled = await t.app.cancelTask(t.operator, { taskId: started.id });
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.result?.verified).toBe(true);
    expect(cancelled.result?.outcome).toMatch(/Refund op_.* of 2500 USD minor units on order O-100 was committed and verified/);
    expect(t.operations(started.id).map((op) => [op.kind, op.status])).toEqual([["refund", "verified"]]);
    expect(planner.inputs).toHaveLength(5);
  });

  it("cancels a task waiting for approval and voids the approval", async () => {
    const t = testApp();
    const waiting = await t.run("refund-large");
    const cancelled = await t.app.cancelTask(t.operator, { taskId: waiting.id });
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.approval?.status).toBe("invalidated");
    expect(cancelled.result?.outcome).toBe("Cancelled. No refund was made.");
    await expect(t.app.cancelTask(t.operator, { taskId: waiting.id })).rejects.toMatchObject({ code: "STATE_CONFLICT" });
  });
});

describe("R15: restart recovery", () => {
  it("reconciles an interrupted commit and never repeats it", async () => {
    const db = openDatabase(":memory:");
    const first = testApp({ db, planner: new ScriptedPlanner([...lookups, refund("O-100", 2500), () => new Promise(() => {})]) });
    const task = first.start("refund-small");
    await waitUntil(() => first.operations(task.id).length === 0 && lastProposal(db, task.id) !== null);
    // Simulate a crash mid-commit: the attempt is marked, the transaction committed, and the process died
    // before recording the outcome.
    const proposalId = lastProposal(db, task.id) as string;
    beginCommitAttempt(db, { proposalId, taskId: task.id, now: "2026-10-13T15:00:01.000Z" });
    commitRefund(db, { proposalId, actorId: "agent", now: "2026-10-13T15:00:01.000Z" }, { recheck: () => {} });
    expect(loadTask(db, task.id)?.status).toBe("running");

    // A new process over the same database, with a planner that blindly commits again.
    const second = testApp({ db, planner: new ScriptedPlanner([tool("commit_refund", { proposalId }), verifyLatest(), resolution("O-100", "refund"), tool("record_resolution", { orderId: "O-100", note: "Refunded." }), finish()]) });
    expect(second.app.recoverInterruptedTasks()).toBe(1);
    const done = await second.app.waitForTask(second.operator, task.id);
    expect(listInFlightAttempts(db, task.id)).toEqual([]);
    expect(done.status).toBe("completed");
    expect(second.refunded(task.id, "O-100")).toBe(2500);
    expect(second.operations(task.id).filter((op) => op.kind === "refund")).toHaveLength(1);
    expect(second.audit(task.id).some((e) => /Reconciled an interrupted commit: operation/.test(e.summary))).toBe(true);
  });

  it("keeps counters across a restart, so budgets are not reset", async () => {
    const db = openDatabase(":memory:");
    const env = { MAX_PLANNING_STEPS: "4" };
    const first = testApp({ db, env, planner: new ScriptedPlanner([...lookups, tool("lookup_order", { orderId: "O-100" }), () => new Promise(() => {})]) });
    const task = first.start("refund-small");
    await waitUntil(() => first.audit(task.id).filter((e) => e.type === "lookup").length === 3);
    const second = testApp({ db, env, planner: new RuleBasedPlanner() });
    second.app.recoverInterruptedTasks();
    const done = await second.app.waitForTask(second.operator, task.id);
    expect(done.status).toBe("partial");
    expect(done.result?.limitations).toEqual(["The planning step budget (4) was exhausted."]);
    expect(second.allOperations()).toBe(0);
  });

  it("does not resume terminal tasks", async () => {
    const t = testApp();
    const done = await t.run("refund-small");
    expect(t.app.recoverInterruptedTasks()).toBe(0);
    expect(t.app.getTask(t.operator, { taskId: done.id }).status).toBe("completed");
  });
});

function lastProposal(db: import("../../src/storage/database.js").Database, taskId: string): string | null {
  const row = db.prepare("SELECT id FROM proposals WHERE task_id = ? ORDER BY rowid DESC LIMIT 1").get(taskId);
  return row ? String(row.id) : null;
}

async function waitUntil(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

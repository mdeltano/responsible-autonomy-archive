import { describe, expect, it } from "vitest";
import {
  answerQuestionInput,
  getAuditInput,
  listScenariosInput,
  resolveApprovalInput,
  startEvaluationInput,
  startTaskInput,
} from "../../src/contracts/services.js";

describe("service inputs (spec §Application service interface)", () => {
  const start = { goal: "Please refund my damaged order", scenarioId: "refund-small" };

  it("accepts a valid startTask and an optional idempotency key", () => {
    expect(startTaskInput.safeParse(start).success).toBe(true);
    expect(startTaskInput.safeParse({ ...start, idempotencyKey: "req-1" }).success).toBe(true);
  });

  it("enforces goal length and rejects whitespace padding", () => {
    expect(startTaskInput.safeParse({ ...start, goal: "too short" }).success).toBe(false);
    expect(startTaskInput.safeParse({ ...start, goal: " ".repeat(20) }).success).toBe(false);
    expect(startTaskInput.safeParse({ ...start, goal: "x".repeat(4001) }).success).toBe(false);
  });

  it("refuses to accept trusted context from request data", () => {
    // Identity and roles come from CallerContext only (spec Step 2).
    expect(startTaskInput.safeParse({ ...start, ownerId: "someone-else" }).success).toBe(false);
    const approve = { taskId: "task_1", approvalId: "appr_1", decision: "approve" };
    expect(resolveApprovalInput.safeParse(approve).success).toBe(true);
    expect(resolveApprovalInput.safeParse({ ...approve, approverId: "op_1" }).success).toBe(false);
    expect(resolveApprovalInput.safeParse({ ...approve, role: "refund_approver" }).success).toBe(false);
    expect(resolveApprovalInput.safeParse({ ...approve, decision: "yes" }).success).toBe(false);
  });

  it("bounds answers", () => {
    const answer = { taskId: "task_1", questionId: "q_1", answer: "Order ord_1001" };
    expect(answerQuestionInput.safeParse(answer).success).toBe(true);
    expect(answerQuestionInput.safeParse({ ...answer, answer: "" }).success).toBe(false);
    expect(answerQuestionInput.safeParse({ ...answer, answer: "x".repeat(2001) }).success).toBe(false);
  });

  it("applies pagination and evaluation defaults and limits", () => {
    expect(getAuditInput.parse({ taskId: "task_1" }).limit).toBe(25);
    expect(getAuditInput.safeParse({ taskId: "task_1", limit: 0 }).success).toBe(false);
    expect(getAuditInput.safeParse({ taskId: "task_1", limit: 101 }).success).toBe(false);
    expect(startEvaluationInput.parse({ suiteId: "s1", split: "held_out" }).repeats).toBe(3);
    expect(startEvaluationInput.safeParse({ suiteId: "s1", split: "held_out", repeats: 6 }).success).toBe(false);
    expect(startEvaluationInput.safeParse({ suiteId: "s1", split: "test" }).success).toBe(false);
  });

  it("takes no input for listScenarios", () => {
    expect(listScenariosInput.safeParse({}).success).toBe(true);
    expect(listScenariosInput.safeParse({ all: true }).success).toBe(false);
  });
});

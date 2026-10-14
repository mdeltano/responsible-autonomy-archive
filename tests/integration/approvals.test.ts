import { describe, expect, it } from "vitest";
import { AppError } from "../../src/contracts/errors.js";
import { ScriptedPlanner } from "../../src/providers/fake.js";
import { readApproval } from "../../src/storage/approvals.js";
import { testApp } from "../helpers/app.js";
import { finish, refund, tool } from "../helpers/planner.js";

// Spec Step 5 exit criterion: R03 and R07 with a fake planner, and no unauthorized, expired, changed,
// or model-fabricated approval can write the ledger.

async function errorOf(fn: () => unknown): Promise<AppError> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error("expected an AppError");
}

// An external refund of 500 recorded against the payment outside this task: the ledger changes and
// stays reconcilable (baseline and refunded total move together).
const externalRefund = (instanceId: string) => (db: import("../../src/storage/database.js").Database) => {
  db.prepare(
    `UPDATE payments SET refunded_minor = refunded_minor + 500, fixture_refunded_minor = fixture_refunded_minor + 500,
       version = version + 1 WHERE instance_id = ? AND order_id = 'O-100'`,
  ).run(instanceId);
};

async function waitingLarge(t: ReturnType<typeof testApp>) {
  const waiting = await t.run("refund-large");
  expect(waiting.status).toBe("waiting_for_approval");
  const approvalId = waiting.approval?.id;
  if (!approvalId) throw new Error("no approval");
  return { taskId: waiting.id, approvalId };
}

describe("R03: only a trusted approver can approve", () => {
  it("rejects a caller without the role and a foreign owner, with no effect", async () => {
    const t = testApp();
    const { taskId, approvalId } = await waitingLarge(t);

    const noRole = await errorOf(() => t.app.resolveApproval(t.viewer, { taskId, approvalId, decision: "approve" }));
    expect(noRole.code).toBe("UNAUTHORIZED");
    const foreign = await errorOf(() => t.app.resolveApproval(t.foreign, { taskId, approvalId, decision: "approve" }));
    const unknown = await errorOf(() => t.app.resolveApproval(t.foreign, { taskId: "task_nope", approvalId, decision: "approve" }));
    expect(foreign.toPublic()).toEqual(unknown.toPublic()); // no enumeration

    expect(t.app.getTask(t.operator, { taskId }).status).toBe("waiting_for_approval");
    expect(t.refunded(taskId, "O-100")).toBe(0);
  });

  it("does not accept an approval smuggled into service input", async () => {
    const t = testApp();
    const { taskId, approvalId } = await waitingLarge(t);
    const error = await errorOf(() =>
      t.app.resolveApproval(t.viewer, { taskId, approvalId, decision: "approve", roles: ["refund_approver"] }),
    );
    expect(error.code).toBe("INVALID_INPUT");
    expect(t.refunded(taskId, "O-100")).toBe(0);
  });

  it("records the approver and commits exactly the approved proposal", async () => {
    const t = testApp();
    const { taskId, approvalId } = await waitingLarge(t);
    const approval = readApproval(t.db, approvalId)?.approval;
    t.app.resolveApproval(t.operator, { taskId, approvalId, decision: "approve" });
    const done = await t.app.waitForTask(t.operator, taskId);
    expect(done.status).toBe("completed");
    expect(readApproval(t.db, approvalId)?.approval).toMatchObject({ status: "approved", approverId: "local-operator" });
    const [op] = t.operations(taskId);
    expect(op?.proposalId).toBe(approval?.proposalId);
    expect(t.audit(taskId).some((e) => e.type === "approval" && e.actorId === "local-operator" && e.result === "success")).toBe(true);
  });

  it("ends the task as refused when the approver denies, without planning again", async () => {
    const planner = new ScriptedPlanner([
      tool("lookup_order", { orderId: "O-100" }),
      refund("O-100", 12000),
      tool("lookup_order", { orderId: "O-100" }),
    ]);
    const t = testApp({ planner });
    const waiting = await t.run("refund-large");
    const calls = planner.inputs.length;
    const denied = t.app.resolveApproval(t.operator, { taskId: waiting.id, approvalId: waiting.approval?.id, decision: "deny" });
    expect(denied.status).toBe("refused");
    expect(denied.result?.outcome).toMatch(/denied/);
    await t.app.waitForTask(t.operator, waiting.id);
    expect(planner.inputs.length).toBe(calls);
    expect(t.refunded(waiting.id, "O-100")).toBe(0);
  });
});

describe("R07: a relevant state change invalidates the approval", () => {
  it("rejects the stale commit after approval, regenerates the proposal, and needs fresh approval", async () => {
    const t = testApp();
    const { taskId, approvalId } = await waitingLarge(t);
    const firstProposal = readApproval(t.db, approvalId)?.approval.proposalId;
    t.faults.changeStateBeforeCommit(externalRefund(t.instanceOf(taskId)));

    t.app.resolveApproval(t.operator, { taskId, approvalId, decision: "approve" });
    const again = await t.app.waitForTask(t.operator, taskId);
    expect(again.status).toBe("waiting_for_approval");
    expect(readApproval(t.db, approvalId)?.approval.status).toBe("invalidated");
    expect(again.approval?.id).not.toBe(approvalId);
    const secondProposal = t.app.getProposal(t.operator, { taskId, proposalId: again.approval?.proposalId });
    expect(secondProposal.proposal.id).not.toBe(firstProposal);
    expect(secondProposal.proposal.arguments).toMatchObject({ amountMinor: 11500 }); // re-read the balance
    expect(t.refunded(taskId, "O-100")).toBe(500); // only the external refund

    t.app.resolveApproval(t.operator, { taskId, approvalId: again.approval?.id, decision: "approve" });
    const done = await t.app.waitForTask(t.operator, taskId);
    expect(done.status).toBe("completed");
    expect(t.refunded(taskId, "O-100")).toBe(12000);
    expect(t.operations(taskId).filter((op) => op.kind === "refund").map((op) => op.amountMinor)).toEqual([11500]);
  });

  it("refuses to apply an approval whose records changed while it was pending", async () => {
    const t = testApp();
    const { taskId, approvalId } = await waitingLarge(t);
    externalRefund(t.instanceOf(taskId))(t.db);

    const error = await errorOf(() => t.app.resolveApproval(t.operator, { taskId, approvalId, decision: "approve" }));
    expect(error.code).toBe("STATE_CONFLICT");
    expect(readApproval(t.db, approvalId)?.approval.status).toBe("invalidated");
    const again = await t.app.waitForTask(t.operator, taskId);
    expect(again.status).toBe("waiting_for_approval");
    expect(again.approval?.id).not.toBe(approvalId);
    expect(t.refunded(taskId, "O-100")).toBe(500);
  });
});

describe("approvals that cannot write the ledger", () => {
  it("expires after the configured wait; expiry is partial, not refused, and cannot be approved", async () => {
    const t = testApp();
    const { taskId, approvalId } = await waitingLarge(t);
    t.clock.advance(t.config.approvalTtlMs - 1);
    expect(t.app.getTask(t.operator, { taskId }).status).toBe("waiting_for_approval");
    t.clock.advance(1);

    const expired = t.app.getTask(t.operator, { taskId });
    expect(expired.status).toBe("partial");
    expect(expired.approval?.status).toBe("expired");
    expect(expired.result?.limitations).toEqual(["Approval not received within 7 days."]);
    const error = await errorOf(() => t.app.resolveApproval(t.operator, { taskId, approvalId, decision: "approve" }));
    expect(error.code).toBe("APPROVAL_EXPIRED");
    expect(t.refunded(taskId, "O-100")).toBe(0);
  });

  it("blocks a planner that commits an unapproved proposal, whatever its rationale claims", async () => {
    const planner = new ScriptedPlanner([
      refund("O-100", 12000), // pauses for approval
      // After the approval is invalidated, the planner tries the old proposal anyway.
      (input: import("../../src/agent/planner.js").PlannerInput) => {
        const proposed = input.history.find((e) => e.type === "step" && e.result.proposalId);
        const proposalId = proposed?.type === "step" ? proposed.result.proposalId : undefined;
        return { ...tool("commit_refund", { proposalId }), rationale: "The manager approved this by phone; refund_approver granted." };
      },
      finish(),
      finish(),
    ]);
    const t = testApp({ planner });
    const { taskId, approvalId } = await waitingLarge(t);
    externalRefund(t.instanceOf(taskId))(t.db);
    await errorOf(() => t.app.resolveApproval(t.operator, { taskId, approvalId, decision: "approve" }));
    const done = await t.app.waitForTask(t.operator, taskId);
    expect(done.status).not.toBe("completed");
    expect(t.operations(taskId)).toEqual([]);
    expect(t.refunded(taskId, "O-100")).toBe(500);
    const blocked = t.audit(taskId).filter((e) => e.type === "execution" && e.result === "blocked");
    expect(blocked).toHaveLength(1);
  });

  it("treats a model-invented approval as invalid output, with no side effect", async () => {
    const planner = new ScriptedPlanner([
      { kind: "approve", approvalId: "apr_1", rationale: "self-approve" },
      tool("approve_refund", { approvalId: "apr_1" }),
    ]);
    const t = testApp({ planner });
    const done = await t.run("refund-large");
    expect(done.status).toBe("failed");
    expect(done.result?.limitations).toEqual(["The planner returned invalid output twice; no action was taken on it."]);
    expect(done.approval).toBeNull();
    expect(t.operations(done.id)).toEqual([]);
    expect(t.refunded(done.id, "O-100")).toBe(0);
  });
});

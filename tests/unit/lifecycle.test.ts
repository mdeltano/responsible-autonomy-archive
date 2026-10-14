import { describe, expect, it } from "vitest";
import { silentLogger } from "../../src/agent/log.js";
import { TaskRunner } from "../../src/application/runner.js";
import type { ActionProposal, Approval } from "../../src/contracts/canonical.js";
import { approvalProblems, isExpired } from "../../src/domain/approvals.js";
import { completionUnmet, stopStatus, type CompletionFacts } from "../../src/domain/completion.js";
import { canTransition } from "../../src/domain/task-transitions.js";

const digest = "a".repeat(64);
const proposal = {
  id: "prop_1",
  taskId: "task_1",
  tool: "commit_refund",
  targetId: "O-100",
  arguments: { orderId: "O-100", amountMinor: 12000, currency: "USD", reason: "x" },
  evidenceIds: [],
  preconditions: [],
  policyVersion: "refund-policy.v1",
  stateVersions: { "O-100": 0, "P-100": 0 },
  actionDigest: digest,
  decision: "HUMAN_APPROVAL",
  ruleIds: ["APPROVAL_THRESHOLD"],
  explanation: "",
} satisfies ActionProposal;
const approved: Approval = {
  id: "apr_1",
  taskId: "task_1",
  proposalId: "prop_1",
  actionDigest: digest,
  policyVersion: "refund-policy.v1",
  stateVersions: { "P-100": 0, "O-100": 0 },
  requiredRole: "refund_approver",
  expiresAt: "2026-10-20T15:00:00.000Z",
  status: "approved",
  approverId: "local-operator",
};
const current = { policyVersion: "refund-policy.v1", now: Date.parse("2026-10-13T15:00:00Z") };

describe("approval binding (spec Step 5)", () => {
  it("accepts an approved, unexpired approval of exactly this proposal", () => {
    expect(approvalProblems(approved, proposal, current)).toEqual([]);
  });

  it.each([
    ["pending", { status: "pending", approverId: null }, "not_approved"],
    ["other digest", { actionDigest: "b".repeat(64) }, "digest_mismatch"],
    ["other versions", { stateVersions: { "O-100": 0, "P-100": 1 } }, "state_changed"],
    ["other proposal", { proposalId: "prop_2" }, "wrong_proposal"],
  ] as const)("rejects %s", (_name, change, problem) => {
    expect(approvalProblems({ ...approved, ...change } as Approval, proposal, current)).toContain(problem);
  });

  it("rejects a changed policy and an expired approval, expiring exactly at expiresAt", () => {
    expect(approvalProblems(approved, proposal, { ...current, policyVersion: "refund-policy.v2" })).toEqual(["policy_changed"]);
    const at = Date.parse(approved.expiresAt);
    expect(isExpired(approved, at - 1)).toBe(false);
    expect(isExpired(approved, at)).toBe(true);
  });
});

const complete: CompletionFacts = {
  resolution: { orderId: "O-100", resolution: "refund" },
  orderInScope: true,
  verifiedRefundOnOrder: true,
  eligibility: "eligible",
  fullyRefunded: false,
  openQuestion: false,
  pendingApproval: false,
  unknownCommitOutcome: false,
  operationsOutsideCase: 0,
  resolutionNoteRecorded: true,
};

describe("completion checks (DECISIONS.md)", () => {
  it("passes only when every check holds", () => {
    expect(completionUnmet(complete)).toEqual([]);
  });

  it.each([
    [{ resolution: null }, "resolution_accepted"],
    [{ orderInScope: false }, "resolution_accepted"],
    [{ verifiedRefundOnOrder: false }, "resolution_backed_by_facts"],
    [{ resolution: { orderId: "O-100", resolution: "no_refund" as const } }, "resolution_backed_by_facts"],
    [{ pendingApproval: true }, "nothing_pending"],
    [{ unknownCommitOutcome: true }, "nothing_pending"],
    [{ operationsOutsideCase: 1 }, "no_action_outside_case"],
    [{ resolutionNoteRecorded: false }, "outcome_recorded"],
  ])("fails %o", (change, check) => {
    expect(completionUnmet({ ...complete, ...change })).toContain(check);
  });

  it("backs no_refund with ineligibility or a fully refunded order", () => {
    const noRefund = { ...complete, resolution: { orderId: "O-100", resolution: "no_refund" as const }, verifiedRefundOnOrder: false };
    expect(completionUnmet({ ...noRefund, eligibility: "ineligible" })).toEqual([]);
    expect(completionUnmet({ ...noRefund, fullyRefunded: true })).toEqual([]);
  });

  it("never classifies exhaustion as refused or completed", () => {
    const facts = { refusalOccurred: true, refundCommitted: false, usefulWork: true };
    expect(stopStatus({ ...facts, reason: "finish_rejected" })).toBe("refused");
    expect(stopStatus({ ...facts, reason: "budget_exhausted" })).toBe("partial");
    expect(stopStatus({ ...facts, reason: "timeout", usefulWork: false })).toBe("failed");
    expect(stopStatus({ ...facts, reason: "wait_expired" })).toBe("partial");
    expect(stopStatus({ ...facts, reason: "error", refundCommitted: true })).toBe("partial");
    expect(stopStatus({ ...facts, reason: "invalid_model_output" })).toBe("failed");
  });
});

describe("task transitions (spec Step 6)", () => {
  it("never resumes a terminal task and resumes waiting tasks only through the queue", () => {
    for (const terminal of ["completed", "refused", "partial", "failed", "cancelled"] as const) {
      expect(canTransition(terminal, "queued")).toBe(false);
      expect(canTransition(terminal, "running")).toBe(false);
    }
    expect(canTransition("waiting_for_approval", "running")).toBe(false);
    expect(canTransition("waiting_for_approval", "queued")).toBe(true);
    expect(canTransition("waiting_for_information", "refused")).toBe(false);
    expect(canTransition("queued", "completed")).toBe(false);
  });
});

describe("task runner", () => {
  it("never runs the same task twice at once and frees the slot when a run ends", async () => {
    const runs: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const runner = new TaskRunner({
      maxActivePerOwner: 1,
      maxQueuedPerOwner: 5,
      log: silentLogger,
      execute: async (taskId) => {
        runs.push(taskId);
        if (taskId === "a") await gate;
      },
    });
    runner.enqueue("a", "o");
    runner.enqueue("a", "o");
    runner.enqueue("b", "o");
    await new Promise((resolve) => setImmediate(resolve));
    expect(runs).toEqual(["a"]);
    release();
    await runner.whenIdle("b");
    expect(runs).toEqual(["a", "b"]);
  });
});

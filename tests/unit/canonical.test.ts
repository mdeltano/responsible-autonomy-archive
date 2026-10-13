import { describe, expect, it } from "vitest";
import {
  actionProposal,
  approval,
  auditEvent,
  evidence,
  question,
  taskSummary,
  type ActionProposal,
  type Approval,
  type TaskSummary,
} from "../../src/contracts/canonical.js";
import { canonicalSchemas, toJsonSchema } from "../../src/contracts/json-schema.js";

const NOW = "2026-10-13T12:00:00Z";
const DIGEST = "a".repeat(64);

const validProposal: ActionProposal = {
  id: "prop_1",
  taskId: "task_1",
  tool: "commit_refund",
  targetId: "ord_1001",
  arguments: { orderId: "ord_1001", amountMinor: 2500, currency: "USD", reason: "Item arrived damaged" },
  evidenceIds: ["ev_1"],
  preconditions: [{ id: "pre_paid", description: "Order is paid", status: "satisfied" }],
  policyVersion: "refund-policy.v1",
  stateVersions: { ord_1001: 3, pay_1001: 1 },
  actionDigest: DIGEST,
  decision: "AUTO_EXECUTE",
  ruleIds: ["R-AUTO-LIMIT"],
  explanation: "Eligible refund under the automatic limit.",
};

const pendingApproval: Approval = {
  id: "appr_1",
  taskId: "task_1",
  proposalId: "prop_1",
  actionDigest: DIGEST,
  policyVersion: "refund-policy.v1",
  stateVersions: { ord_1001: 3 },
  requiredRole: "refund_approver",
  expiresAt: "2026-10-13T12:05:00Z",
  status: "pending",
  approverId: null,
};

const runningTask: TaskSummary = {
  id: "task_1",
  status: "running",
  stage: "investigating",
  createdAt: NOW,
  updatedAt: NOW,
  question: null,
  approval: null,
  result: null,
  warnings: [],
};

describe("Evidence", () => {
  const base = {
    id: "ev_1",
    kind: "record",
    sourceId: "ord_1001",
    recordVersion: 3,
    observedAt: NOW,
    statement: "Order ord_1001 is paid.",
    supportsPreconditionIds: ["pre_paid"],
  };

  it("accepts record evidence with a version", () => {
    expect(evidence.safeParse(base).success).toBe(true);
  });

  it("requires a version on record evidence but not on user statements", () => {
    expect(evidence.safeParse({ ...base, recordVersion: null }).success).toBe(false);
    expect(evidence.safeParse({ ...base, kind: "user_statement", recordVersion: null }).success).toBe(true);
  });

  it("rejects unknown keys", () => {
    expect(evidence.safeParse({ ...base, confidence: 0.99 }).success).toBe(false);
  });
});

describe("ActionProposal", () => {
  it("accepts a valid refund proposal and a valid resolution proposal", () => {
    expect(actionProposal.safeParse(validProposal).success).toBe(true);
    const resolution = {
      ...validProposal,
      tool: "record_resolution",
      arguments: { orderId: "ord_1001", note: "Refund issued." },
    };
    expect(actionProposal.safeParse(resolution).success).toBe(true);
  });

  it("validates arguments against the schema for its tool", () => {
    const mixed = { ...validProposal, arguments: { orderId: "ord_1001", note: "wrong shape" } };
    expect(actionProposal.safeParse(mixed).success).toBe(false);
    const floatAmount = { ...validProposal, arguments: { ...validProposal.arguments, amountMinor: 25.5 } };
    expect(actionProposal.safeParse(floatAmount).success).toBe(false);
  });

  it("has no field for an arbitrary refund destination", () => {
    const redirected = {
      ...validProposal,
      arguments: { ...validProposal.arguments, destinationAccount: "attacker-123" },
    };
    expect(actionProposal.safeParse(redirected).success).toBe(false);
  });

  it("rejects tools that are not proposal tools", () => {
    expect(actionProposal.safeParse({ ...validProposal, tool: "approve_refund" }).success).toBe(false);
  });

  it("requires the target to be the order in the arguments", () => {
    expect(actionProposal.safeParse({ ...validProposal, targetId: "ord_9999" }).success).toBe(false);
  });

  it("forbids executing or approving with unsatisfied preconditions", () => {
    const missing = {
      ...validProposal,
      preconditions: [{ id: "pre_paid", description: "Order is paid", status: "missing" }],
    };
    expect(actionProposal.safeParse(missing).success).toBe(false);
    expect(actionProposal.safeParse({ ...missing, decision: "HUMAN_APPROVAL" }).success).toBe(false);
    expect(actionProposal.safeParse({ ...missing, decision: "VERIFY_FIRST" }).success).toBe(true);
  });

  it("rejects a malformed digest", () => {
    expect(actionProposal.safeParse({ ...validProposal, actionDigest: "not-a-hash" }).success).toBe(false);
  });
});

describe("Approval", () => {
  it("accepts a pending approval without an approver", () => {
    expect(approval.safeParse(pendingApproval).success).toBe(true);
  });

  it("requires an approver exactly when approved or denied", () => {
    expect(approval.safeParse({ ...pendingApproval, status: "approved" }).success).toBe(false);
    expect(approval.safeParse({ ...pendingApproval, status: "approved", approverId: "op_1" }).success).toBe(true);
    expect(approval.safeParse({ ...pendingApproval, approverId: "op_1" }).success).toBe(false);
    expect(approval.safeParse({ ...pendingApproval, status: "expired" }).success).toBe(true);
  });
});

describe("Question", () => {
  const base = {
    id: "q_1",
    taskId: "task_1",
    missingPreconditionIds: ["pre_order_id"],
    text: "Which order number is this about?",
    options: [],
    answer: null,
  };

  it("must be tied to at least one missing precondition", () => {
    expect(question.safeParse(base).success).toBe(true);
    expect(question.safeParse({ ...base, missingPreconditionIds: [] }).success).toBe(false);
  });

  it("rejects an empty answer", () => {
    expect(question.safeParse({ ...base, answer: "" }).success).toBe(false);
  });
});

describe("AuditEvent", () => {
  it("accepts a well-formed event and rejects unknown event types", () => {
    const event = {
      id: "evt_1",
      taskId: "task_1",
      sequence: 0,
      timestamp: NOW,
      type: "lookup",
      actorId: "local-operator",
      proposalId: null,
      operationId: null,
      evidenceIds: ["ev_1"],
      ruleIds: [],
      summary: "Looked up order ord_1001.",
      result: "success",
    };
    expect(auditEvent.safeParse(event).success).toBe(true);
    expect(auditEvent.safeParse({ ...event, type: "self_approve" }).success).toBe(false);
  });
});

describe("TaskSummary", () => {
  it("accepts a running task", () => {
    expect(taskSummary.safeParse(runningTask).success).toBe(true);
  });

  it("never reports completion without a verified result", () => {
    const result = { outcome: "Refunded 25.00 USD", operationIds: ["op_1"], verified: false, limitations: [] };
    expect(taskSummary.safeParse({ ...runningTask, status: "completed", result }).success).toBe(false);
    const verified = { ...result, verified: true };
    expect(taskSummary.safeParse({ ...runningTask, status: "completed", result: verified }).success).toBe(true);
    expect(taskSummary.safeParse({ ...runningTask, status: "partial", result }).success).toBe(true);
  });

  it("requires a result exactly for terminal statuses", () => {
    expect(taskSummary.safeParse({ ...runningTask, status: "failed" }).success).toBe(false);
    const result = { outcome: "Stopped", operationIds: [], verified: false, limitations: [] };
    expect(taskSummary.safeParse({ ...runningTask, result }).success).toBe(false);
  });

  it("pairs waiting statuses with the matching pending item", () => {
    expect(taskSummary.safeParse({ ...runningTask, status: "waiting_for_approval" }).success).toBe(false);
    expect(
      taskSummary.safeParse({ ...runningTask, status: "waiting_for_approval", approval: pendingApproval }).success,
    ).toBe(true);
    expect(taskSummary.safeParse({ ...runningTask, approval: pendingApproval }).success).toBe(false);
    expect(taskSummary.safeParse({ ...runningTask, status: "waiting_for_information" }).success).toBe(false);
  });

  it("rejects updatedAt earlier than createdAt", () => {
    expect(taskSummary.safeParse({ ...runningTask, updatedAt: "2026-10-13T11:00:00Z" }).success).toBe(false);
  });
});

describe("JSON Schema export", () => {
  it("emits a schema for every canonical contract", () => {
    for (const name of Object.keys(canonicalSchemas) as (keyof typeof canonicalSchemas)[]) {
      expect(toJsonSchema(name)).toHaveProperty("$schema");
    }
  });

  it("carries strictness and integer money into JSON Schema", () => {
    const schema = JSON.stringify(toJsonSchema("ActionProposal"));
    expect(schema).toContain('"additionalProperties":false');
    expect(schema).toContain('"type":"integer"');
    expect(schema).toContain('"const":"commit_refund"');
  });
});

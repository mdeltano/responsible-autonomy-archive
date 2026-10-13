import { describe, expect, it } from "vitest";
import { toolInputJsonSchema, toJsonSchema } from "../../src/contracts/json-schema.js";
import { plannerOutput, TOOL_NAMES, toolCall } from "../../src/contracts/planner.js";

describe("tool calls (spec §Internal agent tools)", () => {
  it("allowlists exactly the eight spec tools and no approval tool", () => {
    expect([...TOOL_NAMES].sort()).toEqual(
      [
        "check_refund_eligibility",
        "commit_refund",
        "lookup_customer",
        "lookup_order",
        "lookup_payment",
        "propose_refund",
        "record_resolution",
        "verify_refund",
      ].sort(),
    );
    expect(toolCall.safeParse({ tool: "approve_refund", arguments: { proposalId: "p1" } }).success).toBe(false);
  });

  it("validates arguments per tool", () => {
    expect(toolCall.safeParse({ tool: "lookup_order", arguments: { orderId: "ord_1" } }).success).toBe(true);
    expect(toolCall.safeParse({ tool: "lookup_order", arguments: { customerId: "c_1" } }).success).toBe(false);
    expect(toolCall.safeParse({ tool: "lookup_order", arguments: { orderId: "ord_1", force: true } }).success).toBe(
      false,
    );
    const refund = { orderId: "ord_1", amountMinor: 2500, currency: "USD", reason: "Damaged" };
    expect(toolCall.safeParse({ tool: "propose_refund", arguments: refund }).success).toBe(true);
    expect(toolCall.safeParse({ tool: "propose_refund", arguments: { ...refund, amountMinor: "2500" } }).success).toBe(
      false,
    );
  });

  it("does not let the planner choose an idempotency key for commits", () => {
    const commit = { tool: "commit_refund", arguments: { proposalId: "p1", idempotencyKey: "retry-2" } };
    expect(toolCall.safeParse(commit).success).toBe(false);
  });
});

describe("planner output (spec Step 6)", () => {
  it("accepts each of the four variants", () => {
    const outputs = [
      { kind: "tool_call", call: { tool: "lookup_payment", arguments: { orderId: "ord_1" } }, rationale: "Need balance" },
      { kind: "ask_question", missingPreconditionIds: ["pre_order"], text: "Which order?", options: [], rationale: "No ID" },
      { kind: "propose_resolution", orderId: "ord_1", resolution: "no_refund", reason: "Outside window", rationale: "Policy" },
      { kind: "finish", summary: "Refund verified", rationale: "Ledger confirmed" },
    ];
    for (const output of outputs) expect(plannerOutput.safeParse(output).success, output.kind).toBe(true);
  });

  it("rejects unknown kinds, missing rationale, and smuggled fields", () => {
    expect(plannerOutput.safeParse({ kind: "approve", rationale: "x" }).success).toBe(false);
    expect(plannerOutput.safeParse({ kind: "finish", summary: "Done" }).success).toBe(false);
    expect(plannerOutput.safeParse({ kind: "finish", summary: "Done", rationale: "r", status: "completed" }).success).toBe(
      false,
    );
    expect(
      plannerOutput.safeParse({
        kind: "tool_call",
        call: { tool: "lookup_order", arguments: { orderId: "ord_1" } },
        rationale: "r",
        confidence: 0.99,
      }).success,
    ).toBe(false);
  });

  it("requires questions to target missing preconditions", () => {
    const ask = { kind: "ask_question", missingPreconditionIds: [], text: "Anything else?", options: [], rationale: "r" };
    expect(plannerOutput.safeParse(ask).success).toBe(false);
  });

  it("keeps the rationale concise", () => {
    const finish = { kind: "finish", summary: "Done", rationale: "x".repeat(501) };
    expect(plannerOutput.safeParse(finish).success).toBe(false);
  });

  it("exports JSON Schema for the planner output and each tool input", () => {
    expect(JSON.stringify(toJsonSchema("PlannerOutput"))).toContain('"const":"propose_resolution"');
    for (const tool of TOOL_NAMES) {
      expect(toolInputJsonSchema(tool)).toMatchObject({ type: "object", additionalProperties: false });
    }
  });
});

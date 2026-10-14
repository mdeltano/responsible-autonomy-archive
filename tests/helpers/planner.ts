import type { PlannerInput, PlannerStep } from "../../src/agent/planner.js";

// Builders for scripted planner outputs. Outputs are plain objects, as untrusted as a model's.

export const tool = (name: string, args: Record<string, unknown>) => ({
  kind: "tool_call",
  call: { tool: name, arguments: args },
  rationale: "scripted",
});

export const finish = (summary = "Done.") => ({ kind: "finish", summary, rationale: "scripted" });

export const resolution = (orderId: string, value: "refund" | "no_refund") => ({
  kind: "propose_resolution",
  orderId,
  resolution: value,
  reason: "scripted",
  rationale: "scripted",
});

export const refund = (orderId: string, amountMinor: number) =>
  tool("propose_refund", { orderId, amountMinor, currency: "USD", reason: "Item arrived damaged" });

// The result of the most recent step that called `name`.
export function lastResult(input: PlannerInput, name: string): Record<string, unknown> {
  const step = input.history.findLast(
    (e): e is PlannerStep => e.type === "step" && (e.output.call as { tool?: string } | undefined)?.tool === name,
  );
  if (!step) throw new Error(`No ${name} step in history`);
  return step.result;
}

// Steps that commit and verify the most recent proposal, then record and finish.
export const commitLatest = () => (input: PlannerInput) => tool("commit_refund", { proposalId: lastResult(input, "propose_refund").proposalId });
export const verifyLatest = () => (input: PlannerInput) => tool("verify_refund", { operationId: lastResult(input, "commit_refund").operationId });

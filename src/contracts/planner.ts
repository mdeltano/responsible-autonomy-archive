import { z } from "zod";
import { refundArguments, resolutionArguments } from "./canonical.js";
import { boundedList, boundedText, nonEmptyNarrative, opaqueId } from "./primitives.js";

// Model-facing contracts (spec §Internal agent tools, Step 2, Step 6). Everything here describes
// untrusted planner output: parsing it only proves the shape. Scope, policy, and reference checks
// happen afterwards in the registry and gate.

// Allowlisted tools. There is deliberately no approval tool (spec Step 5): the planner cannot grant,
// request a role for, or record consent.
// The argument schemas also feed provider tool definitions (Step 8).
export const toolArgumentSchemas = {
  lookup_order: z.strictObject({ orderId: opaqueId }),
  lookup_customer: z.strictObject({ customerId: opaqueId }),
  lookup_payment: z.strictObject({ orderId: opaqueId }),
  check_refund_eligibility: z.strictObject({ orderId: opaqueId }),
  propose_refund: refundArguments,
  // Idempotency is scoped to the proposal by the engine; the planner cannot supply a retry key.
  commit_refund: z.strictObject({ proposalId: opaqueId }),
  verify_refund: z.strictObject({ operationId: opaqueId }),
  record_resolution: resolutionArguments,
} as const;

export type ToolName = keyof typeof toolArgumentSchemas;
export const TOOL_NAMES = Object.keys(toolArgumentSchemas) as ToolName[];

const toolVariant = <T extends ToolName>(tool: T) =>
  z.strictObject({ tool: z.literal(tool), arguments: toolArgumentSchemas[tool] });

export const toolCall = z.discriminatedUnion("tool", [
  toolVariant("lookup_order"),
  toolVariant("lookup_customer"),
  toolVariant("lookup_payment"),
  toolVariant("check_refund_eligibility"),
  toolVariant("propose_refund"),
  toolVariant("commit_refund"),
  toolVariant("verify_refund"),
  toolVariant("record_resolution"),
]);
export type ToolCall = z.infer<typeof toolCall>;
export type ToolArguments<T extends ToolName> = Extract<ToolCall, { tool: T }>["arguments"];

// A concise operational rationale, not chain-of-thought (spec Step 8).
const rationale = boundedText(1, 500);

export const plannerOutput = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("tool_call"), call: toolCall, rationale }),
  z.strictObject({
    kind: z.literal("ask_question"),
    missingPreconditionIds: boundedList(opaqueId).min(1),
    text: nonEmptyNarrative,
    options: boundedList(boundedText(1, 200)),
    rationale,
  }),
  // The planner's case-level conclusion. It has no effect by itself: the coordinator accepts it only
  // if verified facts support it (a verified refund operation, or evidence that none is due).
  z.strictObject({
    kind: z.literal("propose_resolution"),
    orderId: opaqueId,
    resolution: z.enum(["refund", "no_refund"]),
    reason: nonEmptyNarrative,
    rationale,
  }),
  // A request to stop. The application decides the terminal status; the model cannot claim one.
  z.strictObject({ kind: z.literal("finish"), summary: nonEmptyNarrative, rationale }),
]);
export type PlannerOutput = z.infer<typeof plannerOutput>;

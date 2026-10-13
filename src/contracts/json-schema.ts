import { z } from "zod";
import { actionProposal, approval, auditEvent, evidence, question, taskSummary } from "./canonical.js";
import { plannerOutput, toolArgumentSchemas, type ToolName } from "./planner.js";

// JSON Schema emitted from the zod source of truth (spec §Canonical contracts). Refinements that span
// several fields cannot be expressed in JSON Schema and are enforced only at runtime by zod.

export const contractSchemas = {
  Evidence: evidence,
  ActionProposal: actionProposal,
  Approval: approval,
  Question: question,
  AuditEvent: auditEvent,
  TaskSummary: taskSummary,
  PlannerOutput: plannerOutput,
} as const;

export type ContractSchemaName = keyof typeof contractSchemas;

export function toJsonSchema(name: ContractSchemaName): Record<string, unknown> {
  return z.toJSONSchema(contractSchemas[name]) as Record<string, unknown>;
}

// Input schema for one allowlisted tool, as sent to a provider in a tool definition.
export function toolInputJsonSchema(tool: ToolName): Record<string, unknown> {
  return z.toJSONSchema(toolArgumentSchemas[tool]) as Record<string, unknown>;
}

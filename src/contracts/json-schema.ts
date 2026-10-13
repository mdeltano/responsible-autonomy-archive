import { z } from "zod";
import { actionProposal, approval, auditEvent, evidence, question, taskSummary } from "./canonical.js";

// JSON Schema emitted from the zod source of truth (spec §Canonical contracts). Refinements that span
// several fields cannot be expressed in JSON Schema and are enforced only at runtime by zod.

export const canonicalSchemas = {
  Evidence: evidence,
  ActionProposal: actionProposal,
  Approval: approval,
  Question: question,
  AuditEvent: auditEvent,
  TaskSummary: taskSummary,
} as const;

export type CanonicalSchemaName = keyof typeof canonicalSchemas;

export function toJsonSchema(name: CanonicalSchemaName): Record<string, unknown> {
  return z.toJSONSchema(canonicalSchemas[name]) as Record<string, unknown>;
}

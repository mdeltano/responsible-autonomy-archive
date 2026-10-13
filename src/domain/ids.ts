import { randomUUID } from "node:crypto";

// Deterministic code owns IDs (spec §Policy rules); the planner never chooses one. IDs are opaque and
// match the opaqueId contract.
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

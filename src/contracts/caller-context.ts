import { z } from "zod";
import { boundedList, opaqueId, roleName } from "./primitives.js";

// Trusted caller context (spec Step 2, §Policy rules, §Security and privacy). Built only from
// configuration and trusted scenario definitions, never from goals, answers, or record notes.

export const PERMISSIONS = ["task:start", "task:read", "task:answer", "task:cancel", "evaluation:run"] as const;
export const permission = z.enum(PERMISSIONS);
export type Permission = z.infer<typeof permission>;

// Who is calling. Re-created from configuration on every service call so current authorization
// always applies.
export const callerIdentity = z.strictObject({
  ownerId: opaqueId,
  actorId: opaqueId,
  roles: boundedList(roleName),
  permissions: boundedList(permission),
});
export type CallerIdentity = z.infer<typeof callerIdentity>;

// Which synthetic records the task may touch. customerIds lists the authorized customers; a non-empty
// orderIds narrows access further to those orders only.
export const customerScope = z.strictObject({
  customerIds: boundedList(opaqueId).min(1),
  orderIds: boundedList(opaqueId),
});
export type CustomerScope = z.infer<typeof customerScope>;

// Identity plus scope. Saved as a snapshot when a task starts.
export const callerContext = z.strictObject({
  ...callerIdentity.shape,
  scope: customerScope,
});
export type CallerContext = z.infer<typeof callerContext>;

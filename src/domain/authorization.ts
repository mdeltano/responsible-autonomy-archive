import type { Config } from "../config.js";
import {
  callerContext,
  callerIdentity,
  type CallerContext,
  type CallerIdentity,
  type CustomerScope,
  type Permission,
} from "../contracts/caller-context.js";
import { AppError, notFound } from "../contracts/errors.js";

// Authorization over trusted caller context (spec Step 2, §Policy rules, §Security and privacy).
// Nothing here accepts natural-language input: identity comes from configuration and scope from the
// trusted scenario definition.

const BASE_PERMISSIONS: readonly Permission[] = ["task:start", "task:read", "task:answer", "task:cancel"];

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

// The local single-owner demo identity: a documented demo assumption, not authentication.
export function createCallerIdentity(
  config: Pick<Config, "localOwnerId" | "localActorId" | "localRoles" | "evaluationEnabled">,
): CallerIdentity {
  const permissions: Permission[] = [...BASE_PERMISSIONS];
  if (config.evaluationEnabled) permissions.push("evaluation:run");
  return deepFreeze(
    callerIdentity.parse({
      ownerId: config.localOwnerId,
      actorId: config.localActorId,
      roles: [...config.localRoles],
      permissions,
    }),
  );
}

// Snapshot saved with a task when it starts.
export function bindTaskContext(identity: CallerIdentity, scope: CustomerScope): CallerContext {
  return deepFreeze(callerContext.parse({ ...identity, scope }));
}

// Context for a fresh call on an existing task. A different owner sees the same NOT_FOUND as an
// unknown task. Roles and permissions come from the current identity, so a revoked role takes effect
// immediately; scope comes from the snapshot because nothing after task start may widen it.
export function contextForCall(snapshot: CallerContext, current: CallerIdentity): CallerContext {
  if (snapshot.ownerId !== current.ownerId) throw notFound();
  return deepFreeze(callerContext.parse({ ...current, scope: snapshot.scope }));
}

// Owner check for stored artifacts (tasks, proposals, approvals, audit, reports).
export function assertOwner(context: Pick<CallerIdentity, "ownerId">, resourceOwnerId: string): void {
  if (context.ownerId !== resourceOwnerId) throw notFound();
}

export function hasPermission(context: CallerIdentity, permission: Permission): boolean {
  return context.permissions.includes(permission);
}

export function requirePermission(context: CallerIdentity, permission: Permission, taskId: string | null = null): void {
  if (!hasPermission(context, permission)) {
    throw new AppError("UNAUTHORIZED", `Caller lacks permission ${permission}`, { taskId });
  }
}

export function requireRole(context: CallerIdentity, role: string, taskId: string | null = null): void {
  if (!context.roles.includes(role)) {
    throw new AppError("UNAUTHORIZED", `Caller lacks role ${role}`, { taskId });
  }
}

export function canAccessCustomer(context: CallerContext, customerId: string): boolean {
  return context.scope.customerIds.includes(customerId);
}

// An order is in scope only when its owning customer, read from the trusted record, is authorized. A
// supplied order ID selects a record; it never establishes authority over it (spec §Internal agent tools).
export function canAccessOrder(context: CallerContext, order: { orderId: string; customerId: string }): boolean {
  if (!canAccessCustomer(context, order.customerId)) return false;
  return context.scope.orderIds.length === 0 || context.scope.orderIds.includes(order.orderId);
}

import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { callerContext } from "../../src/contracts/caller-context.js";
import { AppError } from "../../src/contracts/errors.js";
import {
  assertOwner,
  bindTaskContext,
  canAccessCustomer,
  canAccessOrder,
  contextForCall,
  createCallerIdentity,
  requirePermission,
  requireRole,
} from "../../src/domain/authorization.js";

const config = loadConfig({ LOCAL_ROLES: "refund_approver" });
const identity = createCallerIdentity(config);
const scope = { customerIds: ["C-100"], orderIds: [] };

function errorOf(fn: () => unknown): AppError {
  try {
    fn();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error("expected an AppError");
}

describe("caller identity (spec Step 2)", () => {
  it("is built from configuration", () => {
    expect(identity).toEqual({
      ownerId: "local-owner",
      actorId: "local-operator",
      roles: ["refund_approver"],
      permissions: ["task:start", "task:read", "task:answer", "task:cancel"],
    });
  });

  it("grants evaluation only when enabled", () => {
    const evaluator = createCallerIdentity(loadConfig({ EVALUATION_ENABLED: "true" }));
    expect(evaluator.permissions).toContain("evaluation:run");
    expect(() => requirePermission(identity, "evaluation:run")).toThrow(AppError);
  });

  it("has no roles unless configured", () => {
    const plain = createCallerIdentity(loadConfig({}));
    expect(errorOf(() => requireRole(plain, "refund_approver", "task_1")).toPublic()).toMatchObject({
      code: "UNAUTHORIZED",
      taskId: "task_1",
    });
    expect(() => requireRole(identity, "refund_approver")).not.toThrow();
  });

  it("is immutable", () => {
    expect(() => (identity.roles as string[]).push("admin")).toThrow(TypeError);
  });
});

describe("task context snapshot", () => {
  const snapshot = bindTaskContext(identity, scope);

  it("binds identity to the trusted scope and round-trips through the schema", () => {
    expect(callerContext.parse(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
  });

  it("rejects malformed or empty scope", () => {
    expect(() => bindTaskContext(identity, { customerIds: [], orderIds: [] })).toThrow();
    expect(() => bindTaskContext(identity, { customerIds: ["C-100"], orderIds: [], all: true } as never)).toThrow();
  });

  it("cannot be widened after binding", () => {
    expect(() => (snapshot.scope.customerIds as string[]).push("C-999")).toThrow(TypeError);
  });

  it("applies current roles on fresh calls but keeps the snapshot scope", () => {
    const revoked = createCallerIdentity(loadConfig({}));
    const context = contextForCall(snapshot, revoked);
    expect(context.roles).toEqual([]);
    expect(context.scope).toEqual(scope);
    expect(() => requireRole(context, "refund_approver")).toThrow(AppError);
  });

  it("hides another owner's task behind NOT_FOUND", () => {
    const stranger = createCallerIdentity(loadConfig({ LOCAL_OWNER_ID: "other-owner" }));
    const error = errorOf(() => contextForCall(snapshot, stranger));
    expect(error.toPublic()).toEqual({ code: "NOT_FOUND", message: "Resource not found", retryable: false, taskId: null });
    expect(errorOf(() => assertOwner(stranger, "local-owner")).toPublic()).toEqual(error.toPublic());
  });
});

describe("record scope checks", () => {
  const snapshot = bindTaskContext(identity, scope);

  it("allows orders owned by an authorized customer", () => {
    expect(canAccessCustomer(snapshot, "C-100")).toBe(true);
    expect(canAccessOrder(snapshot, { orderId: "O-100", customerId: "C-100" })).toBe(true);
  });

  it("denies orders of other customers even when the order ID is known", () => {
    expect(canAccessCustomer(snapshot, "C-200")).toBe(false);
    expect(canAccessOrder(snapshot, { orderId: "O-200", customerId: "C-200" })).toBe(false);
  });

  it("narrows to listed orders when orderIds is set", () => {
    const narrow = bindTaskContext(identity, { customerIds: ["C-100"], orderIds: ["O-100"] });
    expect(canAccessOrder(narrow, { orderId: "O-100", customerId: "C-100" })).toBe(true);
    expect(canAccessOrder(narrow, { orderId: "O-101", customerId: "C-100" })).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AppError, notFound, parseInput, toPublicError } from "../../src/contracts/errors.js";

describe("typed application errors (spec §Reliability and limits)", () => {
  it("serializes to {code, message, retryable, taskId}", () => {
    const error = new AppError("STATE_CONFLICT", "Ledger version changed", { taskId: "task_1" });
    expect(error.toPublic()).toEqual({
      code: "STATE_CONFLICT",
      message: "Ledger version changed",
      retryable: true,
      taskId: "task_1",
    });
  });

  it("defaults retryability by code and allows an explicit override", () => {
    expect(new AppError("TIMEOUT", "t").retryable).toBe(true);
    expect(new AppError("INVALID_INPUT", "i").retryable).toBe(false);
    expect(new AppError("UNAUTHORIZED", "u").retryable).toBe(false);
    expect(new AppError("PROVIDER_UNAVAILABLE", "p", { retryable: false }).retryable).toBe(false);
  });

  it("makes unknown and foreign-owner lookups indistinguishable", () => {
    expect(notFound().toPublic()).toEqual(notFound().toPublic());
    expect(notFound().message).not.toMatch(/owner|exist|access/i);
  });

  it("converts schema failures to INVALID_INPUT naming paths, not values", () => {
    const schema = z.strictObject({ goal: z.string().min(10) });
    let caught: unknown;
    try {
      parseInput(schema, { goal: "sk-secret", extra: 1 }, "task_9");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppError);
    const publicError = (caught as AppError).toPublic();
    expect(publicError.code).toBe("INVALID_INPUT");
    expect(publicError.taskId).toBe("task_9");
    expect(publicError.message).toMatch(/goal/);
    expect(publicError.message).not.toContain("sk-secret");
  });

  it("returns parsed data when input is valid", () => {
    expect(parseInput(z.strictObject({ n: z.int() }), { n: 3 })).toEqual({ n: 3 });
  });

  it("bounds messages built from untrusted key names", () => {
    const schema = z.strictObject({});
    const input = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}${"x".repeat(500)}`, i]));
    const message = toPublicError(captureError(() => parseInput(schema, input))).message;
    expect(message.length).toBeLessThan(1500);
  });

  it("hides details of unexpected errors", () => {
    expect(toPublicError(new Error("db path /secret/file"), "task_2")).toEqual({
      code: "INTERNAL_ERROR",
      message: "Internal error",
      retryable: false,
      taskId: "task_2",
    });
  });
});

function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected an error");
}

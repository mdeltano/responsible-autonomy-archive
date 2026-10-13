import type { z } from "zod";

// Typed application errors (spec §Reliability and limits, §Security and privacy). Interfaces map these
// into their own formats; services never throw untyped errors across their boundary.

export const ERROR_CODES = [
  "INVALID_INPUT",
  "NOT_FOUND",
  "UNAUTHORIZED",
  "STATE_CONFLICT",
  "APPROVAL_EXPIRED",
  "IDEMPOTENCY_CONFLICT",
  "PROVIDER_UNAVAILABLE",
  "INVALID_MODEL_OUTPUT",
  "BUDGET_EXCEEDED",
  "TIMEOUT",
  "INTERNAL_ERROR",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

// Transient failures a caller may retry unchanged. STATE_CONFLICT is retryable because a fresh read
// and a new proposal can succeed; it never permits repeating the same write blindly.
const RETRYABLE_BY_DEFAULT: ReadonlySet<ErrorCode> = new Set(["STATE_CONFLICT", "PROVIDER_UNAVAILABLE", "TIMEOUT"]);

export interface PublicError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  taskId: string | null;
}

export class AppError extends Error {
  override name = "AppError";
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly taskId: string | null;

  constructor(
    code: ErrorCode,
    message: string,
    options: { taskId?: string | null; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.retryable = options.retryable ?? RETRYABLE_BY_DEFAULT.has(code);
    this.taskId = options.taskId ?? null;
  }

  toPublic(): PublicError {
    return { code: this.code, message: this.message, retryable: this.retryable, taskId: this.taskId };
  }
}

// Unknown and foreign-owner IDs produce the identical error, so the response cannot be used to probe
// for other owners' records (spec §Security and privacy). The requested ID is deliberately not echoed.
export function notFound(taskId: string | null = null): AppError {
  return new AppError("NOT_FOUND", "Resource not found", { taskId });
}

const MAX_REPORTED_ISSUES = 5;
const MAX_ISSUE_LENGTH = 200;

// Describes failing fields by path and rule only. Input values are never echoed, and issue text is
// truncated because unrecognized key names come from untrusted input.
export function invalidInput(error: z.ZodError, taskId: string | null = null): AppError {
  const issues = error.issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.map(String).join(".") : "(root)";
    return `${path}: ${issue.message}`.slice(0, MAX_ISSUE_LENGTH);
  });
  const more = error.issues.length - issues.length;
  const suffix = more > 0 ? `; and ${more} more` : "";
  return new AppError("INVALID_INPUT", `Invalid input: ${issues.join("; ")}${suffix}`, { taskId, cause: error });
}

// Parse untrusted input against a schema, converting failures into a typed INVALID_INPUT error.
export function parseInput<T extends z.ZodType>(schema: T, input: unknown, taskId: string | null = null): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) throw invalidInput(result.error, taskId);
  return result.data;
}

export function toPublicError(error: unknown, taskId: string | null = null): PublicError {
  if (error instanceof AppError) return error.toPublic();
  // Unexpected failures are reported generically; details go to stderr diagnostics, not callers.
  return { code: "INTERNAL_ERROR", message: "Internal error", retryable: false, taskId };
}

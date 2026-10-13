import { z } from "zod";

// Shared primitive schemas (spec §Canonical contracts, §Application service interface, Step 2). Every
// contract composes these so limits are defined once. Objects built from them use z.strictObject so
// unknown keys are rejected.

export const ID_MAX_LENGTH = 128;
export const NARRATIVE_MAX_LENGTH = 2000;
export const LIST_MAX_LENGTH = 20;

// Opaque identifier, 1–128 characters. The character set is narrower than the spec requires (see
// DECISIONS.md) so IDs are safe to place in logs, idempotency keys, and error messages verbatim.
export const opaqueId = z
  .string()
  .min(1)
  .max(ID_MAX_LENGTH)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "must be an opaque ID of letters, digits, '.', '_', ':' or '-'");
export type OpaqueId = z.infer<typeof opaqueId>;

// Caller-supplied idempotency key for startTask: same limits as an ID.
export const idempotencyKey = opaqueId;

export const roleName = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, "must be a lowercase role name");
export type RoleName = z.infer<typeof roleName>;

// Three-letter uppercase code. Membership in the configured or policy currencies is checked by the
// caller; no conversion between currencies is ever inferred (spec §Policy rules).
export const currencyCode = z.string().regex(/^[A-Z]{3}$/, "must be a three-letter uppercase currency code");
export type CurrencyCode = z.infer<typeof currencyCode>;

// Money and counters are safe integers (z.int() rejects floats and values beyond MAX_SAFE_INTEGER).
export const minorUnits = z.int().nonnegative();
export const positiveMinorUnits = z.int().positive();
export const recordVersion = z.int().nonnegative();
export const counter = z.int().nonnegative();

// UTC ISO 8601 timestamp with a trailing "Z"; offsets are rejected so ordering is lexical.
export const utcTimestamp = z.iso.datetime();
export type UtcTimestamp = z.infer<typeof utcTimestamp>;

// Lowercase hex SHA-256, e.g. actionDigest (spec §Policy rules).
export const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/, "must be a lowercase hex SHA-256 digest");

export const boundedText = (min: number, max: number) => z.string().min(min).max(max);

// Narrative fields (explanations, summaries, notes) are capped at 2000 characters.
export const narrative = boundedText(0, NARRATIVE_MAX_LENGTH);
export const nonEmptyNarrative = boundedText(1, NARRATIVE_MAX_LENGTH);

export const boundedList = <T extends z.ZodType>(item: T, max: number = LIST_MAX_LENGTH) =>
  z.array(item).max(max);

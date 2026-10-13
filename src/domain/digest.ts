import { createHash } from "node:crypto";
import type { CallerContext } from "../contracts/caller-context.js";
import type { StateVersions } from "../contracts/canonical.js";

// Canonical JSON and actionDigest (spec §Policy rules, Step 4). Object keys are sorted recursively and
// arrays keep their order, so logically equal actions produce byte-identical JSON regardless of key
// order. Only plain JSON data is accepted; anything ambiguous (undefined, NaN, Dates, class instances)
// is rejected rather than silently coerced.

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON rejects non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new TypeError("Canonical JSON accepts only plain objects");
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    for (const [key, child] of entries) {
      if (child === undefined) throw new TypeError(`Canonical JSON rejects undefined at key ${key}`);
    }
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  throw new TypeError(`Canonical JSON rejects ${typeof value}`);
}

export interface DigestInput {
  tool: string;
  arguments: Record<string, unknown>;
  targetId: string;
  context: Pick<CallerContext, "ownerId" | "scope">;
  policyVersion: string;
  stateVersions: StateVersions;
}

// SHA-256 over tool, exact arguments, target, caller scope, policy version, and relevant state versions.
// Approvals bind to this value, so changing any of them requires a new approval.
export function actionDigest(input: DigestInput): string {
  const canonical = canonicalJson({
    tool: input.tool,
    arguments: input.arguments,
    targetId: input.targetId,
    callerScope: { ownerId: input.context.ownerId, scope: input.context.scope },
    policyVersion: input.policyVersion,
    stateVersions: input.stateVersions,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

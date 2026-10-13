import { readFileSync } from "node:fs";
import { ConfigError } from "../config.js";
import { refundPolicy, type RefundPolicy } from "../contracts/policy.js";

// Loads the versioned policy named by POLICY_PATH (spec §Policy rules). An unreadable or invalid policy
// stops startup; the application never runs on a partial or default policy.
export function loadPolicyFile(path: string): RefundPolicy {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ConfigError(`Cannot read policy file at POLICY_PATH (${path})`, { cause: error });
  }
  const parsed = refundPolicy.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new ConfigError(`Invalid policy file at POLICY_PATH: ${issues}`);
  }
  return Object.freeze(parsed.data);
}

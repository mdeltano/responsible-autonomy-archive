import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../src/config.js";
import { refundPolicy } from "../../src/contracts/policy.js";
import { ManualClock, toUtcTimestamp } from "../../src/domain/clock.js";
import { loadPolicyFile } from "../../src/storage/policy-file.js";

describe("refund policy (spec §Policy rules)", () => {
  it("loads the shipped v1 policy from the default POLICY_PATH", () => {
    const policy = loadPolicyFile(loadConfig({}).policyPath);
    expect(policy).toEqual({
      version: "refund-policy.v1",
      approverRole: "refund_approver",
      currencies: { USD: { autoExecuteMaxMinor: 5000 } },
    });
  });

  it("rejects unknown keys, float thresholds, and empty currency maps", () => {
    const base = { version: "p1", approverRole: "refund_approver", currencies: { USD: { autoExecuteMaxMinor: 5000 } } };
    expect(refundPolicy.safeParse({ ...base, allowAll: true }).success).toBe(false);
    expect(refundPolicy.safeParse({ ...base, currencies: { USD: { autoExecuteMaxMinor: 50.5 } } }).success).toBe(false);
    expect(refundPolicy.safeParse({ ...base, currencies: { usd: { autoExecuteMaxMinor: 1 } } }).success).toBe(false);
    expect(refundPolicy.safeParse({ ...base, currencies: {} }).success).toBe(false);
  });

  it("fails startup on a missing or invalid policy file", () => {
    const dir = mkdtempSync(join(tmpdir(), "policy-"));
    expect(() => loadPolicyFile(join(dir, "absent.json"))).toThrow(ConfigError);
    const invalid = join(dir, "invalid.json");
    writeFileSync(invalid, JSON.stringify({ version: "p1" }));
    expect(() => loadPolicyFile(invalid)).toThrow(/approverRole/);
  });
});

describe("ManualClock", () => {
  it("moves only forward and only when told", () => {
    const clock = new ManualClock("2026-10-13T12:00:00Z");
    clock.advance(1000);
    expect(toUtcTimestamp(clock.now())).toBe("2026-10-13T12:00:01.000Z");
    expect(() => clock.advance(-1)).toThrow(RangeError);
    expect(() => new ManualClock("not a time")).toThrow(RangeError);
  });
});

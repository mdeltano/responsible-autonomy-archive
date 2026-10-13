import { describe, expect, it } from "vitest";
import { actionDigest, canonicalJson, type DigestInput } from "../../src/domain/digest.js";

const base: DigestInput = {
  tool: "commit_refund",
  arguments: { orderId: "O-100", amountMinor: 12000, currency: "USD", reason: "Motor failed" },
  targetId: "O-100",
  context: { ownerId: "local-owner", scope: { customerIds: ["C-100"], orderIds: [] } },
  policyVersion: "refund-policy.v1",
  stateVersions: { "O-100": 0, "P-100": 0 },
};

describe("canonicalJson (spec §Policy rules)", () => {
  it("sorts keys recursively and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1], c: "x" } })).toBe('{"a":{"c":"x","d":[3,1]},"b":1}');
  });

  it("rejects values without one unambiguous JSON form", () => {
    expect(() => canonicalJson({ a: undefined })).toThrow(TypeError);
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalJson({ a: new Date(0) })).toThrow(TypeError);
    expect(() => canonicalJson({ a: 1n })).toThrow(TypeError);
  });
});

describe("actionDigest (spec Step 4)", () => {
  it("is a stable lowercase SHA-256", () => {
    expect(actionDigest(base)).toMatch(/^[a-f0-9]{64}$/);
    expect(actionDigest(base)).toBe(actionDigest(structuredClone(base)));
  });

  it("ignores object key order", () => {
    const reordered: DigestInput = {
      stateVersions: { "P-100": 0, "O-100": 0 },
      policyVersion: base.policyVersion,
      context: { scope: { orderIds: [], customerIds: ["C-100"] }, ownerId: "local-owner" },
      targetId: base.targetId,
      arguments: { reason: "Motor failed", currency: "USD", amountMinor: 12000, orderId: "O-100" },
      tool: base.tool,
    };
    expect(actionDigest(reordered)).toBe(actionDigest(base));
  });

  it.each([
    ["amount", { arguments: { ...base.arguments, amountMinor: 11999 } }],
    ["reason", { arguments: { ...base.arguments, reason: "Motor failed." } }],
    ["target", { targetId: "O-101" }],
    ["tool", { tool: "record_resolution" }],
    ["state version", { stateVersions: { "O-100": 0, "P-100": 1 } }],
    ["policy version", { policyVersion: "refund-policy.v2" }],
    ["owner", { context: { ...base.context, ownerId: "other-owner" } }],
    ["scope", { context: { ...base.context, scope: { customerIds: ["C-100", "C-200"], orderIds: [] } } }],
  ])("changes when the %s changes", (_name, change) => {
    expect(actionDigest({ ...base, ...change })).not.toBe(actionDigest(base));
  });
});

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  boundedList,
  currencyCode,
  minorUnits,
  narrative,
  opaqueId,
  positiveMinorUnits,
  recordVersion,
  roleName,
  sha256Hex,
  utcTimestamp,
} from "../../src/contracts/primitives.js";

describe("contract primitives (spec §Canonical contracts)", () => {
  it("accepts opaque IDs of 1–128 safe characters", () => {
    expect(opaqueId.safeParse("ord_1001").success).toBe(true);
    expect(opaqueId.safeParse("task:2026-10-13.a").success).toBe(true);
    expect(opaqueId.safeParse("a".repeat(128)).success).toBe(true);
  });

  it("rejects empty, oversized, or unsafe IDs", () => {
    for (const bad of ["", "a".repeat(129), "has space", "-leading", "line\nbreak", "../etc", 42]) {
      expect(opaqueId.safeParse(bad).success, String(bad)).toBe(false);
    }
  });

  it("requires three-letter uppercase currency codes", () => {
    expect(currencyCode.safeParse("USD").success).toBe(true);
    for (const bad of ["usd", "US", "USDT", "U$D"]) expect(currencyCode.safeParse(bad).success).toBe(false);
  });

  it("keeps money and versions to safe integers", () => {
    expect(minorUnits.safeParse(0).success).toBe(true);
    expect(minorUnits.safeParse(Number.MAX_SAFE_INTEGER).success).toBe(true);
    for (const bad of [-1, 12.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Infinity, "100"]) {
      expect(minorUnits.safeParse(bad).success, String(bad)).toBe(false);
    }
    expect(positiveMinorUnits.safeParse(0).success).toBe(false);
    expect(recordVersion.safeParse(-1).success).toBe(false);
  });

  it("accepts only UTC timestamps", () => {
    expect(utcTimestamp.safeParse("2026-10-13T12:00:00Z").success).toBe(true);
    expect(utcTimestamp.safeParse("2026-10-13T12:00:00.123Z").success).toBe(true);
    expect(utcTimestamp.safeParse("2026-10-13T12:00:00+02:00").success).toBe(false);
    expect(utcTimestamp.safeParse("2026-10-13").success).toBe(false);
  });

  it("validates role names and digests", () => {
    expect(roleName.safeParse("refund_approver").success).toBe(true);
    expect(roleName.safeParse("Refund Approver").success).toBe(false);
    expect(sha256Hex.safeParse("a".repeat(64)).success).toBe(true);
    expect(sha256Hex.safeParse("A".repeat(64)).success).toBe(false);
  });

  it("caps narratives at 2000 characters and lists at 20 entries", () => {
    expect(narrative.safeParse("x".repeat(2000)).success).toBe(true);
    expect(narrative.safeParse("x".repeat(2001)).success).toBe(false);
    const ids = boundedList(opaqueId);
    expect(ids.safeParse(Array.from({ length: 20 }, (_, i) => `id${i}`)).success).toBe(true);
    expect(ids.safeParse(Array.from({ length: 21 }, (_, i) => `id${i}`)).success).toBe(false);
    expect(boundedList(z.string(), 2).safeParse(["a", "b", "c"]).success).toBe(false);
  });
});

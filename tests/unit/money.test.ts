import { describe, expect, it } from "vitest";
import { addMoney, compareMoney, money, subtractMoney, sumMoney } from "../../src/domain/money.js";

describe("money in minor units (spec §Internal agent tools)", () => {
  it("adds, subtracts, and compares within one currency", () => {
    expect(addMoney(money(1999, "USD"), money(1, "USD"))).toEqual({ amountMinor: 2000, currency: "USD" });
    expect(subtractMoney(money(5000, "USD"), money(1250, "USD")).amountMinor).toBe(3750);
    expect(compareMoney(money(5000, "USD"), money(5001, "USD"))).toBe(-1);
    expect(compareMoney(money(5000, "USD"), money(5000, "USD"))).toBe(0);
    expect(sumMoney([money(100, "USD"), money(250, "USD")], "USD").amountMinor).toBe(350);
    expect(sumMoney([], "EUR")).toEqual({ amountMinor: 0, currency: "EUR" });
  });

  it("rejects floats, negatives, and invalid currencies at construction", () => {
    expect(() => money(10.5, "USD")).toThrow();
    expect(() => money(-1, "USD")).toThrow();
    expect(() => money(100, "usd")).toThrow();
  });

  it("never mixes currencies or infers a conversion", () => {
    expect(() => addMoney(money(100, "USD"), money(100, "EUR"))).toThrow(/Currency mismatch/);
    expect(() => compareMoney(money(100, "USD"), money(100, "EUR"))).toThrow(/Currency mismatch/);
  });

  it("refuses to go negative or beyond the safe-integer range", () => {
    expect(() => subtractMoney(money(100, "USD"), money(101, "USD"))).toThrow(RangeError);
    expect(() => addMoney(money(Number.MAX_SAFE_INTEGER, "USD"), money(1, "USD"))).toThrow(RangeError);
  });

  it("returns immutable values", () => {
    expect(Object.isFrozen(money(1, "USD"))).toBe(true);
  });
});

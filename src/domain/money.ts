import { currencyCode, minorUnits, type CurrencyCode } from "../contracts/primitives.js";

// Money in safe-integer minor units (spec §Internal agent tools, §Policy rules). There is no floating-
// point arithmetic and no currency conversion. Mixing currencies or leaving the safe-integer range is
// an invariant violation: the gate rejects mismatched currencies before any arithmetic happens.

export interface Money {
  readonly amountMinor: number;
  readonly currency: CurrencyCode;
}

export function money(amountMinor: number, currency: string): Money {
  return Object.freeze({ amountMinor: minorUnits.parse(amountMinor), currency: currencyCode.parse(currency) });
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new RangeError(`Currency mismatch: ${a.currency} vs ${b.currency}`);
  }
}

function checked(amountMinor: number, currency: CurrencyCode): Money {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
    throw new RangeError("Money result is outside the non-negative safe-integer range");
  }
  return Object.freeze({ amountMinor, currency });
}

export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return checked(a.amountMinor + b.amountMinor, a.currency);
}

// Throws rather than going negative; callers compare first when a shortfall is a business outcome.
export function subtractMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return checked(a.amountMinor - b.amountMinor, a.currency);
}

export function sumMoney(items: readonly Money[], currency: CurrencyCode): Money {
  return items.reduce(addMoney, money(0, currency));
}

export function compareMoney(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  return a.amountMinor < b.amountMinor ? -1 : a.amountMinor > b.amountMinor ? 1 : 0;
}

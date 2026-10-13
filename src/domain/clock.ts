// Injectable clock (spec Step 2). Domain code receives time from a Clock so refund-window and approval
// expiry tests are repeatable. Time is epoch milliseconds; timestamps are rendered as UTC ISO strings.

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export function toUtcTimestamp(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

export function parseUtcTimestamp(timestamp: string): number {
  const epochMs = Date.parse(timestamp);
  if (Number.isNaN(epochMs)) throw new RangeError("Invalid UTC timestamp");
  return epochMs;
}

// Test and demo clock that only moves when told to.
export class ManualClock implements Clock {
  #epochMs: number;

  constructor(start: string | number) {
    this.#epochMs = typeof start === "string" ? parseUtcTimestamp(start) : start;
  }

  now(): number {
    return this.#epochMs;
  }

  advance(ms: number): void {
    if (!Number.isSafeInteger(ms) || ms < 0) throw new RangeError("ManualClock only moves forward by whole ms");
    this.#epochMs += ms;
  }
}

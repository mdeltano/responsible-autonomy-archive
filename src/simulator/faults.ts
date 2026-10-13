import type { Database } from "../storage/database.js";

// Test-harness fault controls (spec Step 3): delay lookups, change state, throw before commit, and lose
// the acknowledgment after commit. They are constructor options of the storefront that only tests
// and the evaluation harness create. No agent tool, prompt, or service input can reach them.

export type ArmableFault = "fail_before_commit" | "lose_ack_after_commit";

export class FaultInjector {
  lookupDelayMs = 0;
  #armed = new Set<ArmableFault>();
  #stateChanges: ((db: Database) => void)[] = [];

  // Fires once, on the next commit.
  arm(fault: ArmableFault): void {
    this.#armed.add(fault);
  }

  // Runs once, just before the next commit transaction, as a concurrent writer would.
  changeStateBeforeCommit(change: (db: Database) => void): void {
    this.#stateChanges.push(change);
  }

  take(fault: ArmableFault): boolean {
    return this.#armed.delete(fault);
  }

  applyStateChanges(db: Database): void {
    const changes = this.#stateChanges.splice(0);
    for (const change of changes) change(db);
  }
}

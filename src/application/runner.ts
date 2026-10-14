import type { Logger } from "../agent/log.js";

// In-process task runner (spec §Reliability and limits, Step 6). At most `maxActivePerOwner` loops run
// per owner; the rest wait in a FIFO queue capped at `maxQueuedPerOwner`. A task holds a slot only
// while its loop runs: pausing for an answer or approval ends the loop and frees the slot. A task is
// never queued or run twice at once, so duplicate resume events cannot start duplicate loops.

export interface RunnerOptions {
  maxActivePerOwner: number;
  maxQueuedPerOwner: number;
  execute: (taskId: string, signal: AbortSignal) => Promise<void>;
  log: Logger;
}

interface Entry {
  taskId: string;
  ownerId: string;
}

export class TaskRunner {
  readonly #options: RunnerOptions;
  readonly #queue: Entry[] = [];
  readonly #active = new Map<string, { ownerId: string; controller: AbortController }>();
  readonly #idleWaiters = new Map<string, (() => void)[]>();

  constructor(options: RunnerOptions) {
    this.#options = options;
  }

  queuedCount(ownerId: string): number {
    return this.#queue.filter((e) => e.ownerId === ownerId).length;
  }

  activeCount(ownerId: string): number {
    return [...this.#active.values()].filter((a) => a.ownerId === ownerId).length;
  }

  // Whether one more task fits. Entries that will take a free worker slot on the next tick do not
  // count against the queue limit.
  hasCapacity(ownerId: string): boolean {
    const freeSlots = Math.max(0, this.#options.maxActivePerOwner - this.activeCount(ownerId));
    return this.queuedCount(ownerId) - freeSlots < this.#options.maxQueuedPerOwner;
  }

  isBusy(taskId: string): boolean {
    return this.#active.has(taskId) || this.#queue.some((e) => e.taskId === taskId);
  }

  isActive(taskId: string): boolean {
    return this.#active.has(taskId);
  }

  // Schedules a task. Starting is deferred to a later tick, so callers return promptly.
  enqueue(taskId: string, ownerId: string): void {
    if (this.isBusy(taskId)) return;
    this.#queue.push({ taskId, ownerId });
    setImmediate(() => this.#pump());
  }

  // Removes a task that has not started yet. Returns true if it was waiting in the queue.
  dequeue(taskId: string): boolean {
    const index = this.#queue.findIndex((e) => e.taskId === taskId);
    if (index < 0) return false;
    this.#queue.splice(index, 1);
    this.#notifyIfIdle(taskId);
    return true;
  }

  abort(taskId: string): void {
    this.#active.get(taskId)?.controller.abort();
  }

  // Resolves once the task is neither queued nor running.
  whenIdle(taskId: string): Promise<void> {
    if (!this.isBusy(taskId)) return Promise.resolve();
    return new Promise((resolve) => {
      const waiters = this.#idleWaiters.get(taskId) ?? [];
      waiters.push(resolve);
      this.#idleWaiters.set(taskId, waiters);
    });
  }

  #pump(): void {
    for (let i = 0; i < this.#queue.length; ) {
      const entry = this.#queue[i];
      if (!entry || this.activeCount(entry.ownerId) >= this.#options.maxActivePerOwner) {
        i++;
        continue;
      }
      this.#queue.splice(i, 1);
      this.#start(entry);
    }
  }

  #start(entry: Entry): void {
    const controller = new AbortController();
    this.#active.set(entry.taskId, { ownerId: entry.ownerId, controller });
    this.#options
      .execute(entry.taskId, controller.signal)
      .catch((error: unknown) => {
        this.#options.log.log("error", "task execution failed", {
          taskId: entry.taskId,
          error: error instanceof Error ? error.name : "unknown",
        });
      })
      .finally(() => {
        this.#active.delete(entry.taskId);
        this.#notifyIfIdle(entry.taskId);
        this.#pump();
      });
  }

  #notifyIfIdle(taskId: string): void {
    if (this.isBusy(taskId)) return;
    const waiters = this.#idleWaiters.get(taskId) ?? [];
    this.#idleWaiters.delete(taskId);
    for (const resolve of waiters) resolve();
  }
}

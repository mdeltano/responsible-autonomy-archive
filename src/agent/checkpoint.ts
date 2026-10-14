import { z } from "zod";
import { counter } from "../contracts/primitives.js";
import type { HistoryEntry } from "./planner.js";

// Coordinator checkpoint (spec Step 6), saved after every validated step so a restarted process
// continues from the last known state with its counters intact, instead of starting over.

const historyEntry = z.union([
  z.strictObject({ type: z.literal("step"), step: counter, output: z.record(z.string(), z.unknown()), result: z.record(z.string(), z.unknown()) }),
  z.strictObject({ type: z.literal("event"), event: z.record(z.string(), z.unknown()) }),
  z.strictObject({ type: z.literal("invalid_output"), step: counter, issues: z.array(z.string()) }),
]);

export const checkpointSchema = z.strictObject({
  counters: z.strictObject({
    // Every planner request, including provider retries and the repair attempt (spec §Reliability and
    // limits: retries and repair consume the same budget).
    planningSteps: counter,
    toolCalls: counter,
    questions: counter,
    repairs: counter,
    finishRejections: counter,
    tokens: counter,
  }),
  // Active execution only. Waiting for an answer or approval does not add to it.
  activeMs: counter,
  history: z.array(historyEntry),
  resolution: z
    .strictObject({ orderId: z.string(), resolution: z.enum(["refund", "no_refund"]), reason: z.string() })
    .nullable(),
  // What the task paused for, so resumption can report what happened while it waited.
  awaiting: z
    .union([
      z.strictObject({ kind: z.literal("question"), id: z.string() }),
      z.strictObject({ kind: z.literal("approval"), id: z.string() }),
    ])
    .nullable(),
  refusalOccurred: z.boolean(),
  usefulWork: z.boolean(),
});
export type Checkpoint = z.infer<typeof checkpointSchema> & { history: HistoryEntry[] };

export function initialCheckpoint(): Checkpoint {
  return {
    counters: { planningSteps: 0, toolCalls: 0, questions: 0, repairs: 0, finishRejections: 0, tokens: 0 },
    activeMs: 0,
    history: [],
    resolution: null,
    awaiting: null,
    refusalOccurred: false,
    usefulWork: false,
  };
}

export function readCheckpoint(raw: unknown): Checkpoint {
  return raw === null || raw === undefined ? initialCheckpoint() : (checkpointSchema.parse(raw) as Checkpoint);
}

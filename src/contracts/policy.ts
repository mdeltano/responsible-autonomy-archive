import { z } from "zod";
import { currencyCode, minorUnits, opaqueId, roleName } from "./primitives.js";

// Versioned, operator-supplied refund policy (spec §Policy rules). Thresholds live here rather than in
// environment variables so a threshold and its policy version always change together.
// A currency missing from `currencies` has no configured threshold: no conversion is inferred and
// nothing in that currency executes automatically.

export const refundPolicy = z.strictObject({
  version: opaqueId,
  approverRole: roleName,
  currencies: z
    .record(currencyCode, z.strictObject({ autoExecuteMaxMinor: minorUnits }))
    .refine((c) => Object.keys(c).length > 0, "at least one currency must be configured"),
});
export type RefundPolicy = z.infer<typeof refundPolicy>;

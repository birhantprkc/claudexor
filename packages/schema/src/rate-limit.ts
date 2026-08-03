import { z } from "zod/v3";
import { Id } from "./primitives.js";

/** Typed rate-limit/quota signal produced from native adapter evidence. */
export const RateLimitSignal = z.object({
  constraint_id: Id.optional().describe(
    "Vendor-owned rate-window identity, when the adapter can map it from a typed field.",
  ),
  applies_to_models: z
    .array(Id)
    .nullable()
    .optional()
    .describe(
      "Canonical model ids/aliases this rejection applies to; omitted/null means every model.",
    ),
  resets_at: z
    .string()
    .nullable()
    .default(null)
    .describe("When the rate window resets, when reported."),
  retry_delay_ms: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .default(null)
    .describe("Suggested retry delay in milliseconds, when reported."),
});
export type RateLimitSignal = z.infer<typeof RateLimitSignal>;

import { harnessFailureNextActions } from "./harnessFailure.js";

/** Classify typed routing refusal separately from provider availability. */
export function routingFailureClassification(err: unknown): {
  category: "config_error" | "harness_unavailable";
  nextActions?: string[];
} {
  const isPreflightRefusal =
    !!err &&
    typeof err === "object" &&
    (err as { code?: unknown }).code === "routing_preflight_refused";
  if (isPreflightRefusal) {
    return { category: "config_error", nextActions: harnessFailureNextActions("config_error") };
  }
  return { category: "harness_unavailable" };
}

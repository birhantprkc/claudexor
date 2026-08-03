import type { RunFailureCode } from "@claudexor/schema";
import { harnessFailureNextActions } from "./harnessFailure.js";
import { declaredFailure } from "./runTerminalResults.js";

/**
 * Classify typed routing refusal separately from provider availability.
 *
 * Quota admission runs HERE, during routing, so that the account which will
 * actually spawn is the one whose windows are checked (an opt-in default-subject
 * rotation has to pick its ready profile before the budget router filters the
 * exhausted default away). That placement means a typed refusal thrown by the
 * profile preflight — `subscription_window_exhausted` and its `resetsAt` — never
 * reaches the per-slot catch that records a candidate's `declaredFailure`, so
 * the routing terminal is the only place left that can state it. Dropping it
 * here would hand a scheduler `code: null` and leave it parsing prose for the
 * one fact it needs: when to come back.
 */
export function routingFailureClassification(err: unknown): {
  category: "config_error" | "harness_unavailable";
  code: RunFailureCode | null;
  resetsAt: string | null;
  nextActions?: string[];
} {
  const isPreflightRefusal =
    !!err &&
    typeof err === "object" &&
    (err as { code?: unknown }).code === "routing_preflight_refused";
  if (isPreflightRefusal) {
    // `routing_preflight_refused` is deliberately NOT a RunFailureCode: it is a
    // classification marker, not a sub-code, so the terminal keeps `code: null`
    // here exactly as it did before.
    return {
      category: "config_error",
      code: null,
      resetsAt: null,
      nextActions: harnessFailureNextActions("config_error"),
    };
  }
  const declared = declaredFailure(err);
  return {
    // A thrower that declared its own category outranks the default, and the
    // schema validates it, so an unrelated error carrying a stray `category`
    // property cannot smuggle in a bogus classification.
    category: declared.category === "config_error" ? "config_error" : "harness_unavailable",
    code: declared.code,
    resetsAt: declared.resetsAt,
  };
}

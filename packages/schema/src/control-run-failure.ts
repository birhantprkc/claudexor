import { z } from "zod/v3";

/**
 * The typed run-failure contract, split out of `control.ts` for the reason the
 * complexity ratchet exists (INV-124): `control.ts` is the file every new
 * control-surface field lands in, and this family — the failure sub-code plus
 * the `RunFailure` record that carries it — is a self-contained unit with its
 * own consumers (budget classifier, quota refusal, CLI/MCP projections).
 * Re-exported through `index.ts` like the other `control-*` splits, so every
 * caller keeps importing it from `@claudexor/schema`.
 */
export const RunFailureCode = z
  .enum([
    "finite_zero",
    "hard_cap",
    "estimate_headroom",
    "unknown_paid_in_flight",
    "budget_overshoot",
    "cost_unverifiable",
    "delegation_child_drain_timeout",
    "subscription_window_exhausted",
    /* A delegated run's confinement preconditions. Each is thrown as a typed
     * error deep in the attempt loop, so it must be listed here or
     * `declaredFailure` drops it to `code: null` and the terminal states less
     * than the thrower knew. See docs/DELEGATED_CONFINEMENT.md. */
    "delegated_home_unavailable",
    "delegated_confinement_unavailable",
    "delegated_evidence_incomplete",
  ])
  .describe(
    "Machine-readable failure sub-code within a RunFailure category (budget-denial reasons, Delegate child-drain timeout, a spent subscription quota window whose reopen time is RunFailure.resetsAt, and the delegated-run confinement refusals: missing scoped home, no OS-enforced boundary on this host, incomplete applied evidence).",
  );
export type RunFailureCode = z.infer<typeof RunFailureCode>;

export const RunFailure = z
  .object({
    phase: z.string().default("unknown").describe("Pipeline phase where the failure happened."),
    category: z
      .enum([
        "validation",
        "project",
        "auth",
        "harness_unavailable",
        "harness_error",
        "config_error",
        "budget",
        "policy",
        "cancelled",
        "internal",
        "unknown",
      ])
      .default("unknown")
      .describe(
        "Typed failure category (validation, project, auth, harness, config, budget, policy, cancelled, internal, unknown). config_error is a settings/routing misconfiguration (e.g. quality routing with no comparable tier), corrected by changing configuration, not by re-auth or waiting for a harness.",
      ),
    code: RunFailureCode.nullable()
      .default(null)
      .describe(
        "Machine-readable failure sub-code within the category; null when the category alone is sufficient. Surfaces choose remediation from this, never by parsing safeMessage.",
      ),
    harnessId: z
      .string()
      .nullable()
      .default(null)
      .describe("Harness involved in the failure, when known."),
    attemptId: z
      .string()
      .nullable()
      .default(null)
      .describe("Attempt involved in the failure, when known."),
    safeMessage: z.string().describe("Redacted human-readable failure message."),
    rawDetailRef: z
      .string()
      .nullable()
      .default(null)
      .describe("Artifact path holding the raw (redacted) failure detail."),
    logRefs: z
      .array(z.string())
      .default([])
      .describe("Log artifact paths relevant to the failure."),
    eventRefs: z
      .array(z.string())
      .default([])
      .describe("Event references relevant to the failure."),
    runDir: z.string().nullable().default(null).describe("Run artifact directory."),
    /** STRUCTURAL reset time. A refusal that only says "resets 2026-08-02T…"
     * inside safeMessage forces every caller to parse prose to decide when to
     * come back — the thing typed contracts exist to prevent. */
    resetsAt: z
      .string()
      .datetime({ offset: true })
      .nullable()
      .default(null)
      .describe(
        "When the refused window reopens (a spent subscription quota window), or null when the failure has no such time. Callers schedule a retry off this field, never off safeMessage.",
      ),
    nextActions: z.array(z.string()).default([]).describe("Suggested operator next actions."),
  })
  .describe(
    "Typed failure record for a run: phase, category, evidence references, and suggested next actions.",
  );
export type RunFailure = z.infer<typeof RunFailure>;

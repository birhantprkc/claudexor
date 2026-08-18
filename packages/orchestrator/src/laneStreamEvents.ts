/**
 * Per-stream disclosure helpers shared VERBATIM by the candidate and
 * read-only lanes. One owner for these event payload shapes: the two lanes
 * used to spell out identical bodies, and a drifted field name in one of them
 * would have split the consumers' view of the same machinery.
 */
import type { RunEventType } from "@claudexor/schema";
import { transientRetryDelayMs, type TransientRetryPolicy } from "./runSupport.js";
import type { AttemptTelemetry } from "./attemptTelemetry.js";

type Emit = (type: RunEventType, payload: Record<string, unknown>) => void;

/** Live plan checklist: forward the adapter's typed plan progress as a run
 * event (LAST WINS; the UI renders the latest). No-op without plan_progress. */
export function emitPlanProgress(
  emit: Emit,
  harnessId: string,
  attemptId: string,
  ev: { plan_progress?: { items: unknown } | null },
): void {
  if (!ev.plan_progress) return;
  emit("plan.progress", {
    attempt_id: attemptId,
    harness_id: harnessId,
    items: ev.plan_progress.items,
  });
}

/** W-C4 flood guard (review sol #10): a per-character delta stream would
 * otherwise persist/SSE one journal event PER CHUNK without bound. Delta
 * messages are DISPLAY-only (the complete message still follows and carries
 * the authoritative text), so past a per-attempt budget further deltas are
 * DROPPED (`true`) and the cutoff disclosed ONCE — the final answer is
 * unaffected. */
export function dropDeltaPastBudget(
  ev: { type: string; payload?: Record<string, unknown> | null },
  state: { count: number; disclosed: boolean },
  max: number,
  emit: Emit,
  harnessId: string,
  attemptId: string,
): boolean {
  if (ev.type !== "message" || ev.payload?.["delta"] !== true) return false;
  state.count += 1;
  if (state.count <= max) return false;
  if (!state.disclosed) {
    state.disclosed = true;
    emit("harness.event", {
      harness_id: harnessId,
      attempt_id: attemptId,
      type: "status",
      title: `live delta stream capped at ${max} chunks; the complete message still lands`,
    });
  }
  return true;
}

/** Discloses one scheduled same-profile transient retry (`detected` +
 * `retry_scheduled`) and returns the backoff delay the caller must sleep. */
export function emitTransientRetryPlan(
  emit: Emit,
  harnessId: string,
  attemptId: string,
  transient: { kind: string; category: string; retryDelayMs: number | null } | null,
  nativeTry: number,
  policy: TransientRetryPolicy,
): number {
  const delayMs = transientRetryDelayMs(transient?.retryDelayMs ?? null, policy, nativeTry);
  emit("route.transient.detected", {
    harness_id: harnessId,
    attempt_id: attemptId,
    kind: transient?.kind ?? "unknown",
    category: transient?.category ?? "unknown_harness_error",
    native_try: nativeTry + 1,
  });
  emit("route.transient.retry_scheduled", {
    harness_id: harnessId,
    attempt_id: attemptId,
    retry: nativeTry + 1,
    delay_ms: delayMs,
  });
  return delayMs;
}

/** Read-only lanes burn quota too: fold one usage event's spend into the
 * attempt's running cost and disclose it as a `budget.observation`. */
export function observeReadonlySpend(
  ev: { type: string; usage?: { cost_usd?: number | null; estimated?: boolean | null } | null },
  emit: Emit,
  harnessId: string,
  attemptId: string,
): { costUsd: number; estimated: boolean } {
  if (ev.type !== "usage" || !ev.usage?.cost_usd) return { costUsd: 0, estimated: false };
  emit("budget.observation", {
    harness_id: harnessId,
    attempt_id: attemptId,
    kind: "spend",
    usd: ev.usage.cost_usd,
    estimated: ev.usage.estimated === true,
  });
  return { costUsd: ev.usage.cost_usd, estimated: ev.usage.estimated === true };
}

/** The transient machinery's terminal disclosure for an attempt that still
 * ended errored; silent when no transient failure was ever classified. */
export function emitTransientExhausted(
  emit: Emit,
  harnessId: string,
  attemptId: string,
  telemetry: AttemptTelemetry,
  retries: number,
): void {
  if (telemetry.transientFailures.length === 0) return;
  emit("route.transient.exhausted", {
    harness_id: harnessId,
    attempt_id: attemptId,
    category: telemetry.transientFailures.at(-1)?.category ?? "unknown_harness_error",
    retries,
  });
}

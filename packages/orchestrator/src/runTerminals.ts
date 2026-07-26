/**
 * Terminal-state machinery shared by every strategy: typed failure artifacts,
 * the cancelled terminal, and the announced-run safety net. Every run that
 * was ANNOUNCED (run.created after createRun) must end with a terminal event
 * — run.completed, run.blocked, or run.failed — plus failure.yaml/summary
 * artifacts on the failure paths. An escaped throw used to orphan the run
 * dir, leaving events.jsonl without a terminal and SSE tailers waiting
 * forever.
 */
import { join } from "node:path";
import { DecisionRecord, RunFailureCode, RunOutcomeFacts, type ModeKind } from "@claudexor/schema";
import type { ArtifactStore } from "@claudexor/artifact-store";
import type { BudgetLedger, BudgetTerminal } from "@claudexor/budget";
import type { EventLog } from "@claudexor/event-log";
import { redactSecrets } from "@claudexor/util";
import { budgetFailureRecord, classifyBudgetFailure } from "./budgetFailure.js";
import { reconcileDecisionTerminal } from "./decisionTerminalReconciliation.js";
import type { OrchestratorResult } from "./orchestrator.js";
import {
  clearFailureArtifact,
  reconcileWorkProductTerminal,
  terminalOutcomeFacts,
} from "./terminalOutcome.js";

export interface AnnouncedRunContext {
  log: EventLog;
  store: ArtifactStore;
  paths: ReturnType<ArtifactStore["runPaths"]>;
  runId: string;
  taskId: string;
  mode: ModeKind;
  /** Failure phase label when the net has to stamp the terminal. */
  phase: string;
  /** Settled ledger spend snapshot — failure/cancel terminals must account
   * for money already spent exactly like success terminals do. */
  spend?: () => number;
  valuation?: () => number;
  spendEstimated?: () => boolean;
  valuationKnowledge?: () => "exact" | "estimated" | "unknown";
  /** Re-evaluated after Delegate child drain. A child settlement can make the
   * shared family overshoot or become unverifiable after strategy synthesis. */
  budgetTerminal?: () => BudgetTerminal;
  /** True only while this run owns the effective Delegate family authority.
   * Ordinary runs may already have emitted a non-deferred terminal and must
   * never be terminalized a second time by the post-drain recheck. */
  recheckBudgetAfterBarrier?: () => boolean;
}

type AnnouncedRunIdentity = Pick<
  AnnouncedRunContext,
  "log" | "store" | "paths" | "runId" | "taskId" | "mode" | "phase"
>;

export function announcedRunContext(
  identity: AnnouncedRunIdentity,
  ledger: BudgetLedger,
  hasDelegateAuthority: () => boolean,
): AnnouncedRunContext {
  return {
    ...identity,
    spend: () => ledger.spend(),
    valuation: () => ledger.valuation(),
    spendEstimated: () => ledger.estimated(),
    valuationKnowledge: () => ledger.valuationKnowledge(),
    budgetTerminal: () => ledger.terminal(),
    recheckBudgetAfterBarrier: hasDelegateAuthority,
  };
}

interface SettledBudgetSnapshot {
  spendUsd: number | null;
  valuationUsd: number | null;
  estimated: boolean;
  valuationKnowledge: "exact" | "estimated" | "unknown";
}

function settledBudgetSnapshot(context: AnnouncedRunContext): SettledBudgetSnapshot {
  const read = (value: (() => number) | undefined): number | null => {
    try {
      const result = value?.();
      return typeof result === "number" && Number.isFinite(result) ? result : null;
    } catch {
      return null;
    }
  };
  let estimated = false;
  let valuationKnowledge: "exact" | "estimated" | "unknown" = "unknown";
  try {
    estimated = context.spendEstimated?.() === true;
  } catch {
    estimated = true;
  }
  try {
    valuationKnowledge = context.valuationKnowledge?.() ?? "unknown";
  } catch {
    valuationKnowledge = "unknown";
  }
  return {
    spendUsd: read(context.spend),
    valuationUsd: read(context.valuation),
    estimated,
    valuationKnowledge,
  };
}

function ownsDelegateDrain(context: AnnouncedRunContext): boolean {
  try {
    return context.recheckBudgetAfterBarrier?.() === true;
  } catch {
    // Reconciliation is an extra authority granted only to a proven Delegate
    // drain owner. An unreadable ownership predicate must fail closed instead
    // of touching an ordinary Agent's already-terminal artifacts.
    return false;
  }
}

/** A Delegate family may settle child cash during the terminal barrier, after
 * strategy arbitration wrote decision.yaml. Reconcile that existing artifact
 * in place so its self-contained budget and optional terminal facts match the
 * drained ledger. Runs without a decision artifact are intentionally no-ops. */
function reconcileDecisionBudget(
  context: AnnouncedRunContext,
  budget: SettledBudgetSnapshot,
  terminal?: { facts: RunOutcomeFacts; why: string },
): void {
  const path = join(context.paths.arbitrationDir, "decision.yaml");
  const current = context.store.readYaml<unknown>(path);
  if (!current || typeof current !== "object" || Array.isArray(current)) return;
  const record = current as Record<string, unknown>;
  const priorBudget =
    record["budget_summary"] && typeof record["budget_summary"] === "object"
      ? (record["budget_summary"] as Record<string, unknown>)
      : {};
  const reconciled = {
    ...record,
    ...(terminal
      ? {
          facts: terminal.facts,
          why_winner: terminal.why,
          apply_recommendation: "continue",
        }
      : {}),
    budget_summary: {
      ...priorBudget,
      spend_usd: budget.spendUsd,
      cash_usd: budget.spendUsd,
      valuation_usd: budget.valuationUsd,
      estimated: budget.estimated,
      valuation_knowledge: budget.valuationKnowledge,
    },
  };
  // Validate the canonical decision fields, but write the reconciled original
  // object so forward-compatible extension receipts (for example
  // delivery_receipt) are not stripped by Zod's default object projection.
  DecisionRecord.parse(reconciled);
  context.store.writeYaml(path, reconciled);
}

function postDrainBudgetFailure(
  context: AnnouncedRunContext,
  terminal: Exclude<BudgetTerminal, null>,
  budget: SettledBudgetSnapshot,
  prior: OrchestratorResult,
): OrchestratorResult {
  const mapping = classifyBudgetFailure({ denial: null, terminal });
  const facts = terminalOutcomeFacts(prior.facts, "failed", mapping.reason);
  reconcileDecisionBudget(context, budget, { facts, why: mapping.safeMessage });
  reconcileWorkProductTerminal(context, facts);
  context.store.writeText(
    join(context.paths.finalDir, "summary.md"),
    `# Run ${context.runId} (${context.mode})\n\n- Lifecycle: failed (${mapping.reason})\n- Phase: budget\n\n${mapping.safeMessage}\n`,
  );
  writeFailure(
    context.store,
    context.paths,
    budgetFailureRecord(mapping, { runDir: context.paths.root }),
  );
  context.log.emit("output.ready", {
    kind: "summary",
    path: "final/summary.md",
    state: "diagnostic",
  });
  context.log.emit("run.failed", {
    lifecycle: "failed",
    facts,
    reason: mapping.reason,
    phase: "budget",
    error: mapping.safeMessage,
    failure_ref: "final/failure.yaml",
  });
  return {
    ...prior,
    lifecycle: "failed",
    facts,
    summary: mapping.safeMessage,
    spendUsd: budget.spendUsd,
  };
}

export function writeFailure(
  store: ArtifactStore,
  paths: ReturnType<ArtifactStore["runPaths"]>,
  failure: {
    phase: string;
    category: string;
    /** Machine-readable sub-code (typed budget-denial reason); null/omitted when
     * the category alone is sufficient. Consumed by surfaces to pick remediation
     * without parsing safeMessage (QA-050). */
    code?: RunFailureCode | null;
    safeMessage: string;
    harnessId?: string | null;
    attemptId?: string | null;
    rawDetailRef?: string;
    logRefs?: string[];
    eventRefs?: string[];
    runDir?: string;
    nextActions?: string[];
  },
): void {
  store.writeYaml(join(paths.finalDir, "failure.yaml"), {
    phase: failure.phase,
    category: failure.category,
    code: failure.code ?? null,
    harnessId: failure.harnessId ?? null,
    attemptId: failure.attemptId ?? null,
    safeMessage: redactSecrets(failure.safeMessage),
    rawDetailRef: failure.rawDetailRef ?? null,
    logRefs: failure.logRefs ?? [],
    eventRefs: failure.eventRefs ?? [],
    runDir: failure.runDir ?? paths.root,
    nextActions: failure.nextActions ?? [],
  });
}

/**
 * Terminal result for a cancelled run: emits run.failed with status
 * "cancelled" so every mode ends consistently. `writeTelemetry` carries the
 * PARTIAL attempt telemetry collected before the abort — a cancelled run
 * must still account for what it spent and observed; it used to be
 * written only by convergence.
 */
export function cancelledResult(
  log: EventLog,
  runId: string,
  taskId: string,
  mode: ModeKind,
  runDir: string,
  candidates: { attemptId: string; harnessId: string; status: string }[],
  writeTelemetry?: () => void,
  spendUsd?: number | null,
  /** The abort signal that ended the run: a STRING reason (e.g.
   * `wall_clock_exceeded` from the maxSeconds deadline) is surfaced; a plain
   * user cancel aborts with a DOMException reason and stays a bare cancel. */
  cancelSignal?: AbortSignal,
  /** Materializes the diagnostic summary the output.ready below announces. */
  store?: ArtifactStore,
  /** A prepared result may already carry independent checks/review/work facts
   * when cancellation wins during the Delegate terminal barrier. */
  priorFacts?: RunOutcomeFacts,
): OrchestratorResult {
  if (writeTelemetry) {
    try {
      writeTelemetry();
    } catch {
      /* partial telemetry is best-effort on the cancel path */
    }
  }
  const cancelReason =
    typeof cancelSignal?.reason === "string" && cancelSignal.reason
      ? cancelSignal.reason
      : undefined;
  const summaryText =
    cancelReason === "wall_clock_exceeded"
      ? "run cancelled: wall-clock deadline (maxSeconds) exceeded"
      : "run cancelled";
  // Materialize the diagnostic summary BEFORE announcing it — output.ready must
  // point at a file that exists (partial-output honesty), and it must precede
  // the terminal in every mode (INV-116).
  let summaryWritten = false;
  if (store) {
    try {
      store.writeText(
        join(runDir, "final", "summary.md"),
        `# Run ${runId} (${mode})\n\n- Lifecycle: cancelled\n${cancelReason ? `- Reason: ${cancelReason}\n` : ""}\n${summaryText}\n`,
      );
      summaryWritten = true;
    } catch {
      /* best-effort: a write failure must not mask the cancel terminal */
    }
  }
  // output.ready is EVIDENCE (release wave sol #3): announce the summary only
  // when the file actually materialized — a failed write still gets its
  // terminal below, just without a pointer to a nonexistent artifact.
  if (summaryWritten) {
    log.emit("output.ready", { kind: "summary", path: "final/summary.md", state: "diagnostic" });
  }
  const cancelFacts = terminalOutcomeFacts(
    priorFacts,
    "cancelled",
    cancelReason === "wall_clock_exceeded" ? "wall_clock_exceeded" : "user_cancelled",
  );
  log.emit("run.failed", {
    lifecycle: "cancelled",
    facts: cancelFacts,
    reason: cancelFacts.reason,
    ...(cancelReason ? { cancel_reason: cancelReason } : {}),
  });
  return {
    runId,
    taskId,
    mode,
    lifecycle: "cancelled",
    facts: cancelFacts,
    winner: null,
    runDir,
    summary: summaryText,
    candidates,
    ...(spendUsd !== undefined ? { spendUsd } : {}),
    ...(cancelReason ? { cancelReason } : {}),
  };
}

/**
 * Shared post-announce failure terminal. Unexpected throws use its internal
 * defaults; known callers may supply narrow typed provenance. Every run ends
 * with failure.yaml + summary + a terminal run.failed event.
 */
export function failTerminally(
  log: EventLog,
  store: ArtifactStore,
  paths: ReturnType<ArtifactStore["runPaths"]>,
  runId: string,
  taskId: string,
  mode: ModeKind,
  phase: string,
  err: unknown,
  spendUsd?: number | null,
  failureMeta: {
    category?: "harness_error" | "internal";
    harnessId?: string;
    attemptId?: string;
    rawDetailRef?: string;
    nextActions?: string[];
    priorFacts?: RunOutcomeFacts;
  } = {},
): OrchestratorResult {
  const message = redactSecrets(err instanceof Error ? err.message : String(err));
  const parsedCode = RunFailureCode.safeParse(
    err && typeof err === "object" ? (err as { code?: unknown }).code : undefined,
  );
  const failFacts = terminalOutcomeFacts(failureMeta.priorFacts, "failed", "harness_failed");
  store.writeText(
    join(paths.finalDir, "summary.md"),
    `# Run ${runId} (${mode})\n\n- Lifecycle: failed\n- Phase: ${phase}\n\n${message}\n`,
  );
  writeFailure(store, paths, {
    phase,
    category: failureMeta.category ?? "internal",
    code: parsedCode.success ? parsedCode.data : null,
    harnessId: failureMeta.harnessId,
    attemptId: failureMeta.attemptId,
    safeMessage: message,
    rawDetailRef: failureMeta.rawDetailRef,
    runDir: paths.root,
    nextActions: failureMeta.nextActions ?? ["Open diagnostics", "Retry the run"],
  });
  log.emit("output.ready", { kind: "summary", path: "final/summary.md", state: "diagnostic" });
  log.emit("run.failed", {
    lifecycle: "failed",
    facts: failFacts,
    reason: failFacts.reason,
    phase,
    error: message,
    failure_ref: "final/failure.yaml",
  });
  return {
    runId,
    taskId,
    mode,
    lifecycle: "failed",
    facts: failFacts,
    winner: null,
    runDir: paths.root,
    summary: message,
    candidates: [],
    ...(spendUsd !== undefined ? { spendUsd } : {}),
  };
}

/**
 * Whole-strategy terminal net: run `body`; if it throws AFTER announcing,
 * stamp terminal artifacts instead of orphaning the run. Pre-announce throws
 * keep the loud-request contract (the caller gets the error; no run dir
 * exists). An abort surfaced as a throw is a CANCELLED terminal, not an
 * internal failure.
 */
export async function guardAnnouncedRun(
  signal: AbortSignal | undefined,
  body: (announce: (a: AnnouncedRunContext) => void) => Promise<OrchestratorResult>,
  /** Awaited after strategy work but before a deferred terminal is flushed.
   * Delegate parents use it to fence admission and drain child settlements. */
  beforeTerminal?: (context: AnnouncedRunContext) => void | Promise<void>,
  /**
   * Invoked once with the announced runId when the strategy settles (return OR
   * throw). The single per-run terminalization hook: per-run engine state keyed
   * by runId (e.g. the routing-rationale map) is released HERE so a run that
   * dies before its telemetry writer runs cannot leak it (QA-034 map leak).
   */
  onSettled?: (runId: string) => void | Promise<void>,
): Promise<OrchestratorResult> {
  let announced: AnnouncedRunContext | null = null;
  let preparedResult: OrchestratorResult | null = null;
  let barrierAttempted = false;
  let barrierFailed = false;
  const runBarrier = async (context: AnnouncedRunContext): Promise<void> => {
    if (barrierAttempted) return;
    barrierAttempted = true;
    try {
      await beforeTerminal?.(context);
    } catch (error) {
      barrierFailed = true;
      throw error;
    }
  };
  try {
    const result = await body((a) => {
      announced = a;
    });
    preparedResult = result;
    const context = announced as AnnouncedRunContext | null;
    if (context) {
      await runBarrier(context);
      const budget = settledBudgetSnapshot(context);
      const delegateBarrierArmed = ownsDelegateDrain(context);
      if (delegateBarrierArmed && signal?.aborted) {
        context.log.clearDeferredTerminal();
        const cancelFacts = terminalOutcomeFacts(
          result.facts,
          "cancelled",
          signal.reason === "wall_clock_exceeded" ? "wall_clock_exceeded" : "user_cancelled",
        );
        const cancelSummary =
          signal.reason === "wall_clock_exceeded"
            ? "run cancelled: wall-clock deadline (maxSeconds) exceeded"
            : "run cancelled";
        let reconciledCancelFacts = cancelFacts;
        try {
          reconciledCancelFacts = reconcileDecisionTerminal(context, {
            facts: cancelFacts,
            why: cancelSummary,
            preparedFacts: result.facts,
          });
          reconcileWorkProductTerminal(context, reconciledCancelFacts);
          clearFailureArtifact(context);
        } catch {
          /* the cancellation terminal below remains authoritative */
        }
        const cancelled = cancelledResult(
          context.log,
          context.runId,
          context.taskId,
          context.mode,
          context.paths.root,
          result.candidates,
          undefined,
          budget.spendUsd,
          signal,
          context.store,
          reconciledCancelFacts,
        );
        context.log.flushDeferredTerminal();
        return {
          ...result,
          lifecycle: "cancelled",
          facts: cancelled.facts,
          summary: cancelled.summary,
          spendUsd: cancelled.spendUsd,
          ...(cancelled.cancelReason ? { cancelReason: cancelled.cancelReason } : {}),
        };
      }
      const budgetTerminal = delegateBarrierArmed ? (context.budgetTerminal?.() ?? null) : null;
      if (budgetTerminal && result.lifecycle === "succeeded") {
        context.log.clearDeferredTerminal();
        const failed = postDrainBudgetFailure(context, budgetTerminal, budget, result);
        context.log.flushDeferredTerminal();
        return failed;
      }
      if (delegateBarrierArmed) reconcileDecisionBudget(context, budget);
      context.log.flushDeferredTerminal();
      if (budget.spendUsd !== null) return { ...result, spendUsd: budget.spendUsd };
    }
    return result;
  } catch (err) {
    // TS cannot see the closure assignment; the cast is safe (set-once).
    const a = announced as AnnouncedRunContext | null;
    if (!a) throw err;
    a.log.clearDeferredTerminal();
    let terminalError = err;
    try {
      await runBarrier(a);
    } catch (barrierError) {
      terminalError = barrierError;
    }
    // Settled-spend accounting is part of the terminal contract on EVERY
    // path (the orchestrate executor aggregates it); a broken spend snapshot
    // must not mask the original failure, so it degrades to null loudly-typed.
    const budget = settledBudgetSnapshot(a);
    const spendUsd = budget.spendUsd;
    if (signal?.aborted && terminalError === err) {
      const priorFacts = preparedResult?.facts;
      const cancelFacts = terminalOutcomeFacts(
        priorFacts,
        "cancelled",
        signal.reason === "wall_clock_exceeded" ? "wall_clock_exceeded" : "user_cancelled",
      );
      const cancelSummary =
        signal.reason === "wall_clock_exceeded"
          ? "run cancelled: wall-clock deadline (maxSeconds) exceeded"
          : "run cancelled";
      let reconciledCancelFacts = cancelFacts;
      try {
        reconciledCancelFacts = reconcileDecisionTerminal(a, {
          facts: cancelFacts,
          why: cancelSummary,
          ...(preparedResult ? { preparedFacts: preparedResult.facts } : {}),
        });
        reconcileWorkProductTerminal(a, reconciledCancelFacts);
        clearFailureArtifact(a);
      } catch {
        /* the cancellation terminal below remains authoritative */
      }
      const cancelled = cancelledResult(
        a.log,
        a.runId,
        a.taskId,
        a.mode,
        a.paths.root,
        preparedResult?.candidates ?? [],
        undefined,
        spendUsd,
        // A wall-clock abort surfaced as a throw must keep its reason and
        // materialize the diagnostic summary, exactly like the checkpoint paths.
        signal,
        a.store,
        reconciledCancelFacts,
      );
      a.log.flushDeferredTerminal();
      return preparedResult
        ? {
            ...preparedResult,
            lifecycle: "cancelled",
            facts: cancelled.facts,
            summary: cancelled.summary,
            spendUsd: cancelled.spendUsd,
            ...(cancelled.cancelReason ? { cancelReason: cancelled.cancelReason } : {}),
          }
        : cancelled;
    }
    const priorFacts = preparedResult?.facts;
    const pendingFacts = terminalOutcomeFacts(priorFacts, "failed", "harness_failed");
    const pendingSummary = redactSecrets(
      terminalError instanceof Error ? terminalError.message : String(terminalError),
    );
    let reconciledFailureFacts = pendingFacts;
    try {
      reconciledFailureFacts = reconcileDecisionTerminal(a, {
        facts: pendingFacts,
        why: pendingSummary,
        ...(preparedResult ? { preparedFacts: preparedResult.facts } : {}),
      });
      reconcileWorkProductTerminal(a, reconciledFailureFacts);
    } catch {
      /* the failure terminal below remains authoritative */
    }
    const failed = failTerminally(
      a.log,
      a.store,
      a.paths,
      a.runId,
      a.taskId,
      a.mode,
      barrierFailed ? "delegation_drain" : a.phase,
      terminalError,
      spendUsd,
      { priorFacts: reconciledFailureFacts },
    );
    a.log.flushDeferredTerminal();
    return preparedResult
      ? {
          ...preparedResult,
          lifecycle: "failed",
          facts: failed.facts,
          summary: failed.summary,
          spendUsd: failed.spendUsd,
        }
      : failed;
  } finally {
    // Release per-run engine state on EVERY terminal path (normal return, failure
    // net, cancel), but only for a run that actually announced a runId.
    const settled = announced as AnnouncedRunContext | null;
    if (settled) await onSettled?.(settled.runId);
  }
}

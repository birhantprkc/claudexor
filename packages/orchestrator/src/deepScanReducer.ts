import { join } from "node:path";
import type {
  CostEvidence,
  DeepScanSynthesis,
  ExternalContextPolicy,
  HarnessEvent,
  HarnessRunSpec,
} from "@claudexor/schema";
import type { BudgetLedger } from "@claudexor/budget";
import { AnswerAssembly, countsAsAgentProgress, withInactivityWatchdog } from "@claudexor/core";
import { appendLine, redactSecrets, safeInvoke } from "@claudexor/util";
import type { RunPaths } from "@claudexor/artifact-store";
import type { EventLog } from "@claudexor/event-log";
import { buildDeepScanReducerPrompt } from "@claudexor/synthesis";
import { type BudgetDenial, classifyBudgetFailure } from "./budgetFailure.js";
import type { RoutedAdapter } from "./orchestrator.js";
import {
  finalizeAttempt,
  unwrapWorkReportEnvelope,
  type WorkReportEnvelopeMode,
} from "./attemptFinalize.js";
import {
  redactHarnessEvent,
  harnessEventPayload,
  observeBudgetSignals,
  safeErrorMessage,
} from "./runSupport.js";
import {
  type AttemptTelemetry,
  createAttemptTelemetry,
  observeAttemptTelemetry,
  setAttemptOutcome,
  telemetrySummary,
  toolWarnings,
} from "./attemptTelemetry.js";
import { settleGrantedAttemptLease } from "./attemptUsageCost.js";

/** The reducer runs under the fixed `synth` attempt id (roster/cost visible). */
export const DEEP_SCAN_REDUCER_ATTEMPT_ID = "synth";
const REDUCER_CLEANUP_GRACE_MS = 8_000;
const REDUCER_CLEANUP_EVENT_TYPES = new Set<HarnessEvent["type"]>([
  "started",
  "usage",
  "error",
  "status",
  "context",
  "completed",
]);

/** Keep the scoped HOME alive for cooperative teardown, but never forever. */
async function waitForCleanup(work: Promise<unknown>, graceMs: number): Promise<void> {
  let timer!: ReturnType<typeof setTimeout>;
  await Promise.race([
    work.catch(() => undefined),
    new Promise<void>((resolve) => {
      // Referenced: this timer owns eventual HOME/lease cleanup.
      timer = setTimeout(resolve, Math.max(1, graceMs));
    }),
  ]);
  clearTimeout(timer);
}

/** Honest attributed fallback; never presents raw scout reports as a merge. */
export function rawScoutBundle(args: {
  succeeded: {
    attemptId: string;
    harnessId: string;
    report: string;
    telemetry: AttemptTelemetry;
  }[];
  unsuccessful: { attemptId: string; harnessId: string; status: string; error: string | null }[];
  status: DeepScanSynthesis | null;
}): string {
  const total = args.succeeded.length + args.unsuccessful.length;
  const intro =
    args.status?.status === "skipped"
      ? [
          "## Raw scout report (single scout — no merge needed)",
          "",
          "Only one scout produced a report, so no synthesis reducer was run.",
        ]
      : [
          "## Raw scout bundle — NOT a merged synthesis",
          "",
          `The bounded synthesis reducer did not produce a merge (${args.status?.reason ?? "synthesis unavailable"}). The scout reports below are raw and unmerged; claims are not deduplicated and disagreements are not reconciled.`,
        ];
  return [
    ...intro,
    "",
    `Explorers succeeded: ${args.succeeded.length}/${total}.`,
    "",
    "## Scout reports (raw, not merged)",
    ...args.succeeded.map((a) => {
      const warnings = toolWarnings(a.telemetry);
      const warningText = warnings.length
        ? `\n\n> Tool warnings: ${warnings.map((e) => `${e.tool}: ${e.summary}`).join("; ")}`
        : "";
      return `\n### ${a.attemptId} / ${a.harnessId}\n\n${a.report}${warningText}`;
    }),
    "",
    "## Omissions / Uncertainty",
    ...(args.unsuccessful.length
      ? args.unsuccessful.map((a) => `- ${a.attemptId} / ${a.harnessId} ${a.status}: ${a.error}`)
      : [
          "- No explorer failures recorded. Claims still need evidence review before edit execution.",
        ]),
  ].join("\n");
}

/** A disposable read-only route context (env + reclaim). */
export interface ReducerHome {
  env: Record<string, string>;
  dispose: () => void;
}

/** Engine-owned dependencies; private route/session machinery stays with the caller. */
export interface DeepScanReducerDeps {
  newReadOnlyHome: () => ReducerHome;
  costEvidence: (harnessId: string, attemptId: string) => CostEvidence;
  buildSpec: (
    routed: RoutedAdapter,
    homeEnv: Record<string, string>,
    prompt: string,
    attemptId: string,
  ) =>
    | Promise<{
        spec: HarnessRunSpec;
        webPolicy: ExternalContextPolicy;
        effectiveWeb: ExternalContextPolicy;
        model: string | null;
        workReportMode: WorkReportEnvelopeMode;
      }>
    | {
        spec: HarnessRunSpec;
        webPolicy: ExternalContextPolicy;
        effectiveWeb: ExternalContextPolicy;
        model: string | null;
        workReportMode: WorkReportEnvelopeMode;
      };
  hardTimeoutMs: number;
  /** Production defaults to the process-reap proof window. */
  cleanupGraceMs?: number;
  inactivityTimeoutMs: number;
  webRequired: boolean;
  quotaEventSink?: (harnessId: string, ev: HarnessEvent) => void;
}

export interface DeepScanReducerArgs {
  taskId: string;
  goal: string;
  routed: RoutedAdapter;
  scoutReports: { attemptId: string; harnessId: string; absPath: string }[];
  ledger: BudgetLedger;
  log: EventLog;
  paths: RunPaths;
  signal?: AbortSignal;
  onHarnessEvent?: (ev: HarnessEvent) => void;
  attemptTelemetries: { attemptId: string; harnessId: string; telemetry: AttemptTelemetry }[];
}

export type DeepScanReducerResult =
  | { status: "success"; report: string }
  | { status: "failed"; error: string }
  | { status: "budget_denied"; denial: BudgetDenial }
  // Outer cancellation discards partial synthesis and stays distinct from failure.
  | { status: "cancelled" };

/** One budgeted, bounded, read-only synthesis over file-backed scout reports. */
export async function runDeepScanReducer(
  deps: DeepScanReducerDeps,
  args: DeepScanReducerArgs,
): Promise<DeepScanReducerResult> {
  const { ledger, log, paths } = args;
  const attemptId = DEEP_SCAN_REDUCER_ATTEMPT_ID;
  const adapter = args.routed.adapter;
  log.emit("synthesis.started", {
    synthesize: true,
    reason: `deep-scan reducer over ${args.scoutReports.length} scout reports`,
  });
  const lease = ledger.reserve({
    taskId: args.taskId,
    attemptId,
    intent: "synthesize",
    harnessId: adapter.id,
    cost: deps.costEvidence(adapter.id, attemptId),
  });
  if (!lease.granted) {
    log.emit("budget.lease.created", {
      granted: false,
      reason: lease.reason,
      denied: lease.denied,
      attempt_id: attemptId,
      harness_id: adapter.id,
    });
    return {
      status: "budget_denied",
      denial: {
        code: lease.denied ?? "hard_cap",
        reason: lease.reason ?? "budget lease denied",
        harnessId: adapter.id,
        attemptId,
      },
    };
  }

  type ReducerStop = "timeout" | "cancelled";
  const cleanupGraceMs = deps.cleanupGraceMs ?? REDUCER_CLEANUP_GRACE_MS;
  const reducerAbort = new AbortController();
  let resolveStop!: (reason: ReducerStop) => void;
  const stopped = new Promise<ReducerStop>((resolve) => {
    resolveStop = resolve;
  });
  let stopReason: ReducerStop | null = null;
  let activeSessionId: string | null = null;
  let cancelTask: Promise<unknown> | null = null;
  const cancelActiveSession = (): void => {
    if (!activeSessionId || cancelTask) return;
    cancelTask = Promise.resolve()
      .then(() => adapter.cancel?.(activeSessionId ?? ""))
      .catch(() => undefined);
  };
  const requestStop = (reason: ReducerStop): void => {
    if (stopReason) return;
    stopReason = reason;
    reducerAbort.abort();
    resolveStop(reason);
    cancelActiveSession();
  };

  // The one total deadline starts immediately after admission, before HOME or
  // async route preparation can retain either the HOME or budget lease.
  const hardTimer = setTimeout(() => requestStop("timeout"), deps.hardTimeoutMs);
  const onOuterAbort = () => requestStop("cancelled");
  if (args.signal?.aborted) onOuterAbort();
  else args.signal?.addEventListener("abort", onOuterAbort, { once: true });

  let reducerHome: ReducerHome | null = null;
  let settlementTelemetry: AttemptTelemetry | null = null;
  let cost = 0;
  let costEstimated = false;
  const cleanupAttempt = (): void => {
    clearTimeout(hardTimer);
    args.signal?.removeEventListener("abort", onOuterAbort);
    try {
      reducerHome?.dispose();
    } finally {
      settleGrantedAttemptLease({
        ledger,
        leaseId: lease.lease?.lease_id ?? "",
        attemptId,
        harnessId: adapter.id,
        costUsd: cost,
        costEstimated,
        authMode: settlementTelemetry?.authMode,
        usageCost: settlementTelemetry?.usageCost,
        preStreamFailureSource: "deep-scan-reducer-pre-stream",
      });
    }
  };
  const finishBeforeHarness = (result: DeepScanReducerResult): DeepScanReducerResult => {
    const telemetry =
      settlementTelemetry ?? createAttemptTelemetry("auto", deps.webRequired, "auto", [], null);
    setAttemptOutcome(telemetry, {
      deliverablePresent: false,
      gatesPassed: null,
      harnessErrored: result.status === "failed",
      webRequiredUnsatisfied: false,
    });
    args.attemptTelemetries.push({ attemptId, harnessId: adapter.id, telemetry });
    cleanupAttempt();
    return result;
  };
  const resultForStop = (reason: ReducerStop): DeepScanReducerResult =>
    reason === "cancelled"
      ? { status: "cancelled" }
      : { status: "failed", error: `deep-scan reducer timed out after ${deps.hardTimeoutMs}ms` };

  if (stopReason) return finishBeforeHarness(resultForStop(stopReason));
  let prompt: string;
  try {
    // A fresh disposable read-only home: auth remains home-independent.
    reducerHome = deps.newReadOnlyHome();
    prompt = buildDeepScanReducerPrompt(args.goal, args.scoutReports);
  } catch (error) {
    return finishBeforeHarness({
      status: "failed",
      error: `deep-scan reducer setup failed: ${safeErrorMessage(error)}`,
    });
  }
  const buildTask = Promise.resolve().then(() =>
    deps.buildSpec(args.routed, reducerHome?.env ?? {}, prompt, attemptId),
  );
  const prepared = await Promise.race([
    buildTask.then(
      (built) => ({ kind: "built" as const, built }),
      (error: unknown) => ({ kind: "error" as const, error }),
    ),
    stopped.then((reason): { kind: "stopped"; reason: ReducerStop } => ({
      kind: "stopped",
      reason,
    })),
  ]);
  if (prepared.kind === "stopped") {
    await waitForCleanup(buildTask, cleanupGraceMs);
    return finishBeforeHarness(resultForStop(prepared.reason));
  }
  if (prepared.kind === "error") {
    return finishBeforeHarness({
      status: "failed",
      error: `deep-scan reducer setup failed: ${safeErrorMessage(prepared.error)}`,
    });
  }

  const built = prepared.built;
  const spec = built.spec;
  activeSessionId = spec.session_id;
  if (stopReason) {
    cancelActiveSession();
    if (cancelTask) await waitForCleanup(cancelTask, cleanupGraceMs);
    return finishBeforeHarness(resultForStop(stopReason));
  }
  spec.extra["abortSignal"] = args.signal
    ? AbortSignal.any([args.signal, reducerAbort.signal])
    : reducerAbort.signal;
  const telemetry = createAttemptTelemetry(
    built.webPolicy,
    deps.webRequired,
    built.effectiveWeb,
    [],
    built.model,
  );
  settlementTelemetry = telemetry;
  const answer = new AnswerAssembly();
  const attemptEventsPath = join(paths.attemptsDir, attemptId, "events.jsonl");
  const budgetSignalState = { quotaPressureDisclosed: false };
  let harnessError: string | null = null;
  let stoppedDuringRun: ReducerStop | null = null;
  const observeEvent = (event: HarnessEvent, acceptDeliverable: boolean): void => {
    const safeEv = redactHarnessEvent(event);
    if (!acceptDeliverable && !REDUCER_CLEANUP_EVENT_TYPES.has(safeEv.type)) return;
    safeInvoke(args.onHarnessEvent, safeEv);
    log.emit("harness.event", harnessEventPayload(adapter.id, attemptId, safeEv));
    appendLine(attemptEventsPath, JSON.stringify(safeEv));
    observeAttemptTelemetry(telemetry, safeEv);
    observeBudgetSignals(ledger, log, adapter.id, attemptId, safeEv, budgetSignalState);
    deps.quotaEventSink?.(adapter.id, safeEv);
    if (safeEv.type === "usage" && safeEv.usage?.cost_usd) {
      cost += safeEv.usage.cost_usd;
      if (safeEv.usage.estimated) costEstimated = true;
      log.emit("budget.observation", {
        harness_id: adapter.id,
        attempt_id: attemptId,
        kind: "spend",
        usd: safeEv.usage.cost_usd,
        estimated: safeEv.usage.estimated === true,
      });
    }
    if (acceptDeliverable) answer.observe(safeEv);
    if (safeEv.type === "error") {
      harnessError = safeEv.error ? redactSecrets(safeEv.error) : "harness emitted an error";
    }
  };
  const drainAfterStop = async (
    iterator: AsyncIterator<HarnessEvent>,
    pending: Promise<IteratorResult<HarnessEvent>>,
  ): Promise<void> => {
    let timer!: ReturnType<typeof setTimeout>;
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), Math.max(1, cleanupGraceMs));
    });
    try {
      let current = pending;
      for (;;) {
        const next = await Promise.race([current.catch(() => null), deadline]);
        if (!next || next.done) break;
        observeEvent(next.value, false);
        current = iterator.next();
      }
      const cleanup: Promise<unknown>[] = cancelTask ? [cancelTask] : [];
      try {
        const returned = iterator.return?.(undefined as never);
        if (returned) cleanup.push(Promise.resolve(returned));
      } catch {}
      if (cleanup.length > 0) await Promise.race([Promise.allSettled(cleanup), deadline]);
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    log.emit("harness.started", {
      harness_id: adapter.id,
      attempt_id: attemptId,
      external_context_policy: built.webPolicy,
    });
    const watched = withInactivityWatchdog(adapter.run(spec), {
      timeoutMs: deps.inactivityTimeoutMs,
      countsAsProgress: countsAsAgentProgress,
      onTimeout: () => {
        reducerAbort.abort();
        cancelActiveSession();
      },
      isSuspended: () => false,
      cleanupDeadlineMs: cleanupGraceMs,
    });
    const iterator = watched[Symbol.asyncIterator]();
    for (;;) {
      const pending = iterator.next();
      const next = await Promise.race([
        pending.then(
          (result) => ({ kind: "next" as const, result }),
          (error: unknown) => ({ kind: "error" as const, error }),
        ),
        stopped.then((reason): { kind: "stopped"; reason: ReducerStop } => ({
          kind: "stopped",
          reason,
        })),
      ]);
      if (next.kind === "stopped") {
        stoppedDuringRun = next.reason;
        await drainAfterStop(iterator, pending);
        break;
      }
      if (stopReason) {
        stoppedDuringRun = stopReason;
        await drainAfterStop(iterator, pending);
        break;
      }
      if (next.kind === "error") throw next.error;
      if (next.result.done) break;
      observeEvent(next.result.value, true);
    }
  } catch (err) {
    harnessError = safeErrorMessage(err);
  } finally {
    cleanupAttempt();
  }
  // D-16: unwrap the WorkReport envelope and finalize through the SAME contract as
  // every other attempt — a capable reducer route that broke its WorkReport
  // contract (or reported needs_input/incomplete/context-exhausted) must NEVER be
  // accepted as a clean synthesis; the caller then degrades to an honest raw
  // bundle. On an inactive-transport route the unwrap passes the report through
  // untouched (unchanged behavior for schema-free reducer harnesses).
  const unwrapped = unwrapWorkReportEnvelope(answer.machineText() ?? "", built.workReportMode, {
    sideToolReport: telemetry.sideToolWorkReport ?? undefined,
  });
  const report = redactSecrets(unwrapped.deliverable);
  const finalized = finalizeAttempt({
    deliverableEvidence: report.trim().length > 0,
    harnessErrored: harnessError !== null,
    workReport: unwrapped.workReport,
    workReportSource: unwrapped.source,
    workReportViolation: unwrapped.contractViolation,
    contextTerminalExhausted: telemetry.contextExhausted,
  });
  if (stoppedDuringRun === "timeout")
    harnessError = `deep-scan reducer timed out after ${deps.hardTimeoutMs}ms`;
  // A reducer must produce a CLEAN merged synthesis: a broken WorkReport contract,
  // a needs_input/incomplete attestation, or a terminal context exhaustion is a
  // typed reducer failure (degrade to the raw bundle), never a laundered success.
  if (!harnessError && finalized.outcomeClass === "contract_failure") {
    harnessError = `deep-scan reducer work_report contract: ${unwrapped.contractViolation}`;
  } else if (!harnessError && finalized.outcomeClass === "veto") {
    harnessError = `deep-scan reducer reported ${finalized.workState.state} instead of a merged synthesis`;
  } else if (!harnessError && finalized.outcomeClass === "interrupted") {
    harnessError = "deep-scan reducer ran out of context before completing the synthesis";
  }
  const reportPresent = finalized.deliverablePresent && report.trim().length > 0;
  if (!harnessError && !reportPresent) harnessError = "deep-scan reducer produced no synthesis";
  // INV-116: a cancel on the OUTER run signal that landed WHILE this bounded
  // reducer streamed is a cancellation — not a clean synthesis and not a typed
  // failure. Any partial output is discarded (deliverablePresent forced false)
  // so it can never be accepted as a merge, and the run terminalizes cancelled.
  const runCancelled = stoppedDuringRun === "cancelled";
  setAttemptOutcome(telemetry, {
    deliverablePresent: reportPresent && !runCancelled,
    gatesPassed: null,
    harnessErrored: harnessError !== null,
    webRequiredUnsatisfied: false,
    workState: finalized.workState,
  });
  // Roster/cost visible: the reducer is a normal attempt in run telemetry.
  args.attemptTelemetries.push({ attemptId, harnessId: adapter.id, telemetry });
  if (runCancelled) {
    log.emit("harness.completed", {
      harness_id: adapter.id,
      attempt_id: attemptId,
      status: "cancelled",
      ...telemetrySummary(telemetry),
    });
    return { status: "cancelled" };
  }
  if (harnessError) {
    log.emit("harness.completed", {
      harness_id: adapter.id,
      attempt_id: attemptId,
      status: "failed",
      error: harnessError,
      ...telemetrySummary(telemetry),
    });
    return { status: "failed", error: harnessError };
  }
  log.emit("harness.completed", {
    harness_id: adapter.id,
    attempt_id: attemptId,
    status: "success",
    ...telemetrySummary(telemetry),
  });
  return { status: "success", report };
}

/** Run the reducer only when multiple reports and an eligible route exist. */
export async function resolveDeepScanSynthesis(
  deps: DeepScanReducerDeps,
  args: {
    succeeded: {
      attemptId: string;
      harnessId: string;
      report: string;
      telemetry: AttemptTelemetry;
    }[];
    adapters: RoutedAdapter[];
    budgetStopped: boolean;
    aborted: boolean;
    taskId: string;
    goal: string;
    findingsDir: string;
    ledger: BudgetLedger;
    log: EventLog;
    paths: RunPaths;
    signal?: AbortSignal;
    onHarnessEvent?: (ev: HarnessEvent) => void;
    attemptTelemetries: { attemptId: string; harnessId: string; telemetry: AttemptTelemetry }[];
  },
): Promise<{ deepScanSynthesis: DeepScanSynthesis; reducedReport: string | null }> {
  const unreduced = (
    status: "skipped" | "failed",
    reason: string,
    reducerAttemptId: string | null = null,
  ) => ({
    deepScanSynthesis: { status, reducer_attempt_id: reducerAttemptId, reason },
    reducedReport: null,
  });
  if (args.succeeded.length < 2) {
    return unreduced("skipped", "single scout report needs no merge");
  }
  if (args.budgetStopped || args.aborted) {
    return unreduced(
      "failed",
      args.aborted ? "run cancelled before synthesis" : "budget exhausted before synthesis",
    );
  }
  // A successful scout's synthesize-capable route owns the merge.
  const eligible = args.succeeded
    .map((s) => args.adapters.find((a) => a.adapter.id === s.harnessId && a.supportsSynthesize))
    .find((a): a is RoutedAdapter => Boolean(a));
  if (!eligible) {
    return unreduced("failed", "no synthesize-capable route among the scout harnesses");
  }
  const reduced = await runDeepScanReducer(deps, {
    taskId: args.taskId,
    goal: args.goal,
    routed: eligible,
    scoutReports: args.succeeded.map((s) => ({
      attemptId: s.attemptId,
      harnessId: s.harnessId,
      absPath: join(args.findingsDir, `${s.attemptId}.md`),
    })),
    ledger: args.ledger,
    log: args.log,
    paths: args.paths,
    signal: args.signal,
    onHarnessEvent: args.onHarnessEvent,
    attemptTelemetries: args.attemptTelemetries,
  });
  if (reduced.status === "success") {
    return {
      deepScanSynthesis: {
        status: "succeeded",
        reducer_attempt_id: DEEP_SCAN_REDUCER_ATTEMPT_ID,
        reason: null,
      },
      reducedReport: reduced.report,
    };
  }
  // DeepScanSynthesis has no cancelled member; the outer run still terminalizes cancelled.
  if (reduced.status === "cancelled") {
    return unreduced("failed", "run cancelled during synthesis", DEEP_SCAN_REDUCER_ATTEMPT_ID);
  }
  const reason =
    reduced.status === "budget_denied"
      ? `reducer budget-denied: ${classifyBudgetFailure({ denial: reduced.denial, terminal: args.ledger.terminal() }).safeMessage}`
      : reduced.error;
  return unreduced("failed", reason, DEEP_SCAN_REDUCER_ATTEMPT_ID);
}

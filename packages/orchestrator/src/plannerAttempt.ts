import { join } from "node:path";
import type { ArtifactStore, RunPaths } from "@claudexor/artifact-store";
import { attemptCostEvidence, type BudgetLedger } from "@claudexor/budget";
import {
  AnswerAssembly,
  countsAsAgentProgress,
  type InteractionChannel,
  withInactivityWatchdog,
} from "@claudexor/core";
import type { EventLog } from "@claudexor/event-log";
import type {
  ExternalContextPolicy,
  HarnessEvent,
  HarnessRunSpec,
  Intent,
  TaskContract,
} from "@claudexor/schema";
import { appendLine, redactSecrets, safeInvoke } from "@claudexor/util";
import {
  finalizeAttempt,
  unrecoveredToolErrorFailure,
  unwrapWorkReportEnvelope,
  webEvidenceFailure,
  type AttemptOutcomeClass,
  type WorkReportEnvelopeMode,
} from "./attemptFinalize.js";
import {
  createAttemptTelemetry,
  observeAttemptTelemetry,
  setAttemptOutcome,
  telemetrySummary,
  unrecoveredToolErrors,
  webUnsatisfied,
  type AttemptTelemetry,
} from "./attemptTelemetry.js";
import { settleGrantedAttemptLease } from "./attemptUsageCost.js";
import { observeNativeSessionEvent } from "./credential-profiles.js";
import type { BudgetDenial } from "./budgetFailure.js";
import type { RoutedAdapter, RunInput } from "./orchestrator.js";
import {
  harnessEventPayload,
  observeAuthSwitch,
  observeBudgetSignals,
  redactHarnessEvent,
  safeErrorMessage,
} from "./runSupport.js";

/** Result of one planner spawn; caller-specific artifact/fallback bookkeeping
 * remains with solo-plan and Council owners. */
export interface PlannerAttemptOutcome {
  attemptId: string;
  harnessId: string;
  status: "success" | "failed" | "blocked";
  outcomeClass: AttemptOutcomeClass;
  error: string | null;
  text: string | null;
  telemetry: AttemptTelemetry | null;
  budgetDenied: boolean;
  budgetDenial?: BudgetDenial | null;
}

/** Inputs shared by solo fallback, Council drafts, and the Council merge. */
export interface PlannerAttemptArgs {
  input: RunInput;
  contract: TaskContract;
  taskId: string;
  runId: string;
  log: EventLog;
  store: ArtifactStore;
  paths: RunPaths;
  ledger: BudgetLedger;
  routed: RoutedAdapter;
  attemptId: string;
  laneRun: boolean;
  fallbackHome: Record<string, string>;
  promptBody: string;
  intent: Intent;
  /** Conservative admission floor for a parallel Council member or a real
   * Delegate child that overlaps its still-running parent. */
  reservationEstimateUsd?: number;
}

export interface PreparedPlannerAttempt {
  knobs: {
    webPolicy: ExternalContextPolicy;
    ignored: string[];
    model: string | null;
  };
  effectiveWeb: ExternalContextPolicy;
  spec: HarnessRunSpec;
  plannerAbort: AbortController;
  planInteraction: InteractionChannel | undefined;
  planWorkMode: WorkReportEnvelopeMode;
}

/** Narrow owner boundary: Orchestrator prepares its private route/session
 * fields; this module owns the planner lease, stream, telemetry, and outcome. */
export interface PlannerAttemptDeps {
  prepare(args: PlannerAttemptArgs): Promise<PreparedPlannerAttempt>;
  billingKnowledge(input: RunInput, harnessId: string): "metered" | "unknown";
  inactivityTimeoutMs(repoRoot: string): number;
  quotaEventSink?: (harnessId: string, event: HarnessEvent) => void;
}

export async function runPlannerAttempt(
  deps: PlannerAttemptDeps,
  args: PlannerAttemptArgs,
): Promise<PlannerAttemptOutcome> {
  const { input, contract, taskId, log, paths, ledger, routed, attemptId } = args;
  const adapter = routed.adapter;
  const lease = ledger.reserve({
    taskId,
    attemptId,
    intent: args.intent,
    harnessId: adapter.id,
    cost: attemptCostEvidence(
      adapter.id,
      attemptId,
      args.reservationEstimateUsd,
      deps.billingKnowledge(input, adapter.id),
    ),
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
      attemptId,
      harnessId: adapter.id,
      status: "failed",
      outcomeClass: "clean",
      error: lease.reason ?? "budget lease denied",
      text: null,
      telemetry: null,
      budgetDenied: true,
      budgetDenial: {
        code: lease.denied ?? "hard_cap",
        reason: lease.reason ?? "budget lease denied",
        harnessId: adapter.id,
        attemptId,
      },
    };
  }

  // Preparation belongs to the granted lease. No harness lifecycle event is
  // emitted until every route/session/spec field and telemetry seed exists.
  const preparation = await (async () => {
    const prepared = await deps.prepare(args);
    return {
      ...prepared,
      attemptEventsPath: join(paths.attemptsDir, attemptId, "events.jsonl"),
      answer: new AnswerAssembly(),
      telemetry: createAttemptTelemetry(
        prepared.knobs.webPolicy,
        contract.external_context.web_required ||
          prepared.knobs.webPolicy === "cached" ||
          prepared.knobs.webPolicy === "live",
        prepared.effectiveWeb,
        [],
        prepared.knobs.model,
      ),
    };
  })().then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  if (!preparation.ok) {
    settleGrantedAttemptLease({
      ledger,
      leaseId: lease.lease?.lease_id ?? "",
      attemptId,
      harnessId: adapter.id,
      costUsd: 0,
      costEstimated: false,
      preStreamFailureSource: "planner-pre-stream",
    });
    return {
      attemptId,
      harnessId: adapter.id,
      status: "failed",
      outcomeClass: "clean",
      error: `planner attempt setup failed: ${safeErrorMessage(preparation.error)}`,
      text: null,
      telemetry: null,
      budgetDenied: false,
    };
  }

  const {
    knobs,
    spec,
    plannerAbort,
    planInteraction,
    planWorkMode,
    attemptEventsPath,
    answer,
    telemetry,
  } = preparation.value;
  const onAbort = () => {
    void adapter.cancel?.(spec.session_id)?.catch(() => {});
  };
  if (input.signal) {
    if (input.signal.aborted) onAbort();
    else input.signal.addEventListener("abort", onAbort, { once: true });
  }
  let cost = 0;
  let costEstimated = false;
  let harnessError: string | null = null;
  const budgetSignalState = { quotaPressureDisclosed: false };
  try {
    log.emit("harness.started", {
      harness_id: adapter.id,
      attempt_id: attemptId,
      external_context_policy: knobs.webPolicy,
      ...(knobs.ignored.length > 0 ? { ignored_settings: knobs.ignored } : {}),
    });
    if (!input.signal?.aborted) {
      const watchedPlan = withInactivityWatchdog(adapter.run(spec), {
        timeoutMs: deps.inactivityTimeoutMs(input.repoRoot),
        countsAsProgress: countsAsAgentProgress,
        onTimeout: () => {
          plannerAbort.abort();
          void adapter.cancel?.(spec.session_id)?.catch(() => {});
        },
        isSuspended: () => (planInteraction?.pendingCount?.() ?? 0) > 0,
        suspensionVersion: () => planInteraction?.suspensionVersion?.() ?? 0,
      });
      for await (const ev of watchedPlan) {
        if (input.signal?.aborted) break;
        const safeEv = redactHarnessEvent(ev);
        safeInvoke(input.onHarnessEvent, safeEv);
        if (args.laneRun) observeNativeSessionEvent(input, adapter.id, safeEv);
        observeAuthSwitch(log, adapter.id, attemptId, safeEv);
        log.emit("harness.event", harnessEventPayload(adapter.id, attemptId, safeEv));
        appendLine(attemptEventsPath, JSON.stringify(safeEv));
        observeAttemptTelemetry(telemetry, safeEv);
        if (safeEv.plan_progress) {
          log.emit("plan.progress", {
            attempt_id: attemptId,
            harness_id: adapter.id,
            items: safeEv.plan_progress.items,
          });
        }
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
        answer.observe(safeEv);
        if (safeEv.type === "error")
          harnessError = safeEv.error ? redactSecrets(safeEv.error) : "harness emitted an error";
      }
    }
  } catch (error) {
    harnessError = safeErrorMessage(error);
  } finally {
    input.signal?.removeEventListener("abort", onAbort);
    settleGrantedAttemptLease({
      ledger,
      leaseId: lease.lease?.lease_id ?? "",
      attemptId,
      harnessId: adapter.id,
      costUsd: cost,
      costEstimated,
      authMode: telemetry.authMode,
      usageCost: telemetry.usageCost,
      preStreamFailureSource: "planner-pre-stream",
    });
  }

  const planUnwrapped = unwrapWorkReportEnvelope(answer.machineText() ?? "", planWorkMode, {
    sideToolReport: telemetry.sideToolWorkReport ?? undefined,
  });
  const planText = redactSecrets(planUnwrapped.deliverable).trim();
  const webBlocked = webUnsatisfied(telemetry);
  if (!harnessError && webBlocked) harnessError = webEvidenceFailure(telemetry.web);
  harnessError ??= unrecoveredToolErrorFailure(
    unrecoveredToolErrors(telemetry),
    planText.length > 0,
  );
  const finalized = finalizeAttempt({
    deliverableEvidence: planText.length > 0,
    harnessErrored: harnessError !== null && !webBlocked,
    workReport: planUnwrapped.workReport,
    workReportSource: planUnwrapped.source,
    workReportViolation: planUnwrapped.contractViolation,
    contextTerminalExhausted: telemetry.contextExhausted,
  });
  if (!harnessError && finalized.outcomeClass === "contract_failure") {
    harnessError = `work_report contract: ${planUnwrapped.contractViolation}`;
  }
  if (!harnessError && finalized.outcomeClass === "interrupted") {
    harnessError = "context capacity exhausted before the plan completed";
  }
  const attemptError =
    harnessError ??
    (finalized.deliverablePresent ? null : "planner produced no plan text") ??
    (input.signal?.aborted ? "planner cancelled" : null);
  setAttemptOutcome(telemetry, {
    deliverablePresent: finalized.deliverablePresent,
    gatesPassed: null,
    harnessErrored: (harnessError !== null && !webBlocked) || finalized.harnessErrored,
    webRequiredUnsatisfied: webBlocked,
    workState: finalized.workState,
  });
  if (attemptError) {
    log.emit("harness.completed", {
      harness_id: adapter.id,
      attempt_id: attemptId,
      status: webBlocked ? "blocked" : "failed",
      error: attemptError,
      ...telemetrySummary(telemetry),
    });
    return {
      attemptId,
      harnessId: adapter.id,
      status: webBlocked ? "blocked" : "failed",
      outcomeClass: finalized.outcomeClass,
      error: attemptError,
      text: null,
      telemetry,
      budgetDenied: false,
    };
  }
  const text = planText || "(no output)";
  log.emit("harness.completed", {
    harness_id: adapter.id,
    attempt_id: attemptId,
    status: "success",
    ...telemetrySummary(telemetry),
  });
  return {
    attemptId,
    harnessId: adapter.id,
    status: "success",
    outcomeClass: finalized.outcomeClass,
    error: null,
    text,
    telemetry,
    budgetDenied: false,
  };
}

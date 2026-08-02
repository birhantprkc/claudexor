import { join } from "node:path";
import type { ArtifactStore } from "@claudexor/artifact-store";
import type { EventLog } from "@claudexor/event-log";
import { RunFailure, RunFailureCode, type ModeKind, type RunOutcomeFacts } from "@claudexor/schema";
import { redactSecrets } from "@claudexor/util";
import type { OrchestratorResult } from "./orchestrator.js";
import { terminalOutcomeFacts } from "./terminalOutcome.js";

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
    /** Structural reopen time for a windowed refusal (spent subscription
     * quota); null/omitted when the failure has no such time. */
    resetsAt?: string | null;
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
    resetsAt: failure.resetsAt ?? null,
    nextActions: failure.nextActions ?? [],
  });
}

/** The typed provenance an error declared about its own terminal. */
export interface DeclaredFailure {
  category?: RunFailure["category"];
  code: RunFailureCode | null;
  resetsAt: string | null;
}

/**
 * The typed provenance an ERROR carries about its own terminal.
 *
 * A refusal that knows exactly what it is (a spent quota window, and when it
 * reopens) must not be flattened into `internal` / `code: null` just because it
 * travelled as an exception: the terminal then states less than the thrower
 * knew, and the only remaining signal is prose. `failTerminally` already read
 * `code` this way; category and reset time follow the same rule. Everything is
 * validated against the schema, so an unrelated error carrying a `category`
 * property of its own cannot smuggle in a bogus classification.
 *
 * A candidate attempt that dies on such an error records this on its
 * `CandidateRun`, so the refusal survives the per-slot catch that otherwise
 * reduces it to a message string.
 */
export function declaredFailure(err: unknown): DeclaredFailure {
  const record = err && typeof err === "object" ? (err as Record<string, unknown>) : {};
  const code = RunFailureCode.safeParse(record["code"]);
  const category = RunFailure.shape.category.safeParse(record["category"]);
  const resetsAt = RunFailure.shape.resetsAt.safeParse(record["resetsAt"]);
  return {
    ...(typeof record["category"] === "string" && category.success
      ? { category: category.data }
      : {}),
    code: code.success ? code.data : null,
    resetsAt: resetsAt.success ? resetsAt.data : null,
  };
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
  const declared = declaredFailure(err);
  const failFacts = terminalOutcomeFacts(failureMeta.priorFacts, "failed", "harness_failed");
  store.writeText(
    join(paths.finalDir, "summary.md"),
    `# Run ${runId} (${mode})\n\n- Lifecycle: failed\n- Phase: ${phase}\n\n${message}\n`,
  );
  writeFailure(store, paths, {
    phase,
    category: declared.category ?? failureMeta.category ?? "internal",
    code: declared.code,
    harnessId: failureMeta.harnessId,
    attemptId: failureMeta.attemptId,
    safeMessage: message,
    rawDetailRef: failureMeta.rawDetailRef,
    runDir: paths.root,
    resetsAt: declared.resetsAt,
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

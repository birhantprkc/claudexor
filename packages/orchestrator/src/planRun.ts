import { join } from "node:path";
import {
  PlanQuestionsArtifact,
  type ActiveTaskContract,
  derivePlanReadiness,
  makeOutcomeFacts,
  type CouncilProjection,
  type ModeKind,
} from "@claudexor/schema";
import { newId, redactSecrets } from "@claudexor/util";
import { ArtifactStore, type RunPaths } from "@claudexor/artifact-store";
import { EventLog } from "@claudexor/event-log";
import { BudgetLedger } from "@claudexor/budget";
import type { AttemptTelemetry } from "./attemptTelemetry.js";
import { readOnlyNoSuccessTerminal, type AttemptOutcomeClass } from "./attemptFinalize.js";
import { cancelledResult, writeFailure } from "./runTerminals.js";
import { type BudgetDenial, budgetFailureRecord, classifyBudgetFailure } from "./budgetFailure.js";
import { extractPlanQuestions } from "./planQuestions.js";
import { emitPlanTerminal, resolvePlanTerminalFacts } from "./planTerminal.js";
import { dominantHarnessFailureCategory, harnessFailureNextActions } from "./harnessFailure.js";
import {
  buildCouncilProjection,
  councilDegradationNote,
  councilDraftRelPath,
  councilMergePrompt,
  resolveCouncilWidth,
} from "./council.js";
import { stageCouncilDraft, type CouncilMergeInput } from "./council-input.js";
import type { OrchestratorResult, RoutedAdapter, RunInput } from "./orchestrator.js";
import type { PlannerAttemptArgs, PlannerAttemptOutcome } from "./plannerAttempt.js";
type PlanAttemptSummary = Pick<
  PlannerAttemptOutcome,
  "attemptId" | "harnessId" | "status" | "error"
> & {
  outcomeClass?: AttemptOutcomeClass;
};
/** Council orchestration and shared solo/Council finalize/failure tails. */
export interface PlanRunDeps {
  /** One planner spawn (native plan mode, read-only) — the SAME machinery the
   * solo plan loop drives; council reuses it per member + for the merge. */
  runPlannerAttempt(args: PlannerAttemptArgs): Promise<PlannerAttemptOutcome>;
  /** Persist the run telemetry artifact (auth-preference resolution lives on
   * the orchestrator, so this stays a bound method). */
  writeRunTelemetry(
    store: ArtifactStore,
    paths: RunPaths,
    contract: ActiveTaskContract,
    runId: string,
    taskId: string,
    mode: ModeKind,
    attempts: { attemptId: string; harnessId: string; telemetry: AttemptTelemetry }[],
    finalAttemptId: string | null,
  ): void;
  /** The tree the harness executes in (project vs. isolated thread worktree). */
  execRootOf(input: RunInput): string;
  /** The solo planner prompt (native plan-mode template with the tagged Open
   * Questions block); council members draft with the same prompt. */
  planPrompt(goal: string): string;
}

/**
 * Council plan strategy (INV-031 / D31). Round 1: every member drafts a plan
 * in parallel, REUSING the same planner spawn (native plan mode, read-only,
 * own lane home on a thread turn). Drafts land as file-backed run artifacts.
 * Merge: ONE extra planner iteration on the PRIMARY (intent=synthesize) whose
 * prompt POINTS at the surviving draft files by absolute path — the tagged
 * Open-Questions parser then runs on the MERGE output only, producing the
 * same final artifacts a solo plan produces (downstream unchanged). A failed
 * member stays failed; its narrowly eligible unverified text may still be input.
 */
export async function runCouncilPlan(
  deps: PlanRunDeps,
  args: {
    input: RunInput;
    contract: ActiveTaskContract;
    taskId: string;
    runId: string;
    store: ArtifactStore;
    paths: RunPaths;
    log: EventLog;
    ledger: BudgetLedger;
    adapters: RoutedAdapter[];
    roHome: { env: Record<string, string>; dispose: () => void };
    contextSection: string;
    laneRun: boolean;
    estimateUsdFloor: number;
  },
): Promise<OrchestratorResult> {
  const { input, contract, taskId, runId, store, paths, log, ledger, adapters, roHome } = args;
  const planAttempts: PlanAttemptSummary[] = [];
  const attemptTelemetries: {
    attemptId: string;
    harnessId: string;
    telemetry: AttemptTelemetry;
  }[] = [];
  // Distinct pool members, primary first (adapters are already ordered +
  // deduped by resolveCandidateAdapters with n=undefined). Council never
  // duplicates a harness into two members.
  const { requested, members: memberCount } = resolveCouncilWidth(input.n, adapters.length);
  const memberAdapters = adapters.slice(0, memberCount);
  log.emit("council.started", {
    requested,
    members: memberAdapters.map((a) => a.adapter.id),
  });
  const mergeInputs: CouncilMergeInput[] = [];
  const draftedIds = new Set<string>();
  const preservedDrafts: string[] = [];
  // First pre-spawn budget refusal owns an all-members-failed budget terminal.
  let councilBudgetDenial: BudgetDenial | null = null;
  try {
    // Round 1 — parallel drafts (each member = one planner attempt).
    const outcomes = await Promise.allSettled(
      memberAdapters.map((routed, idx) =>
        deps.runPlannerAttempt({
          input,
          contract,
          taskId,
          runId,
          log,
          store,
          paths,
          ledger,
          routed,
          attemptId: `p${String(idx + 1).padStart(2, "0")}`,
          laneRun: args.laneRun,
          fallbackHome: roHome.env,
          promptBody: deps.planPrompt(input.prompt) + args.contextSection,
          intent: "plan",
          reservationEstimateUsd:
            idx > 0 || input.delegatedFromRunId ? args.estimateUsdFloor : undefined,
        }),
      ),
    );
    for (const settled of outcomes) {
      if (settled.status === "rejected") continue;
      const outcome = settled.value;
      const staged = stageCouncilDraft(outcome, store, paths, input.signal?.aborted === true);
      if (staged.preservedDraft) preservedDrafts.push(staged.preservedDraft);
      if (staged.input) mergeInputs.push(staged.input);
      if (outcome.telemetry)
        attemptTelemetries.push({
          attemptId: outcome.attemptId,
          harnessId: outcome.harnessId,
          telemetry: outcome.telemetry,
        });
      planAttempts.push({
        attemptId: outcome.attemptId,
        harnessId: outcome.harnessId,
        status: outcome.status === "success" && !staged.input ? "failed" : outcome.status,
        outcomeClass: outcome.outcomeClass,
        error: staged.error,
      });
      if (outcome.budgetDenied) councilBudgetDenial ??= outcome.budgetDenial ?? null;
      if (staged.input && !staged.input.unverified) {
        draftedIds.add(outcome.harnessId);
        log.emit("council.draft", {
          harness_id: outcome.harnessId,
          path: councilDraftRelPath(outcome.harnessId),
        });
      } else {
        log.emit("council.member.failed", {
          harness_id: outcome.harnessId,
          attempt_id: outcome.attemptId,
          error: staged.input?.unverified ? outcome.error : staged.error,
          ...(staged.input?.unverified
            ? { unverified_draft_path: councilDraftRelPath(outcome.harnessId) }
            : {}),
        });
      }
    }
    // A planner already normalizes harness failures. Unexpected persistence or
    // event failures remain run failures, after siblings and saved inputs settle.
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    if (rejected) throw rejected.reason;
  } catch (err) {
    // QA-047 root cause 2: the success path keeps roHome alive so the merge
    // REUSES the admitted context (draft authenticated there) instead of a
    // fresh HOME whose cold native-status probe times out. Leak-safe here.
    roHome.dispose();
    throw err;
  }

  if (input.signal?.aborted) {
    roHome.dispose();
    return cancelledResult(
      log,
      runId,
      taskId,
      "plan",
      paths.root,
      planAttempts.map((p) => ({
        attemptId: p.attemptId,
        harnessId: p.harnessId,
        status: p.status,
      })),
      () =>
        deps.writeRunTelemetry(
          store,
          paths,
          contract,
          runId,
          taskId,
          "plan",
          attemptTelemetries,
          null,
        ),
      ledger.spend(),
      input.signal,
      store,
    );
  }

  if (mergeInputs.length === 0) {
    roHome.dispose();
    return writePlanHarnessFailure(
      deps,
      {
        contract,
        taskId,
        runId,
        store,
        paths,
        log,
        ledger,
        planAttempts,
        attemptTelemetries,
        budgetDenial: councilBudgetDenial,
        preservedDrafts,
      },
      "all council members failed",
    );
  }

  // Prefer accepted drafts in admitted order, then the first eligible unverified lane.
  const primary =
    memberAdapters.find((a) => draftedIds.has(a.adapter.id)) ??
    (memberAdapters.find((a) =>
      mergeInputs.some((d) => d.harnessId === a.adapter.id),
    ) as RoutedAdapter);
  let mergeOutcome: PlannerAttemptOutcome;
  try {
    mergeOutcome = await deps.runPlannerAttempt({
      input,
      contract,
      taskId,
      runId,
      log,
      store,
      paths,
      ledger,
      routed: primary,
      attemptId: `p${String(memberCount + 1).padStart(2, "0")}`,
      laneRun: args.laneRun,
      // QA-047 root cause 2: merge in the SAME admitted route context (not a
      // fresh HOME whose cold native-status probe times out as an absent login).
      fallbackHome: roHome.env,
      promptBody: councilMergePrompt(input.prompt, mergeInputs),
      // D31: the merge is a synthesis iteration on the primary.
      intent: "synthesize",
      reservationEstimateUsd: input.delegatedFromRunId ? args.estimateUsdFloor : undefined,
    });
  } finally {
    roHome.dispose();
  }
  if (mergeOutcome.telemetry)
    attemptTelemetries.push({
      attemptId: mergeOutcome.attemptId,
      harnessId: mergeOutcome.harnessId,
      telemetry: mergeOutcome.telemetry,
    });
  planAttempts.push({
    attemptId: mergeOutcome.attemptId,
    harnessId: mergeOutcome.harnessId,
    status: mergeOutcome.status,
    outcomeClass: mergeOutcome.outcomeClass,
    error: mergeOutcome.error,
  });

  const mergedBy = mergeOutcome.status === "success" ? primary.adapter.id : null;
  // QA-047 root cause 4: a member card carries its DRAFT error only — the
  // primary owns two attempts under one harness id (draft + merge), so a
  // harness-id-only lookup would misattach the merge failure to a drafted member.
  const mergeAttemptId = mergeOutcome.attemptId;
  const councilProjection = buildCouncilProjection({
    requested,
    members: memberAdapters.map((a) => ({
      harnessId: a.adapter.id,
      role: a.adapter.id === primary.adapter.id ? "primary" : "member",
      drafted: draftedIds.has(a.adapter.id),
      error:
        planAttempts.find(
          (p) => p.harnessId === a.adapter.id && p.attemptId !== mergeAttemptId && p.error,
        )?.error ?? null,
    })),
    mergedBy,
  });
  log.emit("council.merged", {
    merged_by: mergedBy,
    drafted: councilProjection.drafted,
    requested: councilProjection.requested,
    degraded: councilProjection.degraded,
  });

  if (mergeOutcome.status !== "success" || !mergeOutcome.text) {
    // The merge itself failed despite surviving drafts — no unified plan
    // exists. Fail typed; the drafts remain as disclosed artifacts.
    store.writeYaml(join(paths.root, "council", "membership.yaml"), councilProjection);
    return writePlanHarnessFailure(
      deps,
      {
        contract,
        taskId,
        runId,
        store,
        paths,
        log,
        ledger,
        planAttempts,
        attemptTelemetries,
        budgetDenial: mergeOutcome.budgetDenied ? (mergeOutcome.budgetDenial ?? null) : null,
        preservedDrafts,
      },
      `council merge failed: ${mergeOutcome.error ?? "the primary produced no unified plan"}`,
    );
  }

  return finalizePlanRun(deps, {
    input,
    contract,
    taskId,
    runId,
    store,
    paths,
    log,
    ledger,
    plans: [{ id: primary.adapter.id, text: mergeOutcome.text }],
    planAttempts,
    attemptTelemetries,
    winnerAttemptId: mergeOutcome.attemptId,
    council: councilProjection,
    councilUnverifiedInputs: mergeInputs.filter((d) => d.unverified).length,
  });
}

/** Write final plan artifacts (plan.md, questions.json, work_product, summary,
 * telemetry) and the terminal event, then return the result. ONE owner for both
 * the solo and council success tails so the artifacts are shape-identical. */
export function finalizePlanRun(
  deps: PlanRunDeps,
  args: {
    input: RunInput;
    contract: ActiveTaskContract;
    taskId: string;
    runId: string;
    store: ArtifactStore;
    paths: RunPaths;
    log: EventLog;
    ledger: BudgetLedger;
    plans: { id: string; text: string }[];
    planAttempts: PlanAttemptSummary[];
    attemptTelemetries: { attemptId: string; harnessId: string; telemetry: AttemptTelemetry }[];
    winnerAttemptId?: string | null;
    council: CouncilProjection | null;
    councilUnverifiedInputs?: number;
  },
): OrchestratorResult {
  const {
    input,
    contract,
    taskId,
    runId,
    store,
    paths,
    log,
    ledger,
    plans,
    planAttempts,
    council,
  } = args;
  const failedPlanners = planAttempts.filter((p) => p.status !== "success");
  const winner = plans[0];
  const winnerHarness = winner?.id ?? "(none)";
  const winnerAttemptId =
    args.winnerAttemptId ?? planAttempts.find((p) => p.status === "success")?.attemptId ?? null;
  // final/plan.md is the PURE plan body (implement freezes+hashes it; V6a).
  const planDoc = redactSecrets(winner?.text ?? "(no output)");
  store.writeText(join(paths.finalDir, "plan.md"), planDoc + "\n");
  // Engine-parsed open questions (final/questions.json): the ONE artifact plan
  // readiness derives from. For council this runs on the MERGE output only.
  const parsedQuestions = extractPlanQuestions(planDoc);
  store.writeJson(join(paths.finalDir, "questions.json"), parsedQuestions);
  if (council) store.writeYaml(join(paths.root, "council", "membership.yaml"), council);
  // A plan is a delivered work product (a report); result_kind=plan tells
  // surfaces NO files changed.
  store.writeYaml(join(paths.finalDir, "work_product.yaml"), {
    id: newId("wp"),
    kind: "report",
    source_task_id: taskId,
    producer_attempt_id: winnerAttemptId,
    meta: {
      mode: "plan",
      result_kind: "plan",
      planners: council?.members.length ?? plans.length,
      diffstat: { files: 0, additions: 0, deletions: 0 },
      blockers: 0,
      adopted: null,
    },
  });
  const readiness = derivePlanReadiness(PlanQuestionsArtifact.parse(parsedQuestions));
  const councilNote = council ? councilDegradationNote(council) : "";
  const councilInputs = `${council?.drafted ?? 0} contract-accepted draft(s), ${args.councilUnverifiedInputs ?? 0} unverified draft(s)`;
  // D-16: fold the WINNING attempt's work_state into the plan terminal (INV-116; see planTerminal.ts).
  const { planFacts, planVetoed, lifecycleLine, summarySuffix } = resolvePlanTerminalFacts(
    args.attemptTelemetries,
    winnerAttemptId,
  );
  store.writeText(
    join(paths.finalDir, "summary.md"),
    [
      `# Run ${runId} (plan)`,
      "",
      lifecycleLine,
      council
        ? `- Council: merged by ${council.mergedBy ?? "(none)"}; inputs: ${councilInputs}; ${council.requested} member(s) requested`
        : `- Planner: ${winnerHarness}`,
      `- Plan: final/plan.md`,
      `- Open questions: ${readiness.questionCount}${parsedQuestions.parse === "none_found" ? " (no tagged block — unverified)" : ""}`,
      `- Goal: ${redactSecrets(input.prompt).slice(0, 400)}`,
      ...(councilNote ? [`- Council note: ${councilNote}`] : []),
      ...(failedPlanners.length > 0 && !council
        ? [
            `- Fallback omissions: ${failedPlanners.map((p) => `${p.harnessId} ${p.status}`).join(", ")}`,
          ]
        : []),
      "",
    ].join("\n"),
  );
  deps.writeRunTelemetry(
    store,
    paths,
    contract,
    runId,
    taskId,
    "plan",
    args.attemptTelemetries,
    winnerAttemptId,
  );
  log.emit("output.ready", { kind: "plan", path: "final/plan.md" });
  log.emit("plan.questions", {
    parse: parsedQuestions.parse,
    question_count: readiness.questionCount,
    readiness: readiness.state,
  });
  // D-16 terminal disclosure keyed on the folded facts (see planTerminal.ts).
  emitPlanTerminal(store, paths, log, planFacts, planVetoed);
  return {
    spendUsd: ledger.spend(),
    runId,
    taskId,
    mode: "plan",
    lifecycle: planFacts.lifecycle,
    facts: planFacts,
    winner: null,
    runDir: paths.root,
    summary: `${council ? `Council plan (merged by ${winnerHarness}; ${councilInputs})` : `Plan by ${winnerHarness}`}; ${readiness.questionCount} open question(s)${parsedQuestions.parse === "none_found" ? " (untagged plan — unverified)" : ""}${summarySuffix}.`,
    candidates: planAttempts.map((p) => ({
      attemptId: p.attemptId,
      harnessId: p.harnessId,
      status: p.status,
    })),
  };
}

/** Shared typed-failure tail for a plan run where NO plan body was produced
 * (every planner failed, or the council merge failed). Mirrors the solo
 * plans.length===0 path so both surfaces disclose identically. */
export function writePlanHarnessFailure(
  deps: PlanRunDeps,
  ctx: {
    contract: ActiveTaskContract;
    taskId: string;
    runId: string;
    store: ArtifactStore;
    paths: RunPaths;
    log: EventLog;
    ledger: BudgetLedger;
    planAttempts: PlanAttemptSummary[];
    attemptTelemetries: { attemptId: string; harnessId: string; telemetry: AttemptTelemetry }[];
    /** QA-050: the typed budget denial captured when a planner slot was refused
     * pre-spawn, so plan/council terminals emit a budget failure (typed code +
     * remediation) instead of a harness auth/setup template. */
    budgetDenial?: BudgetDenial | null;
    preservedDrafts?: string[];
  },
  fallbackMessage: string,
): OrchestratorResult {
  const { contract, taskId, runId, store, paths, log, ledger, planAttempts } = ctx;
  const blocked = planAttempts.some((p) => p.status === "blocked");
  // QA-050: a budget refusal (pre-spawn denial, or a settled budget terminal)
  // is a BUDGET failure across plan + council, not a harness one.
  const budgetMapping =
    !blocked && (ctx.budgetDenial || ledger.terminal())
      ? classifyBudgetFailure({ denial: ctx.budgetDenial ?? null, terminal: ledger.terminal() })
      : null;
  // QA-047 root cause 3: a proven-success draft can NEVER read "failed". Only
  // non-success attempts feed failure lines; drafts are preserved evidence.
  const failedLines = planAttempts
    .filter((p) => p.status !== "success")
    .map((p) => `${p.attemptId}/${p.harnessId}: ${p.error ?? "failed"}`);
  const preserved =
    ctx.preservedDrafts ??
    planAttempts.filter((p) => p.status === "success").map((p) => `${p.attemptId}/${p.harnessId}`);
  const message = redactSecrets(
    `${budgetMapping ? budgetMapping.safeMessage : failedLines.length > 0 ? failedLines.join("\n") : fallbackMessage}${preserved.length > 0 ? `\nPreserved drafts: ${preserved.join(", ")}` : ""}`.trim(),
  );
  deps.writeRunTelemetry(
    store,
    paths,
    contract,
    runId,
    taskId,
    "plan",
    ctx.attemptTelemetries,
    null,
  );
  store.writeText(
    join(paths.contextDir, "context_error.md"),
    `# ${budgetMapping ? "Budget Denied" : "Harness Error"}\n\n${message}\n`,
  );
  if (budgetMapping) {
    writeFailure(
      store,
      paths,
      budgetFailureRecord(budgetMapping, {
        eventRefs: planAttempts.map((p) => `attempts/${p.attemptId}/events.jsonl`),
        runDir: paths.root,
      }),
    );
  } else {
    const harnessCategory = dominantHarnessFailureCategory(
      ctx.attemptTelemetries.flatMap((attempt) => attempt.telemetry.transientFailures),
    );
    writeFailure(store, paths, {
      phase: "harness",
      category: blocked ? "policy" : "harness_error",
      safeMessage: message,
      eventRefs: planAttempts.map((p) => `attempts/${p.attemptId}/events.jsonl`),
      runDir: paths.root,
      nextActions: harnessFailureNextActions(harnessCategory),
    });
  }
  // D-16 r9: when NO planner blocked/budget-failed and some ran out of
  // context, the terminal is interrupted — not a generic harness failure.
  const anyInterrupted = planAttempts.some((p) => p.outcomeClass === "interrupted");
  // The Plan failure tail has no canonical final/plan.md by definition. Reuse
  // the read-only deliverable owner so a policy-blocked raw response cannot be
  // promoted to a successful "Needs review" run after its plan was discarded.
  const noPlanTerminal = readOnlyNoSuccessTerminal({
    webBlocked: blocked,
    hasDeliverable: false,
    budgetStopped: false,
    attemptsCount: planAttempts.length,
  });
  const planFailFacts =
    !blocked && !budgetMapping && anyInterrupted
      ? makeOutcomeFacts("interrupted", { reason: "context_capacity_exhausted" })
      : budgetMapping
        ? makeOutcomeFacts("failed", { reason: budgetMapping.reason })
        : makeOutcomeFacts(noPlanTerminal.lifecycle, { reason: noPlanTerminal.reason });
  store.writeText(
    join(paths.finalDir, "summary.md"),
    `# Run ${runId} (plan)\n\n- Lifecycle: ${planFailFacts.lifecycle}${planFailFacts.reason ? ` (${planFailFacts.reason})` : ""}\n\n${message}\n`,
  );
  log.emit("output.ready", { kind: "summary", path: "final/summary.md", state: "diagnostic" });
  const failPhase = budgetMapping ? budgetMapping.phase : "harness";
  log.emit("run.failed", {
    lifecycle: planFailFacts.lifecycle,
    facts: planFailFacts,
    reason: planFailFacts.reason,
    phase: failPhase,
    ...(budgetMapping?.harnessId ? { harness_id: budgetMapping.harnessId } : {}),
    error: message,
    failure_ref: "final/failure.yaml",
  });
  return {
    spendUsd: ledger.spend(),
    runId,
    taskId,
    mode: "plan",
    lifecycle: planFailFacts.lifecycle,
    facts: planFailFacts,
    winner: null,
    runDir: paths.root,
    summary: message,
    candidates: planAttempts.map((p) => ({
      attemptId: p.attemptId,
      harnessId: p.harnessId,
      status: p.status,
    })),
  };
}

import { join } from "node:path";
import type { ArtifactStore, RunPaths } from "@claudexor/artifact-store";
import type { PlannerAttemptOutcome } from "./plannerAttempt.js";
import { councilDraftRelPath } from "./council.js";
import { safeErrorMessage } from "./runSupport.js";

/** File-backed input to the existing merger, not an attempt verdict. */
export interface CouncilMergeInput {
  attemptId: string;
  harnessId: string;
  absPath: string;
  evidencePath: string;
  unverified: boolean;
  error: string | null;
}

/** Keep availability separate from the original attempt's success. Only the
 * precisely parsed contradiction may supply a new unverified input. */
export function stageCouncilDraft(
  outcome: PlannerAttemptOutcome,
  store: ArtifactStore,
  paths: RunPaths,
  aborted: boolean,
): { input: CouncilMergeInput | null; error: string | null; preservedDraft: string | null } {
  const unverified =
    outcome.status === "failed" &&
    outcome.outcomeClass === "contract_failure" &&
    outcome.reportProblem?.kind === "completed_with_required_inputs" &&
    outcome.harnessFailedBeforeReport === false &&
    outcome.telemetry?.outcome?.webRequiredUnsatisfied !== true &&
    outcome.telemetry?.contextExhausted !== true &&
    !outcome.budgetDenied &&
    !aborted;
  if (!outcome.text?.trim() || (outcome.status !== "success" && !unverified)) {
    return { input: null, error: outcome.error, preservedDraft: null };
  }
  const draftPath = councilDraftRelPath(outcome.harnessId);
  const evidencePath = join(paths.attemptsDir, outcome.attemptId, "council-input.yaml");
  let preservedDraft: string | null = null;
  try {
    const absPath = join(paths.root, draftPath);
    store.writeText(absPath, outcome.text);
    preservedDraft = `${outcome.attemptId}/${outcome.harnessId}: ${draftPath}${unverified ? " (UNVERIFIED)" : ""}`;
    store.writeYaml(evidencePath, {
      attempt_id: outcome.attemptId,
      harness_id: outcome.harnessId,
      status: outcome.status,
      outcome_class: outcome.outcomeClass,
      error: outcome.error,
      harness_failed_before_report: outcome.harnessFailedBeforeReport,
      work_state: outcome.telemetry?.outcome?.workState ?? {
        state: "unverified",
        source: "absent",
      },
      ...(outcome.reportProblem ? { report_problem: outcome.reportProblem } : {}),
      draft_path: draftPath,
    });
    return {
      input: {
        attemptId: outcome.attemptId,
        harnessId: outcome.harnessId,
        absPath,
        evidencePath,
        unverified,
        error: outcome.error,
      },
      error: unverified
        ? `${outcome.error}\nUnverified draft retained for the merge: ${draftPath}`
        : outcome.error,
      preservedDraft,
    };
  } catch (error) {
    return {
      input: null,
      error: [outcome.error, `Could not retain Council input: ${safeErrorMessage(error)}`]
        .filter(Boolean)
        .join("\n"),
      preservedDraft,
    };
  }
}

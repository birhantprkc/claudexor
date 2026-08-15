import { isTerminalLifecycle, RunFactsInvalidError, type RunOutcomeFacts } from "@claudexor/schema";
import { CliError } from "./cli-error.js";
import {
  describeRunDetailProblem,
  projectApplyEligibility,
  projectOutcomeBanner,
  presentRunPrimaryOutput,
  projectRunFailure,
  projectRunCouncil,
  projectRunLineage,
  projectRunPrimaryOutput,
  projectRunSpendUsd,
} from "./run-detail-projections.js";
import { projectRunOutcomeFacts } from "./daemon-outcome.js";
import { projectRunFacts, type ExpectedRunFactsIdentity } from "./run-facts-projection.js";

export function projectImmediateRunDetail(
  detail: Record<string, unknown> | null,
  expected: ExpectedRunFactsIdentity = {},
) {
  return {
    runFacts: projectRunFacts(detail, expected),
    outcomeFacts: projectRunOutcomeFacts(detail),
    applyEligibility: projectApplyEligibility(detail),
    spendUsd: projectRunSpendUsd(detail),
    council: projectRunCouncil(detail),
    outcomeBanner: projectOutcomeBanner(detail),
    planReadiness:
      detail?.["planReadiness"] && typeof detail["planReadiness"] === "object"
        ? detail["planReadiness"]
        : null,
    failure: projectRunFailure(detail),
    ...projectRunLineage(detail),
  };
}

/** One typed read projection for inspect/status/result from a single detail snapshot. */
export function projectRecoveryRunDetail(
  mode: string,
  runId: string,
  detail: Record<string, unknown>,
  delegationParentRunId?: string,
): Record<string, unknown> {
  const summary = (detail["summary"] ?? {}) as Record<string, unknown>;
  if (summary["runId"] !== runId) {
    throw new CliError("operational", `run detail identity does not match requested run ${runId}`, {
      code: "invalid_service_response",
      retryable: true,
    });
  }
  if (
    delegationParentRunId !== undefined &&
    summary["delegatedFromRunId"] !== delegationParentRunId
  ) {
    throw Object.assign(new Error(`run ${runId} is not a child of this delegation parent`), {
      code: "delegation_child_scope_violation",
      status: 403,
    });
  }
  const decision = (detail["decision"] ?? null) as Record<string, unknown> | null;
  const status =
    (typeof summary["state"] === "string" ? summary["state"] : null) ??
    (typeof summary["status"] === "string" ? summary["status"] : null) ??
    null;
  const runFacts =
    status === "queued" || status === "running"
      ? null
      : projectRunFacts(detail, {
          runId,
          ...(status && isTerminalLifecycle(status)
            ? { lifecycle: status as RunOutcomeFacts["lifecycle"] }
            : {}),
        });
  const base = {
    runId,
    runDir: typeof summary["runDir"] === "string" ? summary["runDir"] : null,
    status,
    runFacts,
    decisionStatus: decision ? ((decision["status"] as string | null) ?? null) : null,
    pendingInteractions: Array.isArray(detail["pendingInteractions"])
      ? (detail["pendingInteractions"] as unknown[]).length
      : null,
    outcomeFacts: projectRunOutcomeFacts(detail),
    outcomeBanner: typeof detail["outcomeBanner"] === "string" ? detail["outcomeBanner"] : null,
    applyEligibility: detail["applyEligibility"] ?? null,
    planReadiness: detail["planReadiness"] ?? null,
    council: detail["council"] && typeof detail["council"] === "object" ? detail["council"] : null,
    budget: detail["budget"] && typeof detail["budget"] === "object" ? detail["budget"] : null,
    failure: projectRunFailure(detail),
    parentRunId: typeof summary["parentRunId"] === "string" ? summary["parentRunId"] : null,
    delegatedFromRunId:
      typeof summary["delegatedFromRunId"] === "string" ? summary["delegatedFromRunId"] : null,
    delegation:
      summary["delegation"] && typeof summary["delegation"] === "object"
        ? summary["delegation"]
        : null,
  };
  if (mode !== "__run_result") {
    return {
      summary:
        typeof detail["finalSummary"] === "string" && detail["finalSummary"]
          ? detail["finalSummary"]
          : `run ${runId}: ${String(status ?? "unknown")}`,
      ...base,
    };
  }
  const primary = projectRunPrimaryOutput(detail);
  const presented = presentRunPrimaryOutput(primary);
  const primaryKind = primary?.kind ?? null;
  const outcomeBanner = projectOutcomeBanner(detail);
  const terminalSummary =
    presented && primaryKind !== "patch"
      ? presented
      : outcomeBanner
        ? outcomeBanner
        : typeof detail["finalSummary"] === "string" && detail["finalSummary"]
          ? detail["finalSummary"]
          : primaryKind === "patch"
            ? "patch produced (see artifact handles)"
            : `run ${runId}: ${String(status ?? "unknown")}`;
  return { summary: terminalSummary, ...base };
}

/** Only canonical detail-integrity failures preserve a public recovery handle. */
export function isRecoverableRunDetailIntegrityProblem(error: unknown): boolean {
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const code = record["code"];
  if (code !== "run_facts_invalid" && code !== "invalid_service_response") return false;
  if (typeof record["mcpRecoveryTypedControlProblem"] === "boolean") {
    return record["mcpRecoveryTypedControlProblem"] === true;
  }
  return error instanceof RunFactsInvalidError || error instanceof CliError;
}

/** Minimal schema-valid handle when public recovery cannot trust run detail. */
export function projectDegradedRecoveryRunDetail(
  runId: string,
  error: unknown,
): Record<string, unknown> {
  return {
    summary: `run ${runId}: detail unavailable`,
    runId,
    runDir: null,
    status: null,
    runFacts: null,
    decisionStatus: null,
    pendingInteractions: null,
    outcomeFacts: null,
    failure: null,
    outcomeBanner: null,
    applyEligibility: null,
    planReadiness: null,
    council: null,
    budget: null,
    parentRunId: null,
    delegatedFromRunId: null,
    delegation: null,
    detailProblem: describeRunDetailProblem(error),
  };
}

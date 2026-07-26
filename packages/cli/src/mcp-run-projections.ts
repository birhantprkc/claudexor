import {
  projectApplyEligibility,
  projectOutcomeBanner,
  projectRunCouncil,
  projectRunLineage,
  projectRunSpendUsd,
} from "./run-detail-projections.js";

export function projectImmediateRunDetail(detail: Record<string, unknown> | null) {
  return {
    applyEligibility: projectApplyEligibility(detail),
    spendUsd: projectRunSpendUsd(detail),
    council: projectRunCouncil(detail),
    outcomeBanner: projectOutcomeBanner(detail),
    planReadiness:
      detail?.["planReadiness"] && typeof detail["planReadiness"] === "object"
        ? detail["planReadiness"]
        : null,
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
  if (delegationParentRunId && summary["delegatedFromRunId"] !== delegationParentRunId) {
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
  const base = {
    runId,
    runDir: typeof summary["runDir"] === "string" ? summary["runDir"] : null,
    status,
    decisionStatus: decision ? ((decision["status"] as string | null) ?? null) : null,
    pendingInteractions: Array.isArray(detail["pendingInteractions"])
      ? (detail["pendingInteractions"] as unknown[]).length
      : null,
    outcomeFacts:
      summary["outcomeFacts"] && typeof summary["outcomeFacts"] === "object"
        ? summary["outcomeFacts"]
        : null,
    outcomeBanner: typeof detail["outcomeBanner"] === "string" ? detail["outcomeBanner"] : null,
    applyEligibility: detail["applyEligibility"] ?? null,
    planReadiness: detail["planReadiness"] ?? null,
    council: detail["council"] && typeof detail["council"] === "object" ? detail["council"] : null,
    budget: detail["budget"] && typeof detail["budget"] === "object" ? detail["budget"] : null,
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
  const primary =
    detail["primaryOutput"] && typeof detail["primaryOutput"] === "object"
      ? (detail["primaryOutput"] as Record<string, unknown>)
      : null;
  const primaryText = typeof primary?.["text"] === "string" ? primary["text"].trim() : "";
  const presented =
    primaryText && primary?.["truncated"] === true
      ? `${primaryText}\n\n[Inline preview bounded; full artifact: ${String(primary["path"] ?? "unknown")}]`
      : primaryText;
  const primaryKind = typeof primary?.["kind"] === "string" ? primary["kind"] : null;
  const terminalSummary =
    presented && primaryKind !== "patch"
      ? presented
      : typeof detail["finalSummary"] === "string" && detail["finalSummary"]
        ? detail["finalSummary"]
        : primaryKind === "patch"
          ? "patch produced (see artifact handles)"
          : `run ${runId}: ${String(status ?? "unknown")}`;
  return { summary: terminalSummary, ...base };
}

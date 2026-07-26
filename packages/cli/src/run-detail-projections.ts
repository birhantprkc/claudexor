import { CouncilProjection } from "@claudexor/schema";

export type ApplyEligibilityProjection = {
  eligible: boolean;
  state: string | null;
  reason: string | null;
  requiredAction: string | null;
};

export function projectApplyEligibility(
  detail: Record<string, unknown> | null,
): ApplyEligibilityProjection | null {
  const value = detail?.["applyEligibility"];
  return value && typeof value === "object" ? (value as ApplyEligibilityProjection) : null;
}

export function projectRunSpendUsd(detail: Record<string, unknown> | null): number | null {
  const summary = detail?.["summary"];
  const spend =
    summary && typeof summary === "object"
      ? (summary as { spendUsd?: unknown }).spendUsd
      : undefined;
  return typeof spend === "number" && Number.isFinite(spend) ? spend : null;
}

export function projectRunCouncil(detail: Record<string, unknown> | null): unknown {
  const parsed = CouncilProjection.safeParse(detail?.["council"]);
  return parsed.success ? parsed.data : null;
}

export function projectRunLineage(detail: Record<string, unknown> | null): {
  parentRunId: string | null;
  delegatedFromRunId: string | null;
  delegation: Record<string, unknown> | null;
} {
  const summary =
    detail?.["summary"] && typeof detail["summary"] === "object"
      ? (detail["summary"] as Record<string, unknown>)
      : null;
  return {
    parentRunId: typeof summary?.["parentRunId"] === "string" ? summary["parentRunId"] : null,
    delegatedFromRunId:
      typeof summary?.["delegatedFromRunId"] === "string" ? summary["delegatedFromRunId"] : null,
    delegation:
      summary?.["delegation"] && typeof summary["delegation"] === "object"
        ? (summary["delegation"] as Record<string, unknown>)
        : null,
  };
}

export function projectOutcomeBanner(detail: Record<string, unknown> | null): string | null {
  const banner = detail?.["outcomeBanner"];
  return typeof banner === "string" && banner.length > 0 ? banner : null;
}

import type { CostKnowledge } from "@claudexor/schema";
import type { BudgetSettlement } from "./ledger.js";

export function usageCostSettlement(
  cashUsd: number,
  estimated: boolean,
  source: string,
  provenance: string[],
): BudgetSettlement {
  return cashUsd > 0
    ? {
        knowledge: measuredKnowledge(estimated),
        cashKnowledge: measuredKnowledge(estimated),
        source,
        provenance,
        cashUsd,
      }
    : { knowledge: "unknown", source: `${source}-missing`, provenance };
}

export function reviewUsageCostSettlement(
  cashUsd: number,
  valuationUsd: number,
  estimated: boolean,
  provenance: string[],
  unknownUsd = 0,
): BudgetSettlement {
  const observed = cashUsd > 0 || valuationUsd > 0 || unknownUsd > 0;
  const normalizedValuation = Math.max(0, valuationUsd);
  return {
    knowledge: observed && unknownUsd === 0 ? measuredKnowledge(estimated) : "unknown",
    cashKnowledge:
      unknownUsd > 0 ? "unknown" : cashUsd > 0 ? measuredKnowledge(estimated) : "exact",
    ...(normalizedValuation > 0 || unknownUsd > 0
      ? {
          valuationKnowledge: unknownUsd > 0 ? ("unknown" as const) : measuredKnowledge(estimated),
        }
      : {}),
    source: observed ? "review-usage" : "review-usage-missing",
    provenance,
    cashUsd: Math.max(0, cashUsd),
    ...(normalizedValuation > 0 ? { valuationUsd: normalizedValuation } : {}),
  };
}

export function attemptUsageCostSettlement(
  totalUsd: number,
  estimated: boolean,
  attemptId: string,
  harnessId: string,
  authMode?: "local_session" | "api_key" | null,
  split?: {
    cashUsd: number;
    valuationUsd: number;
    unknownUsd: number;
    cashEstimated?: boolean;
    valuationEstimated?: boolean;
  },
): BudgetSettlement {
  if (split) {
    const observed = split.cashUsd + split.valuationUsd + split.unknownUsd;
    if (observed > 0) {
      const normalizedValuation = Math.max(0, split.valuationUsd);
      return {
        knowledge: split.unknownUsd > 0 ? "unknown" : measuredKnowledge(estimated),
        cashKnowledge:
          split.unknownUsd > 0 ? "unknown" : split.cashEstimated === true ? "estimated" : "exact",
        ...(normalizedValuation > 0 || split.unknownUsd > 0
          ? {
              valuationKnowledge:
                split.unknownUsd > 0
                  ? ("unknown" as const)
                  : measuredKnowledge(split.valuationEstimated === true),
            }
          : {}),
        source: "harness-usage-by-route",
        provenance: [`attempt:${attemptId}`, `harness:${harnessId}`, "route:per-usage-event"],
        cashUsd: split.cashUsd,
        ...(normalizedValuation > 0 ? { valuationUsd: normalizedValuation } : {}),
      };
    }
  }
  if (isSubscriptionValuation(authMode)) {
    return {
      knowledge: measuredKnowledge(estimated),
      cashKnowledge: "exact",
      ...(totalUsd > 0 ? { valuationKnowledge: measuredKnowledge(estimated) } : {}),
      source: "harness-token-valuation",
      provenance: [`attempt:${attemptId}`, `harness:${harnessId}`, "route:vendor_native"],
      ...(totalUsd > 0 ? { valuationUsd: totalUsd } : {}),
    };
  }
  return usageCostSettlement(totalUsd, estimated, "harness-usage", [
    `attempt:${attemptId}`,
    `harness:${harnessId}`,
    ...(authMode ? [`route:${authMode}`] : []),
  ]);
}

function measuredKnowledge(estimated: boolean): CostKnowledge {
  return estimated ? "estimated" : "exact";
}

/** One owner for the W4.3 fact used at settlement AND mid-flight cap checks. */
export function isSubscriptionValuation(authMode?: "local_session" | "api_key" | null): boolean {
  // Vendor-reported cost on a native subscription route is VALUATION,
  // regardless of whether the vendor labels it estimated or exact. It never
  // becomes incremental cash (live-found: Claude reported estimated=false
  // and the UI incorrectly showed ~$0.37 cash for subscription work).
  return authMode === "local_session";
}

export function unknownCostSettlement(source: string, cashUsd?: number): BudgetSettlement {
  return {
    knowledge: "unknown",
    source,
    provenance: [`orchestrator:${source}`],
    ...(cashUsd === undefined ? {} : { cashUsd }),
  };
}

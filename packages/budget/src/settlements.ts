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
  knowledge: { cash: CostKnowledge; valuation: CostKnowledge },
  provenance: string[],
  unknownUsd = 0,
): BudgetSettlement {
  const observed = cashUsd > 0 || valuationUsd > 0 || unknownUsd > 0;
  const normalizedValuation = Math.max(0, valuationUsd);
  const aggregateKnowledge = mergeKnowledge([
    knowledge.cash,
    ...(normalizedValuation > 0 || unknownUsd > 0 ? [knowledge.valuation] : []),
  ]);
  return {
    knowledge: unknownUsd > 0 ? "unknown" : aggregateKnowledge,
    cashKnowledge: unknownUsd > 0 ? "unknown" : knowledge.cash,
    ...(normalizedValuation > 0 || unknownUsd > 0
      ? {
          valuationKnowledge: unknownUsd > 0 ? ("unknown" as const) : knowledge.valuation,
        }
      : {}),
    source: observed ? "review-usage" : "review-usage-missing",
    provenance,
    cashUsd: Math.max(0, cashUsd),
    ...(normalizedValuation > 0 ? { valuationUsd: normalizedValuation } : {}),
  };
}

function mergeKnowledge(values: readonly CostKnowledge[]): CostKnowledge {
  if (values.includes("unknown")) return "unknown";
  return values.includes("estimated") ? "estimated" : "exact";
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
    cashKnowledge?: CostKnowledge;
    valuationKnowledge?: CostKnowledge;
  },
): BudgetSettlement {
  if (split) {
    const observed = split.cashUsd + split.valuationUsd + split.unknownUsd;
    const componentEvidence =
      split.cashKnowledge !== undefined || split.valuationKnowledge !== undefined;
    if (observed > 0 || componentEvidence) {
      const normalizedValuation = Math.max(0, split.valuationUsd);
      const cashKnowledge =
        split.unknownUsd > 0
          ? "unknown"
          : (split.cashKnowledge ?? measuredKnowledge(split.cashEstimated === true));
      const valuationKnowledge =
        split.unknownUsd > 0
          ? "unknown"
          : (split.valuationKnowledge ?? measuredKnowledge(split.valuationEstimated === true));
      return {
        knowledge: mergeKnowledge([
          cashKnowledge,
          ...(normalizedValuation > 0 || split.unknownUsd > 0 ? [valuationKnowledge] : []),
        ]),
        cashKnowledge,
        ...(normalizedValuation > 0 || split.unknownUsd > 0 ? { valuationKnowledge } : {}),
        source: observed > 0 ? "harness-usage-by-route" : "harness-route-usage-missing",
        provenance: [`attempt:${attemptId}`, `harness:${harnessId}`, "route:stream-evidence"],
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

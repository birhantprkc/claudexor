import { join } from "node:path";
import type { ArtifactStore } from "@claudexor/artifact-store";
import type { BudgetLedger } from "@claudexor/budget";
import { DecisionRecord, type RunOutcomeFacts } from "@claudexor/schema";

export interface SettledBudgetSnapshot {
  spendUsd: number | null;
  valuationUsd: number | null;
  estimated: boolean;
  valuationKnowledge: "exact" | "estimated" | "unknown";
}

interface BudgetSnapshotSource {
  spend?: () => number;
  valuation?: () => number;
  spendEstimated?: () => boolean;
  valuationKnowledge?: () => "exact" | "estimated" | "unknown";
}

export function settledBudgetSnapshot(source: BudgetSnapshotSource): SettledBudgetSnapshot {
  const read = (value: (() => number) | undefined): number | null => {
    try {
      const result = value?.();
      return typeof result === "number" && Number.isFinite(result) ? result : null;
    } catch {
      return null;
    }
  };
  let estimated = false;
  let valuationKnowledge: "exact" | "estimated" | "unknown" = "unknown";
  try {
    estimated = source.spendEstimated?.() === true;
  } catch {
    estimated = true;
  }
  try {
    valuationKnowledge = source.valuationKnowledge?.() ?? "unknown";
  } catch {
    valuationKnowledge = "unknown";
  }
  return {
    spendUsd: read(source.spend),
    valuationUsd: read(source.valuation),
    estimated,
    valuationKnowledge,
  };
}

/** Reconcile a Delegate family's post-drain cash/valuation truth without
 * stripping forward-compatible decision extensions. */
export function reconcileDecisionBudget(
  context: { store: ArtifactStore; paths: { arbitrationDir: string } },
  budget: SettledBudgetSnapshot,
  terminal?: { facts: RunOutcomeFacts; why: string },
): void {
  const path = join(context.paths.arbitrationDir, "decision.yaml");
  const current = context.store.readYaml<unknown>(path);
  if (!current || typeof current !== "object" || Array.isArray(current)) return;
  const record = current as Record<string, unknown>;
  const priorBudget =
    record["budget_summary"] && typeof record["budget_summary"] === "object"
      ? (record["budget_summary"] as Record<string, unknown>)
      : {};
  const reconciled = {
    ...record,
    ...(terminal
      ? {
          facts: terminal.facts,
          why_winner: terminal.why,
          apply_recommendation: "continue",
        }
      : {}),
    budget_summary: {
      ...priorBudget,
      spend_usd: budget.spendUsd,
      cash_usd: budget.spendUsd,
      valuation_usd: budget.valuationUsd,
      estimated: budget.estimated,
      valuation_knowledge: budget.valuationKnowledge,
    },
  };
  DecisionRecord.parse(reconciled);
  context.store.writeYaml(path, reconciled);
}

export function decisionBudgetSummary(ledger: BudgetLedger) {
  return {
    spend_usd: ledger.spend(),
    estimated: ledger.estimated(),
    cash_usd: ledger.spend(),
    valuation_usd: ledger.valuation(),
    valuation_knowledge: ledger.valuationKnowledge(),
  } as const;
}

export function arbitrationBudgetOptions(ledger: BudgetLedger) {
  return {
    spendUsd: ledger.spend(),
    estimatedSpend: ledger.estimated(),
    cashUsd: ledger.spend(),
    valuationUsd: ledger.valuation(),
    valuationKnowledge: ledger.valuationKnowledge(),
  } as const;
}

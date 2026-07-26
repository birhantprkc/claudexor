import type { BudgetLedger } from "@claudexor/budget";

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

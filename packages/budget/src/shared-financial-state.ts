import type { BudgetLease, PaidBudget } from "@claudexor/schema";
import type { CircuitThresholds } from "./ledger.js";

export interface TaskFinancialTotals {
  cashUsd: number;
  valuationUsd: number;
  estimated: boolean;
}

export interface SharedFinancialState {
  budget: PaidBudget;
  thresholds: CircuitThresholds;
  leases: Map<string, BudgetLease>;
  holds: Map<string, number>;
  unknownPaidInFlight: Set<string>;
  totalsByTask: Map<string, TaskFinancialTotals>;
  cashUsd: number;
  valuationUsd: number;
  estimated: boolean;
  overshot: boolean;
  unverifiable: boolean;
  rootOnCashSettled?: (cashSpendUsd: number, valuationUsd: number, estimated: boolean) => void;
}

export function newSharedFinancialState(
  budget: PaidBudget,
  thresholds: CircuitThresholds,
  rootOnCashSettled?: (cashSpendUsd: number, valuationUsd: number, estimated: boolean) => void,
): SharedFinancialState {
  return {
    budget,
    thresholds,
    leases: new Map(),
    holds: new Map(),
    unknownPaidInFlight: new Set(),
    totalsByTask: new Map(),
    cashUsd: 0,
    valuationUsd: 0,
    estimated: false,
    overshot: false,
    unverifiable: false,
    rootOnCashSettled,
  };
}

export function recordSharedSettlement(
  financial: SharedFinancialState,
  taskTotals: TaskFinancialTotals,
  cashUsd: number,
  valuationUsd: number,
  estimated: boolean,
): void {
  financial.cashUsd += cashUsd;
  financial.valuationUsd += valuationUsd;
  taskTotals.cashUsd += cashUsd;
  taskTotals.valuationUsd += valuationUsd;
  taskTotals.estimated ||= estimated;
  financial.estimated ||= estimated;
  financial.rootOnCashSettled?.(financial.cashUsd, financial.valuationUsd, financial.estimated);
}

export function taskFinancialTotals(
  financial: SharedFinancialState,
  taskId: string,
): TaskFinancialTotals {
  let totals = financial.totalsByTask.get(taskId);
  if (!totals) {
    totals = { cashUsd: 0, valuationUsd: 0, estimated: false };
    financial.totalsByTask.set(taskId, totals);
  }
  return totals;
}

export function settlementIsEstimated(
  financial: SharedFinancialState,
  taskScope: string | null,
): boolean {
  return taskScope === null
    ? financial.estimated
    : (financial.totalsByTask.get(taskScope)?.estimated ?? false);
}

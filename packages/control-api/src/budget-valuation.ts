import { eventPayload } from "./run-timeline.js";

/**
 * Pure subscription-VALUATION fold over a run's events (QA-023c/QA-017b),
 * independent of the cash truth. The owner-locked ledger settles native-
 * subscription work to cash $0 while accumulating its token valuation on
 * `budget.cash.valuation_usd` (last-wins, cumulative). An UNKNOWN valuation (no
 * usage ever reported — e.g. a Cursor draft) stays NULL and is never coerced to
 * a fake $0. The legacy fallback for runs predating budget.cash is the summed
 * `budget.observation` spend.
 */
export function budgetValuationFromEvents(events: Record<string, unknown>[]): {
  valuationUsd: number | null;
  valuationKnowledge: "exact" | "estimated" | "unknown";
} {
  let valuationUsd: number | null = null;
  let valuationKnowledge: "exact" | "estimated" | "unknown" = "unknown";
  let sawLedgerValuation = false;
  let observation = 0;
  let sawObservation = false;
  for (const ev of events) {
    const payload = eventPayload(ev);
    if (ev["type"] === "budget.cash") {
      const val = payload["valuation_usd"];
      if (typeof val === "number" && Number.isFinite(val)) {
        sawLedgerValuation = true;
        const knowledge = payload["valuation_knowledge"];
        if (knowledge === "exact" || knowledge === "estimated" || knowledge === "unknown") {
          valuationKnowledge = knowledge;
          valuationUsd = knowledge === "unknown" ? null : val;
        } else {
          // Legacy budget.cash had no valuation-specific knowledge. A positive
          // token valuation is safely estimated; zero alone cannot prove that
          // valuation evidence existed.
          valuationKnowledge = val > 0 ? "estimated" : "unknown";
          valuationUsd = val > 0 ? val : null;
        }
      }
      continue;
    }
    if (ev["type"] === "budget.observation" && payload["kind"] === "spend") {
      const usd = payload["usd"];
      if (typeof usd === "number" && Number.isFinite(usd)) {
        observation += usd;
        sawObservation = true;
      }
    }
  }
  if (!sawLedgerValuation && sawObservation) {
    valuationUsd = observation;
    valuationKnowledge = "estimated";
  }
  return { valuationUsd, valuationKnowledge };
}

export function normalizeLegacyBudgetComponents(
  budget: {
    estimated?: boolean;
    spend_usd?: number | null;
    valuation_usd?: number | null;
    valuation_knowledge?: "exact" | "estimated" | "unknown";
  } | null,
  events: Record<string, unknown>[],
  folded: ReturnType<typeof budgetValuationFromEvents>,
): typeof folded & { cashEstimated: boolean } {
  let cashEstimated = budget?.estimated ?? false;
  let { valuationUsd, valuationKnowledge } = folded;
  const knowledge = budget?.valuation_knowledge;
  const valuation = budget?.valuation_usd;
  const componentAwareEvent = events.some((event) => {
    if (event["type"] !== "budget.cash") return false;
    const value = eventPayload(event)["valuation_knowledge"];
    return value === "exact" || value === "estimated" || value === "unknown";
  });
  if (knowledge && typeof valuation === "number" && Number.isFinite(valuation)) {
    valuationKnowledge = knowledge;
    valuationUsd = knowledge === "unknown" ? null : valuation;
  } else if (valuationUsd === null && typeof valuation === "number" && valuation > 0) {
    valuationUsd = valuation;
    valuationKnowledge = "estimated";
  }
  if (
    knowledge === undefined &&
    !componentAwareEvent &&
    cashEstimated &&
    budget?.spend_usd === 0 &&
    typeof valuation === "number" &&
    valuation > 0
  ) {
    cashEstimated = false;
  }
  return { valuationUsd, valuationKnowledge, cashEstimated };
}

export function cashEstimatedFromLedgerEvent(payload: Record<string, unknown>): boolean {
  const estimated = payload["estimated"] === true;
  const legacyExactZero =
    payload["valuation_knowledge"] === undefined &&
    estimated &&
    payload["cash_spend_usd"] === 0 &&
    typeof payload["valuation_usd"] === "number" &&
    payload["valuation_usd"] > 0;
  return estimated && !legacyExactZero;
}

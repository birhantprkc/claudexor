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

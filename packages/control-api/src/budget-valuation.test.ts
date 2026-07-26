import { describe, expect, it } from "vitest";
import { budgetValuationFromEvents } from "./budget-valuation.js";

// QA-023c / QA-017b: the budget snapshot projected only CASH. A native-
// subscription run settles cash to exactly $0 while its token VALUATION lives on
// budget.cash.valuation_usd — a machine reader saw "$0" and could believe the
// work was free. Valuation must project beside cash: a KNOWN valuation appears,
// an UNKNOWN one stays null (never a fabricated $0).
describe("budgetValuationFromEvents (QA-023c)", () => {
  it("projects a known subscription valuation (last-wins) beside exact $0 cash", () => {
    const v = budgetValuationFromEvents([
      { type: "budget.observation", payload: { kind: "spend", usd: 0.022058, estimated: true } },
      { type: "budget.cash", payload: { cash_spend_usd: 0, valuation_usd: 0 } },
      { type: "budget.cash", payload: { cash_spend_usd: 0, valuation_usd: 0.022058 } },
    ]);
    expect(v.valuationUsd).toBeCloseTo(0.022058, 6);
    expect(v.valuationKnowledge).toBe("estimated");
  });

  it("preserves exact valuation knowledge independently from cash certainty", () => {
    const v = budgetValuationFromEvents([
      {
        type: "budget.cash",
        payload: {
          cash_spend_usd: 0,
          valuation_usd: 0.37,
          estimated: false,
          valuation_knowledge: "exact",
        },
      },
    ]);
    expect(v).toEqual({ valuationUsd: 0.37, valuationKnowledge: "exact" });
  });

  it("does not turn an explicit unknown ledger valuation into a displayable zero", () => {
    const v = budgetValuationFromEvents([
      { type: "budget.observation", payload: { kind: "spend", usd: 0.5 } },
      {
        type: "budget.cash",
        payload: {
          cash_spend_usd: 0.25,
          valuation_usd: 0,
          estimated: false,
          valuation_knowledge: "unknown",
        },
      },
    ]);
    expect(v).toEqual({ valuationUsd: null, valuationKnowledge: "unknown" });
  });

  it("leaves valuation UNKNOWN (null) when no usage was ever reported — never a fake $0", () => {
    const v = budgetValuationFromEvents([
      { type: "run.created", payload: {} },
      { type: "harness.completed", payload: { status: "success" } },
    ]);
    expect(v.valuationUsd).toBeNull();
    expect(v.valuationKnowledge).toBe("unknown");
  });

  it("falls back to summed budget.observation for runs predating budget.cash", () => {
    const v = budgetValuationFromEvents([
      { type: "budget.observation", payload: { kind: "spend", usd: 0.01 } },
      { type: "budget.observation", payload: { kind: "spend", usd: 0.02 } },
    ]);
    expect(v.valuationUsd).toBeCloseTo(0.03, 6);
    expect(v.valuationKnowledge).toBe("estimated");
  });
});

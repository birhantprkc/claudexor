import { describe, expect, it, vi } from "vitest";
import { attemptUsageCostSettlement, BudgetLedger } from "@claudexor/budget";
import { processAttemptUsage } from "./attemptUsage.js";
import {
  AttemptPostStreamError,
  attemptFailureCost,
  attemptFailureRecord,
  settleGrantedAttemptLease,
  withAttemptFailureCost,
} from "./attemptUsageCost.js";
import { createAttemptTelemetry, observeAttemptTelemetry } from "./attemptTelemetry.js";

const usageEvent = (estimated: boolean) =>
  ({
    type: "usage",
    session_id: "s",
    ts: new Date().toISOString(),
    usage: { input_tokens: 1, output_tokens: 1, cost_usd: 0.37, estimated },
  }) as const;

describe("processAttemptUsage", () => {
  it("carries route-specific settlement when post-stream persistence throws", () => {
    const settlement = attemptUsageCostSettlement(1, false, "a01", "claude", "local_session", {
      cashUsd: 0.25,
      valuationUsd: 0.75,
      unknownUsd: 0,
      cashKnowledge: "exact",
      valuationKnowledge: "estimated",
    });

    const error = (() => {
      try {
        withAttemptFailureCost(
          () => {
            throw new Error("artifact persistence failed");
          },
          { totalUsd: 1, estimated: true, settlement },
        );
      } catch (caught) {
        return caught;
      }
    })();

    expect(error).toBeInstanceOf(AttemptPostStreamError);
    expect((error as AttemptPostStreamError).attemptCost).toMatchObject({
      totalUsd: 1,
      estimated: true,
      settlement: {
        cashUsd: 0.25,
        valuationUsd: 0.75,
        cashKnowledge: "exact",
        valuationKnowledge: "estimated",
      },
    });

    for (const source of ["attempt-error", "continuation-error", "synthesis-error"]) {
      expect(attemptFailureCost(error, source).settlement).toBe(settlement);
    }
  });

  it("keeps ordinary pre-stream failure fallbacks unknown", () => {
    expect(attemptFailureCost(new Error("setup failed"), "attempt-error")).toMatchObject({
      totalUsd: 0,
      settlement: { knowledge: "unknown", source: "attempt-error" },
    });
    expect(attemptFailureCost({ costUsd: 0.4 }, "post-stream-error", 0)).toMatchObject({
      totalUsd: 0.4,
      estimated: true,
      settlement: { knowledge: "unknown", source: "post-stream-error", cashUsd: 0.4 },
    });
    expect(attemptFailureCost({ costUsd: 0 }, "post-stream-error")).toMatchObject({
      totalUsd: 0,
      estimated: false,
      settlement: { knowledge: "unknown", source: "post-stream-error", cashUsd: 0 },
    });
    expect(attemptFailureCost({ costUsd: Number.NaN }, "post-stream-error")).toMatchObject({
      totalUsd: 0,
      estimated: false,
      settlement: { knowledge: "unknown", source: "post-stream-error" },
    });
    expect(
      attemptFailureRecord(
        "a01",
        "claude",
        attemptFailureCost({ costUsd: 0.4 }, "post-stream-error"),
        "harness",
        "redacted failure",
      ),
    ).toEqual({
      attempt_id: "a01",
      harness_id: "claude",
      cost_usd: 0.4,
      cost_estimated: true,
      errored: true,
      phase: "harness",
      errors: ["redacted failure"],
    });
  });

  it("releases a granted lease on a pre-stream failure without inventing exact-zero cost", () => {
    const ledger = new BudgetLedger({ kind: "finite", maxUsd: 1 });
    const first = ledger.reserve({
      taskId: "task",
      attemptId: "p01",
      intent: "plan",
      harnessId: "claude",
    });
    expect(first.granted).toBe(true);
    settleGrantedAttemptLease({
      ledger,
      leaseId: first.lease?.lease_id ?? "",
      attemptId: "p01",
      harnessId: "claude",
      costUsd: 0,
      costEstimated: false,
      preStreamFailureSource: "planner-pre-stream",
    });
    const second = ledger.reserve({
      taskId: "task",
      attemptId: "p02",
      intent: "plan",
      harnessId: "claude",
    });
    expect(second.granted).toBe(true);
  });

  it("splits usage by each event route when a retry changes auth", () => {
    const telemetry = createAttemptTelemetry("auto", false);
    observeAttemptTelemetry(telemetry, {
      ...usageEvent(false),
      credential_route: "vendor_native",
      usage: { cost_usd: 0.75, estimated: true },
    });
    observeAttemptTelemetry(telemetry, {
      ...usageEvent(false),
      credential_route: "managed_api_key",
      usage: { cost_usd: 0.25 },
    });
    expect(telemetry.authMode).toBe("local_session");
    expect(telemetry.currentAuthMode).toBe("api_key");
    expect(telemetry.usageCost).toEqual({
      cashUsd: 0.25,
      valuationUsd: 0.75,
      unknownUsd: 0,
      cashEstimated: false,
      valuationEstimated: true,
    });
  });

  it("fails cash certainty closed when a native attempt switches to API without usage", () => {
    const telemetry = createAttemptTelemetry("auto", false);
    const ts = new Date().toISOString();
    observeAttemptTelemetry(telemetry, {
      type: "started",
      session_id: "s",
      ts,
      credential_route: "vendor_native",
    });
    observeAttemptTelemetry(telemetry, {
      type: "usage",
      session_id: "s",
      ts,
      credential_route: "vendor_native",
      usage: { cost_usd: 0.75, estimated: true },
    });
    observeAttemptTelemetry(telemetry, {
      type: "message",
      session_id: "s",
      ts,
      text: "switching route",
      payload: { auth_switched: true, to_auth_mode: "api_key" },
    });
    observeAttemptTelemetry(telemetry, { type: "completed", session_id: "s", ts });

    expect(telemetry.usageCost.cashKnowledge).toBe("unknown");
    expect(telemetry.usageCost.valuationKnowledge).toBe("estimated");
    const ledger = new BudgetLedger({ kind: "finite", maxUsd: 1 });
    const lease = ledger.reserve({
      taskId: "mixed-no-api-usage",
      intent: "implement",
      harnessId: "claude",
    }).lease!;
    ledger.settle(
      lease.lease_id,
      attemptUsageCostSettlement(
        0.75,
        true,
        "a01",
        "claude",
        telemetry.authMode,
        telemetry.usageCost,
      ),
    );
    expect(ledger.spend()).toBe(0);
    expect(ledger.valuation()).toBe(0.75);
    expect(ledger.terminal()).toBe("cost_unverifiable");
  });

  it("never trips the cash guard for exact or estimated native subscription valuation", () => {
    for (const estimated of [false, true]) {
      const guard = vi.fn(() => true);
      const cancel = vi.fn();
      const result = processAttemptUsage({
        event: usageEvent(estimated),
        telemetry: {
          usageCost: {
            cashUsd: 0,
            valuationUsd: 0.37,
            unknownUsd: 0,
            cashEstimated: false,
            valuationEstimated: estimated,
          },
        },
        harnessId: "claude",
        attemptId: "a01",
        cost: 0,
        costEstimated: false,
        budgetGuard: guard,
        cancel,
      });
      expect(result).toMatchObject({
        cost: 0.37,
        costEstimated: estimated,
        hardCapReached: false,
      });
      expect(guard).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
    }
  });

  it("trips the guard and cancels metered API usage", () => {
    const cancel = vi.fn();
    const emitted: string[] = [];
    const result = processAttemptUsage({
      event: usageEvent(false),
      telemetry: {
        usageCost: {
          cashUsd: 0.37,
          valuationUsd: 0,
          unknownUsd: 0,
          cashEstimated: false,
          valuationEstimated: false,
        },
      },
      harnessId: "claude",
      attemptId: "a01",
      cost: 0,
      costEstimated: false,
      budgetGuard: () => true,
      cancel,
      emit: (type) => emitted.push(type),
    });
    expect(result.hardCapReached).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
    expect(emitted).toEqual(["budget.observation", "budget.observation"]);
  });
});

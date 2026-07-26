import { describe, expect, it } from "vitest";
import { BudgetLedger, routeCostEvidence } from "@claudexor/budget";
import { MAX_DELEGATED_CHILDREN } from "@claudexor/schema";
import { DelegationBudgetAuthority } from "./delegationBudgetAuthority.js";

const metered = (estimatedUsd: number | null = null) =>
  routeCostEvidence({
    billing: "metered",
    knowledge: estimatedUsd === null ? "unknown" : "estimated",
    source: "test",
    provenance: ["test"],
    estimatedUsd,
  });

describe("DelegationBudgetAuthority", () => {
  it("attaches admitted children to one shared hard cap and local totals", () => {
    const authority = new DelegationBudgetAuthority();
    const root = new BudgetLedger({ kind: "finite", maxUsd: 1 });
    authority.registerParent("parent", root);
    authority.noteChildAccepted("parent", "job-a");
    authority.noteChildAccepted("parent", "job-b");
    const childA = authority.attachChild("parent", "job-a", "child-a", "task-a");
    const childB = authority.attachChild("parent", "job-b", "child-b", "task-b");
    const first = childA.reserve({
      taskId: "task-a",
      intent: "implement",
      harnessId: "a",
      cost: metered(0.6),
    });
    const second = childB.reserve({
      taskId: "task-b",
      intent: "implement",
      harnessId: "b",
      cost: metered(0.6),
    });
    expect(first.granted).toBe(true);
    expect(second).toMatchObject({ granted: false, denied: "estimate_headroom" });
    childA.settle(first.lease!.lease_id, {
      knowledge: "exact",
      source: "test",
      provenance: ["test"],
      cashUsd: 0.4,
      valuationUsd: 0.2,
    });
    expect(root.spend()).toBe(0.4);
    expect(childA.spend()).toBe(0.4);
    expect(childB.spend()).toBe(0);
  });

  it("fences closing/degraded parents and keeps the eight-child count monotonic", () => {
    const authority = new DelegationBudgetAuthority();
    expect(() => authority.assertCanAdmitChild("missing")).toThrow(
      /no live effective Delegate budget authority/,
    );
    authority.registerParent("parent", new BudgetLedger());
    for (let index = 0; index < MAX_DELEGATED_CHILDREN; index += 1) {
      authority.noteChildAccepted("parent", `job-${index}`);
    }
    expect(authority.acceptedChildCount("parent")).toBe(8);
    expect(() => authority.noteChildAccepted("parent", "job-9")).toThrow(/cap reached \(8\/8\)/);
    authority.cancelAcceptedChild("parent", "job-0");
    expect(() => authority.noteChildAccepted("parent", "job-9")).toThrow(/cap reached \(8\/8\)/);
    authority.beginParentClose("parent");
    expect(() => authority.assertCanAdmitChild("parent")).toThrow(
      /no live effective Delegate budget authority/,
    );
  });

  it("releases child holds and drains before parent cleanup", async () => {
    const authority = new DelegationBudgetAuthority();
    const root = new BudgetLedger({ kind: "finite", maxUsd: 1 });
    authority.registerParent("parent", root);
    authority.noteChildAccepted("parent", "job-child");
    const child = authority.attachChild("parent", "job-child", "child", "task");
    child.reserve({
      taskId: "task",
      intent: "implement",
      harnessId: "child",
      cost: metered(0.8),
    });
    authority.beginParentClose("parent");
    const drained = authority.waitForChildren("parent", 1_000);
    authority.releaseRun("child");
    await expect(drained).resolves.toBeUndefined();
    expect(root.remainingUsd()).toBe(1);
    authority.releaseRun("parent");
    expect(authority.hasParent("parent")).toBe(false);
  });

  it("drains an admitted child cancelled before ledger attachment", async () => {
    const authority = new DelegationBudgetAuthority();
    authority.registerParent("parent", new BudgetLedger());
    authority.noteChildAccepted("parent", "job-queued");
    authority.beginParentClose("parent");
    const drained = authority.waitForChildren("parent", 1_000);
    authority.cancelAcceptedChild("parent", "job-queued");
    await expect(drained).resolves.toBeUndefined();
  });

  it("signals every admission and waits for delayed child settlement before draining", async () => {
    let authority!: DelegationBudgetAuthority;
    const cancelled: string[] = [];
    authority = new DelegationBudgetAuthority({
      cancelAdmission: async (admissionId) => {
        cancelled.push(admissionId);
        await new Promise((resolve) => setTimeout(resolve, 10));
        authority.releaseRun("child");
      },
    });
    authority.registerParent("parent", new BudgetLedger());
    authority.noteChildAccepted("parent", "job-child");
    authority.attachChild("parent", "job-child", "child", "task-child");
    authority.beginParentClose("parent");
    await expect(authority.waitForChildren("parent", 1_000)).resolves.toBeUndefined();
    expect(cancelled).toEqual(["job-child"]);
  });

  it("attempts every child cancellation even when one daemon cancellation throws synchronously", async () => {
    let authority!: DelegationBudgetAuthority;
    const cancelled: string[] = [];
    authority = new DelegationBudgetAuthority({
      cancelAdmission: (admissionId) => {
        cancelled.push(admissionId);
        if (admissionId === "job-a") throw new Error("lost job");
        authority.cancelAcceptedChild("parent", admissionId);
      },
    });
    authority.registerParent("parent", new BudgetLedger());
    authority.noteChildAccepted("parent", "job-a");
    authority.noteChildAccepted("parent", "job-b");
    authority.beginParentClose("parent");
    const draining = authority.waitForChildren("parent", 5);
    await expect(draining).rejects.toMatchObject({ code: "delegation_child_drain_timeout" });
    expect(cancelled).toEqual(["job-a", "job-b"]);
  });

  it("financially fences a stuck child before a bounded drain timeout can terminalize its parent", async () => {
    const rootCash: number[] = [];
    const root = new BudgetLedger({ kind: "finite", maxUsd: 1 }, undefined, {
      onCashSettled: (cash) => rootCash.push(cash),
    });
    const authority = new DelegationBudgetAuthority({ cancelAdmission: () => {} });
    authority.registerParent("parent", root);
    authority.noteChildAccepted("parent", "job-child");
    const child = authority.attachChild("parent", "job-child", "child", "task-child");
    const lease = child.reserve({
      taskId: "task-child",
      intent: "implement",
      harnessId: "child",
      cost: metered(0.2),
    }).lease!;
    authority.beginParentClose("parent");
    await expect(authority.waitForChildren("parent", 5)).rejects.toMatchObject({
      code: "delegation_child_drain_timeout",
    });
    expect(() =>
      child.settle(lease.lease_id, {
        knowledge: "exact",
        source: "late-test",
        provenance: ["late-test"],
        cashUsd: 0.1,
      }),
    ).toThrow(/scope is released/);
    expect(rootCash).toEqual([]);
    expect(root.spend()).toBe(0);
  });
});

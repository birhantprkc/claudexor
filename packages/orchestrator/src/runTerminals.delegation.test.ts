import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "@claudexor/artifact-store";
import { BudgetLedger, routeCostEvidence } from "@claudexor/budget";
import { EventLog } from "@claudexor/event-log";
import { makeOutcomeFacts } from "@claudexor/schema";
import { DelegationBudgetAuthority } from "./delegationBudgetAuthority.js";
import { guardAnnouncedRun } from "./runTerminals.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(runId: string) {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "cx-term-")));
  dirs.push(repo);
  const store = new ArtifactStore(repo);
  const paths = store.createRun(runId);
  const log = new EventLog(paths.eventsPath, runId, "task-parent");
  return { store, paths, log };
}

describe("Delegate terminal drain ordering", () => {
  it("settles delayed child cash before the deferred parent terminal and emits no cash afterward", async () => {
    const { store, paths, log } = fixture("run-parent");
    let authority!: DelegationBudgetAuthority;
    const root = new BudgetLedger({ kind: "finite", maxUsd: 1 }, undefined, {
      onCashSettled: (cash, valuation) =>
        log.emit("budget.cash", { cash_spend_usd: cash, valuation_usd: valuation }),
    });
    authority = new DelegationBudgetAuthority({
      cancelAdmission: () => {
        setTimeout(() => {
          child.settle(lease.lease_id, {
            knowledge: "exact",
            source: "child-terminal",
            provenance: ["test"],
            cashUsd: 0.2,
          });
          authority.releaseRun("run-child");
        }, 5);
      },
    });
    authority.registerParent("run-parent", root);
    authority.noteChildAccepted("run-parent", "job-child");
    const child = authority.attachChild("run-parent", "job-child", "run-child", "task-child");
    const lease = child.reserve({
      taskId: "task-child",
      intent: "implement",
      harnessId: "child",
      cost: routeCostEvidence({
        billing: "metered",
        knowledge: "estimated",
        source: "test",
        provenance: ["test"],
        estimatedUsd: 0.3,
      }),
    }).lease!;

    const result = await guardAnnouncedRun(
      undefined,
      async (announce) => {
        log.emit("run.created", { mode: "agent", prompt: "x" });
        announce({
          log,
          store,
          paths,
          runId: "run-parent",
          taskId: "task-parent",
          mode: "agent",
          phase: "race",
          spend: () => root.spend(),
          valuation: () => root.valuation(),
          spendEstimated: () => root.estimated(),
          budgetTerminal: () => root.terminal(),
          recheckBudgetAfterBarrier: () => true,
        });
        store.writeYaml(join(paths.arbitrationDir, "decision.yaml"), {
          winner: "a01",
          facts: makeOutcomeFacts("succeeded"),
          why_winner: "strategy completed before child drain",
          budget_summary: {
            spend_usd: 0,
            cash_usd: 0,
            valuation_usd: 0,
            estimated: false,
          },
        });
        log.deferTerminal();
        log.emit("output.ready", { path: "final/summary.md", kind: "summary" });
        log.emit("run.completed", { lifecycle: "succeeded" });
        return {
          runId: "run-parent",
          taskId: "task-parent",
          mode: "agent",
          lifecycle: "succeeded",
          facts: makeOutcomeFacts("succeeded"),
          winner: "a01",
          runDir: paths.root,
          summary: "done",
          candidates: [{ attemptId: "a01", harnessId: "claude", status: "success" }],
          decisionPath: join(paths.arbitrationDir, "decision.yaml"),
          reviewVerified: true,
        };
      },
      async () => {
        authority.beginParentClose("run-parent");
        await authority.waitForChildren("run-parent", 1_000);
      },
      () => authority.releaseRun("run-parent"),
    );

    const events = readFileSync(paths.eventsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string });
    expect(events.map((event) => event.type)).toEqual([
      "run.created",
      "output.ready",
      "budget.cash",
      "run.completed",
    ]);
    expect(result.spendUsd).toBeCloseTo(0.2);
    expect(
      store.readYaml<{ budget_summary: { spend_usd: number; cash_usd: number } }>(
        join(paths.arbitrationDir, "decision.yaml"),
      ),
    ).toMatchObject({ budget_summary: { spend_usd: 0.2, cash_usd: 0.2 } });
  });

  it("replaces deferred success when delayed child settlement overshoots the family cap", async () => {
    const { store, paths, log } = fixture("run-overshoot");
    let authority!: DelegationBudgetAuthority;
    const root = new BudgetLedger({ kind: "finite", maxUsd: 0.1 }, undefined, {
      onCashSettled: (cash, valuation, estimated) =>
        log.emit("budget.cash", {
          cash_spend_usd: cash,
          valuation_usd: valuation,
          estimated,
        }),
    });
    authority = new DelegationBudgetAuthority({
      cancelAdmission: () => {
        setTimeout(() => {
          child.settle(lease.lease_id, {
            knowledge: "exact",
            source: "child-terminal",
            provenance: ["test"],
            cashUsd: 0.2,
          });
          authority.releaseRun("run-child-overshoot");
        }, 5);
      },
    });
    authority.registerParent("run-overshoot", root);
    authority.noteChildAccepted("run-overshoot", "job-child");
    const child = authority.attachChild(
      "run-overshoot",
      "job-child",
      "run-child-overshoot",
      "task-child",
    );
    const lease = child.reserve({
      taskId: "task-child",
      intent: "implement",
      harnessId: "child",
      cost: routeCostEvidence({
        billing: "metered",
        knowledge: "estimated",
        source: "test",
        provenance: ["test"],
        estimatedUsd: 0.05,
      }),
    }).lease!;

    const result = await guardAnnouncedRun(
      undefined,
      async (announce) => {
        log.emit("run.created", { mode: "agent", prompt: "x" });
        announce({
          log,
          store,
          paths,
          runId: "run-overshoot",
          taskId: "task-parent",
          mode: "agent",
          phase: "race",
          spend: () => root.spend(),
          valuation: () => root.valuation(),
          spendEstimated: () => root.estimated(),
          budgetTerminal: () => root.terminal(),
          recheckBudgetAfterBarrier: () => true,
        });
        store.writeYaml(join(paths.arbitrationDir, "decision.yaml"), {
          winner: "a01",
          facts: makeOutcomeFacts("succeeded"),
          why_winner: "strategy completed before child drain",
          budget_summary: {
            spend_usd: 0,
            cash_usd: 0,
            valuation_usd: 0,
            estimated: false,
          },
        });
        log.deferTerminal();
        log.emit("output.ready", { path: "final/summary.md", kind: "summary" });
        log.emit("run.completed", { lifecycle: "succeeded" });
        return {
          runId: "run-overshoot",
          taskId: "task-parent",
          mode: "agent",
          lifecycle: "succeeded",
          facts: makeOutcomeFacts("succeeded"),
          winner: "a01",
          runDir: paths.root,
          summary: "done",
          candidates: [{ attemptId: "a01", harnessId: "claude", status: "success" }],
          decisionPath: join(paths.arbitrationDir, "decision.yaml"),
          reviewVerified: true,
        };
      },
      async () => {
        authority.beginParentClose("run-overshoot");
        await authority.waitForChildren("run-overshoot", 1_000);
      },
      () => authority.releaseRun("run-overshoot"),
    );

    expect(result.lifecycle).toBe("failed");
    expect(result.facts.reason).toBe("budget_overshoot");
    expect(result.spendUsd).toBeCloseTo(0.2);
    expect(result.winner).toBe("a01");
    expect(result.candidates).toEqual([
      { attemptId: "a01", harnessId: "claude", status: "success" },
    ]);
    expect(result.reviewVerified).toBe(true);
    expect(readFileSync(join(paths.finalDir, "failure.yaml"), "utf8")).toContain(
      "code: budget_overshoot",
    );
    expect(
      store.readYaml<{
        facts: { lifecycle: string; reason: string };
        budget_summary: { spend_usd: number };
      }>(join(paths.arbitrationDir, "decision.yaml")),
    ).toMatchObject({
      facts: { lifecycle: "failed", reason: "budget_overshoot" },
      budget_summary: { spend_usd: 0.2 },
    });
    const types = readFileSync(paths.eventsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { type: string }).type);
    expect(types).toEqual(["run.created", "output.ready", "budget.cash", "run.failed"]);
  });

  it("replaces deferred success with one typed failure when child drain times out", async () => {
    const { store, paths, log } = fixture("run-timeout");
    const authority = new DelegationBudgetAuthority({ cancelAdmission: () => {} });
    authority.registerParent("run-timeout", new BudgetLedger());
    authority.noteChildAccepted("run-timeout", "job-stuck");

    const result = await guardAnnouncedRun(
      undefined,
      async (announce) => {
        log.emit("run.created", { mode: "agent", prompt: "x" });
        announce({
          log,
          store,
          paths,
          runId: "run-timeout",
          taskId: "task-parent",
          mode: "agent",
          phase: "delegation_drain",
        });
        store.writeYaml(join(paths.arbitrationDir, "decision.yaml"), {
          winner: "a01",
          facts: makeOutcomeFacts("succeeded"),
          why_winner: "prepared before drain",
          budget_summary: {
            spend_usd: 0,
            cash_usd: 0,
            valuation_usd: 0,
            estimated: false,
          },
        });
        log.deferTerminal();
        log.emit("run.completed", { lifecycle: "succeeded" });
        return {
          runId: "run-timeout",
          taskId: "task-parent",
          mode: "agent",
          lifecycle: "succeeded",
          facts: makeOutcomeFacts("succeeded"),
          winner: null,
          runDir: paths.root,
          summary: "done",
          candidates: [],
        };
      },
      async () => {
        authority.beginParentClose("run-timeout");
        await authority.waitForChildren("run-timeout", 5);
      },
      () => authority.releaseRun("run-timeout"),
    );

    expect(result.lifecycle).toBe("failed");
    const types = readFileSync(paths.eventsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { type: string }).type);
    expect(types).toEqual(["run.created", "output.ready", "run.failed"]);
    expect(readFileSync(join(paths.finalDir, "failure.yaml"), "utf8")).toContain(
      "code: delegation_child_drain_timeout",
    );
    expect(
      store.readYaml<{ facts: { lifecycle: string; reason: string } }>(
        join(paths.arbitrationDir, "decision.yaml"),
      ),
    ).toMatchObject({ facts: { lifecycle: "failed", reason: "harness_failed" } });
  });

  it("leaves ordinary terminal ordering unchanged when no Delegate barrier is armed", async () => {
    const { store, paths, log } = fixture("run-ordinary");
    await guardAnnouncedRun(undefined, async (announce) => {
      log.emit("run.created", { mode: "agent", prompt: "x" });
      announce({
        log,
        store,
        paths,
        runId: "run-ordinary",
        taskId: "task-parent",
        mode: "agent",
        phase: "race",
      });
      log.emit("output.ready", { path: "final/summary.md", kind: "summary" });
      log.emit("run.completed", { lifecycle: "succeeded" });
      return {
        runId: "run-ordinary",
        taskId: "task-parent",
        mode: "agent",
        lifecycle: "succeeded",
        facts: makeOutcomeFacts("succeeded"),
        winner: null,
        runDir: paths.root,
        summary: "done",
        candidates: [],
      };
    });
    const types = readFileSync(paths.eventsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { type: string }).type);
    expect(types).toEqual(["run.created", "output.ready", "run.completed"]);
  });

  it("does not re-terminalize an ordinary non-deferred budget failure", async () => {
    const { store, paths, log } = fixture("run-ordinary-budget");
    const result = await guardAnnouncedRun(undefined, async (announce) => {
      log.emit("run.created", { mode: "agent", prompt: "x" });
      announce({
        log,
        store,
        paths,
        runId: "run-ordinary-budget",
        taskId: "task-parent",
        mode: "agent",
        phase: "budget",
        spend: () => 0.2,
        budgetTerminal: () => "budget_overshoot",
      });
      const facts = makeOutcomeFacts("failed", { reason: "budget_overshoot" });
      log.emit("run.failed", { lifecycle: "failed", facts, reason: facts.reason });
      return {
        runId: "run-ordinary-budget",
        taskId: "task-parent",
        mode: "agent",
        lifecycle: "failed",
        facts,
        winner: null,
        runDir: paths.root,
        summary: "already terminal",
        candidates: [],
        spendUsd: 0.2,
      };
    });
    expect(result.lifecycle).toBe("failed");
    const types = readFileSync(paths.eventsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { type: string }).type);
    expect(types).toEqual(["run.created", "run.failed"]);
  });

  it("does not mask a deferred Delegate failure with a late budget terminal", async () => {
    const { store, paths, log } = fixture("run-delegate-failed");
    const result = await guardAnnouncedRun(
      undefined,
      async (announce) => {
        log.emit("run.created", { mode: "agent", prompt: "x" });
        announce({
          log,
          store,
          paths,
          runId: "run-delegate-failed",
          taskId: "task-parent",
          mode: "agent",
          phase: "harness",
          spend: () => 0.2,
          budgetTerminal: () => "budget_overshoot",
          recheckBudgetAfterBarrier: () => true,
        });
        log.deferTerminal();
        const facts = makeOutcomeFacts("failed", { reason: "harness_failed" });
        log.emit("run.failed", { lifecycle: "failed", facts, reason: facts.reason });
        return {
          runId: "run-delegate-failed",
          taskId: "task-parent",
          mode: "agent",
          lifecycle: "failed",
          facts,
          winner: "a01",
          runDir: paths.root,
          summary: "harness failed first",
          candidates: [{ attemptId: "a01", harnessId: "claude", status: "failed" }],
        };
      },
      async () => {},
    );
    expect(result.facts.reason).toBe("harness_failed");
    expect(result.winner).toBe("a01");
    const types = readFileSync(paths.eventsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { type: string }).type);
    expect(types).toEqual(["run.created", "run.failed"]);
  });
});

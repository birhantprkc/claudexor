import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { attemptUsageCostSettlement, routeCostEvidence } from "@claudexor/budget";
import { EventLog } from "@claudexor/event-log";
import type { TaskContract } from "@claudexor/schema";
import { DelegationBudgetAuthority } from "./delegationBudgetAuthority.js";
import type { RunInput } from "./orchestrator.js";
import { createRootLedger } from "./root-ledger.js";

const roots: string[] = [];
const logs: EventLog[] = [];

afterEach(() => {
  for (const log of logs.splice(0)) log.dispose();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function log(runId: string, taskId: string): { eventLog: EventLog; path: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cx-root-ledger-")));
  roots.push(root);
  const path = join(root, "events.jsonl");
  const eventLog = new EventLog(path, runId, taskId);
  logs.push(eventLog);
  return { eventLog, path };
}

function contract(taskId: string): TaskContract {
  return {
    task_id: taskId,
    budget: { paid_budget: { kind: "unlimited" } },
  } as TaskContract;
}

function events(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("root ledger cash and valuation disclosure", () => {
  it("keeps estimated subscription valuation separate from exact family cash across a child", () => {
    const parentLog = log("run-parent", "task-parent");
    const childLog = log("run-child", "task-child");
    const authority = new DelegationBudgetAuthority({ cancelAdmission: () => {} });
    const parent = createRootLedger({
      input: { runId: "run-parent" } as RunInput,
      contract: contract("task-parent"),
      log: parentLog.eventLog,
      authority,
      quotaSnapshots: [],
    });
    authority.registerParent("run-parent", parent);
    authority.noteChildAccepted("run-parent", "job-child");
    const child = createRootLedger({
      input: {
        runId: "run-child",
        delegatedFromRunId: "run-parent",
        delegationAdmissionId: "job-child",
      } as RunInput,
      contract: contract("task-child"),
      log: childLog.eventLog,
      authority,
      quotaSnapshots: [],
    });

    const subscription = parent.reserve({
      taskId: "task-parent",
      attemptId: "native-parent",
      intent: "implement",
      harnessId: "claude",
      cost: routeCostEvidence({
        billing: "subscription_entitlement",
        knowledge: "exact",
        source: "native-route",
        provenance: ["route:local_session"],
        estimatedUsd: 0,
      }),
    }).lease!;
    parent.settle(
      subscription.lease_id,
      attemptUsageCostSettlement(0.6, true, "native-parent", "claude", "local_session"),
    );

    const api = child.reserve({
      taskId: "task-child",
      attemptId: "api-child",
      intent: "implement",
      harnessId: "codex",
      cost: routeCostEvidence({
        billing: "metered",
        knowledge: "exact",
        source: "api-route",
        provenance: ["route:api_key"],
        estimatedUsd: 0.25,
      }),
    }).lease!;
    child.settle(
      api.lease_id,
      attemptUsageCostSettlement(0.25, false, "api-child", "codex", "api_key"),
    );

    expect(parent.spend()).toBe(0.25);
    expect(parent.valuation()).toBe(0.6);
    expect(parent.estimated()).toBe(false);
    expect(parent.valuationKnowledge()).toBe("estimated");
    expect(child.spend()).toBe(0.25);
    expect(child.valuation()).toBe(0);
    expect(child.estimated()).toBe(false);
    expect(child.valuationKnowledge()).toBe("unknown");

    expect(events(parentLog.path).map((event) => event["payload"])).toEqual([
      {
        cash_spend_usd: 0,
        valuation_usd: 0.6,
        estimated: false,
        valuation_knowledge: "estimated",
      },
      {
        cash_spend_usd: 0.25,
        valuation_usd: 0.6,
        estimated: false,
        valuation_knowledge: "estimated",
      },
    ]);
    expect(events(childLog.path).map((event) => event["payload"])).toEqual([
      {
        cash_spend_usd: 0.25,
        valuation_usd: 0,
        estimated: false,
        valuation_knowledge: "unknown",
      },
    ]);
  });
});

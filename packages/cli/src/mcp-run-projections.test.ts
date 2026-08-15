import { describe, expect, it } from "vitest";
import {
  makeOutcomeFacts,
  McpRunHandleResult,
  SCHEMA_VERSION,
  validateRunFactsInvariants,
} from "@claudexor/schema";
import {
  isRecoverableRunDetailIntegrityProblem,
  projectDegradedRecoveryRunDetail,
  projectImmediateRunDetail,
  projectRecoveryRunDetail,
} from "./mcp-run-projections.js";
import { CliError } from "./cli-error.js";
import {
  describeRunDetailProblem,
  presentRunPrimaryOutput,
  projectRunPrimaryOutput,
} from "./run-detail-projections.js";

const failure = {
  phase: "execute",
  category: "auth",
  code: null,
  harnessId: "claude",
  attemptId: "a01",
  safeMessage: "Authentication expired",
  rawDetailRef: null,
  resetsAt: null,
  logRefs: [],
  eventRefs: [],
  runDir: "/tmp/run",
  nextActions: ["Log in again"],
};

const terminalReceipt = validateRunFactsInvariants({
  schema_version: SCHEMA_VERSION,
  run_id: "run-1",
  task_id: "task-1",
  mode: "plan",
  outcome: makeOutcomeFacts("succeeded"),
  deliverable: {
    present: true,
    kind: "plan",
    path: "final/plan.md",
    producer_attempt_id: "p01",
  },
  participants: {
    planners: 1,
    attempts: [
      {
        attempt_id: "p01",
        harness_id: "codex",
        role: "planner",
        deliverable_present: true,
        status: "success",
      },
    ],
  },
  gates: {
    configured: false,
    required: 0,
    total: 0,
    executed: false,
    state: "not_configured",
    receipt_attempt_id: null,
  },
  review: { state: "not_run", blocker_ids: [], blockers: 0 },
  apply: { eligibility: null, operator_decision_present: false },
  required_actions: [],
  generated_at: "2026-08-14T00:00:00.000Z",
});

describe("MCP run detail projections", () => {
  it("redacts secrets from degraded post-terminal problem messages", () => {
    const token = `ghp_${"a".repeat(36)}`;
    const problem = describeRunDetailProblem(
      Object.assign(new Error(`provider failed with ${token}`), {
        code: "provider_failed",
        retryable: true,
      }),
    );
    expect(problem).toEqual({
      code: "provider_failed",
      message: "provider failed with [redacted]",
      retryable: true,
    });
    expect(problem.message).not.toContain(token);
  });

  it("schema-validates primary output and discloses bounded previews", () => {
    const primary = projectRunPrimaryOutput({
      primaryOutput: {
        kind: "report",
        path: "final/report.md",
        text: "Research result",
        bytes: 300_000,
        truncated: true,
      },
    });
    expect(presentRunPrimaryOutput(primary)).toBe(
      "Research result\n\n[Inline preview bounded; full artifact: final/report.md]",
    );
    expect(projectRunPrimaryOutput({ primaryOutput: { kind: "invented", text: 42 } })).toBeNull();
  });

  it("preserves the typed RunFailure on immediate results", () => {
    expect(projectImmediateRunDetail({ failure }).failure).toEqual(failure);
  });

  it("projects one schema-validated outcome receipt on immediate and recovery results", () => {
    const outcomeFacts = makeOutcomeFacts("cancelled", { reason: "wall_clock_exceeded" });
    const detail = { summary: { runId: "run-1", state: "cancelled", outcomeFacts } };
    expect(projectImmediateRunDetail(detail).outcomeFacts).toEqual(outcomeFacts);
    expect(projectRecoveryRunDetail("__run_result", "run-1", detail)["outcomeFacts"]).toEqual(
      outcomeFacts,
    );
    const malformed = {
      summary: {
        runId: "run-1",
        state: "cancelled",
        outcomeFacts: { lifecycle: "cancelled", reason: "invented" },
      },
    };
    expect(projectImmediateRunDetail(malformed).outcomeFacts).toBeNull();
    expect(projectRecoveryRunDetail("__run_result", "run-1", malformed)["outcomeFacts"]).toBeNull();
  });

  it("preserves the typed RunFailure on recovery inspect results", () => {
    const projected = projectRecoveryRunDetail("__run_result", "run-1", {
      summary: { runId: "run-1", state: "failed" },
      failure,
    });
    expect(projected["failure"]).toEqual(failure);
  });

  it("projects the exact canonical receipt and binds terminal run/lifecycle identity", () => {
    const detail = {
      summary: { runId: "run-1", taskId: "task-1", state: "succeeded" },
      runFacts: terminalReceipt,
    };
    expect(
      projectImmediateRunDetail(detail, { runId: "run-1", lifecycle: "succeeded" }).runFacts,
    ).toEqual(terminalReceipt);
    expect(projectRecoveryRunDetail("__run_result", "run-1", detail)["runFacts"]).toEqual(
      terminalReceipt,
    );
    expect(() =>
      projectRecoveryRunDetail("__run_result", "run-1", {
        ...detail,
        summary: { ...detail.summary, state: "failed" },
      }),
    ).toThrow(/canonical RunFacts receipt is invalid/);
    expect(() => projectRecoveryRunDetail("__run_result", "run-other", detail)).toThrow(
      /identity does not match/,
    );
  });

  it("validates lineage before active-state receipt short-circuit, then returns honest null", () => {
    const raced = {
      summary: { runId: "run-1", state: "running", delegatedFromRunId: "run-parent" },
      runFacts: terminalReceipt,
    };
    expect(
      projectRecoveryRunDetail("__run_status", "run-1", raced, "run-parent")["runFacts"],
    ).toBeNull();
    expect(() =>
      projectRecoveryRunDetail("__run_status", "run-1", raced, "run-other-parent"),
    ).toThrow(/not a child/);
  });

  it("still validates a present receipt for an unknown legacy lifecycle", () => {
    expect(
      projectRecoveryRunDetail("__run_status", "run-1", {
        summary: { runId: "run-1", state: "legacy-settled" },
        runFacts: terminalReceipt,
      })["runFacts"],
    ).toEqual(terminalReceipt);
  });

  it("builds a secret-redacted minimal handle only for the two integrity codes", () => {
    const token = `ghp_${"b".repeat(36)}`;
    const error = new CliError("operational", `invalid receipt ${token}`, {
      code: "run_facts_invalid",
      retryable: false,
    });
    expect(isRecoverableRunDetailIntegrityProblem(error)).toBe(true);
    const degraded = projectDegradedRecoveryRunDetail("run-1", error);
    expect(McpRunHandleResult.parse(degraded)).toEqual(degraded);
    expect(degraded).toMatchObject({
      runId: "run-1",
      status: null,
      runFacts: null,
      outcomeFacts: null,
      applyEligibility: null,
      detailProblem: { code: "run_facts_invalid", retryable: false },
    });
    expect(JSON.stringify(degraded)).not.toContain(token);
    expect(
      isRecoverableRunDetailIntegrityProblem(
        Object.assign(new Error("untyped"), {
          code: "run_facts_invalid",
          mcpRecoveryTypedControlProblem: false,
        }),
      ),
    ).toBe(false);
    expect(
      isRecoverableRunDetailIntegrityProblem(
        Object.assign(new Error("auth"), { code: "unauthorized", retryable: false }),
      ),
    ).toBe(false);
  });
});

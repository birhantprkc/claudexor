import { describe, expect, it } from "vitest";
import { makeOutcomeFacts } from "@claudexor/schema";
import { projectImmediateRunDetail, projectRecoveryRunDetail } from "./mcp-run-projections.js";
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
    const detail = { summary: { state: "cancelled", outcomeFacts } };
    expect(projectImmediateRunDetail(detail).outcomeFacts).toEqual(outcomeFacts);
    expect(projectRecoveryRunDetail("__run_result", "run-1", detail)["outcomeFacts"]).toEqual(
      outcomeFacts,
    );
    const malformed = {
      summary: { state: "cancelled", outcomeFacts: { lifecycle: "cancelled", reason: "invented" } },
    };
    expect(projectImmediateRunDetail(malformed).outcomeFacts).toBeNull();
    expect(projectRecoveryRunDetail("__run_result", "run-1", malformed)["outcomeFacts"]).toBeNull();
  });

  it("preserves the typed RunFailure on recovery inspect results", () => {
    const projected = projectRecoveryRunDetail("__run_result", "run-1", {
      summary: { state: "failed" },
      failure,
    });
    expect(projected["failure"]).toEqual(failure);
  });
});

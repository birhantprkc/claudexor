import { describe, expect, it } from "vitest";
import {
  attemptTelemetryRecord,
  createAttemptTelemetry,
  observeAttemptTelemetry,
  setAttemptOutcome,
} from "./attemptTelemetry.js";
import {
  delegationBeltToolFailure,
  delegationBeltUnavailable,
  isDelegationBeltTool,
} from "./delegationToolEvidence.js";
import type { HarnessEvent } from "@claudexor/schema";
import { aggregateRunDelegation } from "./runTelemetryWriter.js";

const ts = "2026-07-23T00:00:00.000Z";

// A claude `started` frame carrying the injected MCP server statuses (QA-024).
// This is exactly the shape parse.ts surfaces from the vendor init frame:
// `started.payload.mcp_servers = [{ name, status }]`.
function startedWithBelt(status: string): HarnessEvent {
  return {
    type: "started",
    session_id: "s",
    ts,
    payload: { mcp_servers: [{ name: "claudexor", status }] },
  } as unknown as HarnessEvent;
}

function beltToolCall(): HarnessEvent {
  return {
    type: "tool_call",
    session_id: "s",
    ts,
    tool: { name: "mcp__claudexor__claudexor_ask", kind: "mcp" },
  } as unknown as HarnessEvent;
}

function beltToolResult(
  shape: "claude" | "codex",
  status: "ok" | "error" | "cancelled" | "denied" | undefined,
): HarnessEvent {
  return {
    type: "tool_result",
    session_id: "s",
    ts,
    tool:
      shape === "claude"
        ? { name: "mcp__claudexor__claudexor_ask", kind: "mcp", status }
        : {
            name: "claudexor_ask",
            kind: "mcp",
            target: "claudexor:claudexor_ask",
            status,
          },
  } as unknown as HarnessEvent;
}

const outcomeOpts = {
  deliverablePresent: true,
  gatesPassed: null,
  harnessErrored: false,
  webRequiredUnsatisfied: false,
};

describe("delegation belt readiness telemetry (QA-024)", () => {
  it("marks the belt requested when a belt server name is injected", () => {
    const t = createAttemptTelemetry("auto", false, "auto", [], null, "claudexor");
    expect(t.delegationBelt.requested).toBe(true);
    expect(t.delegationBelt.serverName).toBe("claudexor");
    // No belt requested when no server injected.
    const none = createAttemptTelemetry("auto", false);
    expect(none.delegationBelt.requested).toBe(false);
  });

  it("recognizes exact Claude and Codex belt tool identities without prefix collisions", () => {
    expect(
      isDelegationBeltTool({ name: "mcp__claudexor__claudexor_ask", kind: "mcp" }, "claudexor"),
    ).toBe(true);
    expect(
      isDelegationBeltTool(
        { name: "claudexor_ask", kind: "mcp", target: "claudexor:claudexor_ask" },
        "claudexor",
      ),
    ).toBe(true);
    expect(
      isDelegationBeltTool(
        { name: "mcp__claudexor_evil__claudexor_ask", kind: "mcp" },
        "claudexor",
      ),
    ).toBe(false);
    expect(
      isDelegationBeltTool(
        { name: "claudexor_ask", kind: "mcp", target: "claudexor_evil:claudexor_ask" },
        "claudexor",
      ),
    ).toBe(false);
    expect(
      isDelegationBeltTool(
        { name: "claudexor_ask", kind: "command", target: "claudexor:claudexor_ask" },
        "claudexor",
      ),
    ).toBe(false);
  });

  it("a requested belt reported `failed` with zero tool evidence terminalizes FAILED, never silent success", () => {
    const t = createAttemptTelemetry("auto", false, "auto", [], null, "claudexor");
    observeAttemptTelemetry(t, startedWithBelt("failed"));
    expect(t.delegationBelt.failed).toBe(true);
    expect(t.delegationBelt.toolEvidence).toBe(false);
    expect(delegationBeltUnavailable(t)).toBe(true);

    // Deliverable present + gates fine would normally be clean success; the
    // failed belt must elevate it to a typed failure.
    setAttemptOutcome(t, outcomeOpts);
    expect(t.outcome?.status).toBe("failed");

    const rec = attemptTelemetryRecord("a1", "claude", t);
    expect(rec.outcome.delegation_belt_unavailable).toBe(true);
    expect(rec.delegation_belt).toEqual({
      requested: true,
      server_name: "claudexor",
      ready: false,
      failed: true,
      tool_evidence: false,
    });
  });

  it("a failed belt remains terminal even if a tool event was observed before failure", () => {
    const t = createAttemptTelemetry("auto", false, "auto", [], null, "claudexor");
    observeAttemptTelemetry(t, startedWithBelt("failed"));
    observeAttemptTelemetry(t, beltToolCall());
    expect(t.delegationBelt.toolEvidence).toBe(true);
    expect(delegationBeltUnavailable(t)).toBe(true);
    setAttemptOutcome(t, outcomeOpts);
    expect(t.outcome?.status).toBe("failed");
    expect(
      aggregateRunDelegation(true, [attemptTelemetryRecord("a-used-failed", "claude", t)]),
    ).toMatchObject({ reason: "startup_failed", effective: true, used: true });
  });

  it("consumes stderr-only typed MCP failure evidence before any started frame", () => {
    const telemetry = createAttemptTelemetry("auto", false, "auto", [], null, "claudexor");
    observeAttemptTelemetry(telemetry, {
      type: "error",
      session_id: "s",
      ts,
      error: "required MCP startup failed",
      payload: { mcp_servers: [{ name: "claudexor", status: "failed" }] },
    });
    expect(delegationBeltUnavailable(telemetry)).toBe(true);
    expect(
      aggregateRunDelegation(true, [attemptTelemetryRecord("a-stderr", "codex", telemetry)]),
    ).toMatchObject({ reason: "startup_failed", effective: true, used: false });
  });

  it("a ready-but-unused belt stays a clean success (docs leave the spawn decision to the harness)", () => {
    const t = createAttemptTelemetry("auto", false, "auto", [], null, "claudexor");
    observeAttemptTelemetry(t, startedWithBelt("connected"));
    expect(t.delegationBelt.ready).toBe(true);
    expect(t.delegationBelt.failed).toBe(false);
    expect(delegationBeltUnavailable(t)).toBe(false);
    setAttemptOutcome(t, outcomeOpts);
    expect(t.outcome?.status).toBe("success");
    // The evidence record is still emitted (ready/unused is durable truth).
    const rec = attemptTelemetryRecord("a1", "claude", t);
    expect(rec.delegation_belt?.ready).toBe(true);
  });

  it("a pending belt remains provisional and can become used without false failure", () => {
    const t = createAttemptTelemetry("auto", false, "auto", [], null, "claudexor");
    observeAttemptTelemetry(t, startedWithBelt("pending"));
    expect(t.delegationBelt).toMatchObject({ ready: false, failed: false, toolEvidence: false });
    expect(delegationBeltUnavailable(t)).toBe(false);
    setAttemptOutcome(t, outcomeOpts);
    expect(t.outcome?.status).toBe("success");
    expect(
      aggregateRunDelegation(true, [attemptTelemetryRecord("a-pending", "claude", t)]),
    ).toMatchObject({
      reason: "injected_unused",
      used: false,
    });

    observeAttemptTelemetry(t, beltToolResult("claude", "ok"));
    expect(t.delegationBelt).toMatchObject({ ready: false, failed: false, toolEvidence: true });
    expect(
      aggregateRunDelegation(true, [attemptTelemetryRecord("a-used", "claude", t)]),
    ).toMatchObject({
      reason: "used",
      used: true,
    });
  });

  it.each([
    ["claude", "error"],
    ["claude", "cancelled"],
    ["claude", "denied"],
    ["claude", undefined],
    ["codex", "error"],
  ] as const)("hard-fails an exact %s belt tool result with status %s", (shape, status) => {
    const t = createAttemptTelemetry("auto", false, "auto", [], null, "claudexor");
    observeAttemptTelemetry(t, startedWithBelt("pending"));
    observeAttemptTelemetry(t, beltToolResult(shape, status));
    expect(t.delegationBelt).toMatchObject({ failed: false, toolEvidence: true });
    expect(delegationBeltUnavailable(t)).toBe(false);
    expect(delegationBeltToolFailure(t)).toBe(true);
    setAttemptOutcome(t, outcomeOpts);
    expect(t.outcome?.status).toBe("failed");
    expect(
      aggregateRunDelegation(true, [attemptTelemetryRecord("a-failed", shape, t)]),
    ).toMatchObject({
      reason: "used",
      used: true,
    });
  });

  it("recovers only after the same belt tool, kind, and target succeeds", () => {
    const t = createAttemptTelemetry("auto", false, "auto", [], null, "claudexor");
    observeAttemptTelemetry(t, beltToolResult("codex", "error"));
    observeAttemptTelemetry(t, {
      ...beltToolResult("codex", "ok"),
      tool: {
        name: "claudexor_ask",
        kind: "mcp",
        target: "claudexor:claudexor_plan",
        status: "ok",
      },
    } as HarnessEvent);
    expect(delegationBeltToolFailure(t)).toBe(true);

    observeAttemptTelemetry(t, beltToolResult("codex", "ok"));
    expect(delegationBeltToolFailure(t)).toBe(false);
    setAttemptOutcome(t, outcomeOpts);
    expect(t.outcome?.status).toBe("success");
  });

  it("does not hard-fail prefix collisions, foreign targets, or non-MCP tools", () => {
    const t = createAttemptTelemetry("auto", false, "auto", [], null, "claudexor");
    const foreign: HarnessEvent[] = [
      {
        ...beltToolResult("claude", "error"),
        tool: { name: "mcp__claudexor_evil__claudexor_ask", kind: "mcp", status: "error" },
      } as HarnessEvent,
      {
        ...beltToolResult("codex", "error"),
        tool: {
          name: "claudexor_ask",
          kind: "mcp",
          target: "claudexor_evil:claudexor_ask",
          status: "error",
        },
      } as HarnessEvent,
      {
        ...beltToolResult("codex", "error"),
        tool: {
          name: "claudexor_ask",
          kind: "command",
          target: "claudexor:claudexor_ask",
          status: "error",
        },
      } as HarnessEvent,
    ];
    for (const event of foreign) observeAttemptTelemetry(t, event);
    expect(t.delegationBelt).toMatchObject({ failed: false, toolEvidence: false });
    expect(delegationBeltUnavailable(t)).toBe(false);
    expect(delegationBeltToolFailure(t)).toBe(false);
  });

  it("a non-delegate attempt records no belt evidence at all", () => {
    const t = createAttemptTelemetry("auto", false);
    // A stray mcp_servers frame for some OTHER server never fabricates belt state.
    observeAttemptTelemetry(t, startedWithBelt("failed"));
    expect(t.delegationBelt.requested).toBe(false);
    expect(t.delegationBelt.failed).toBe(false);
    setAttemptOutcome(t, outcomeOpts);
    expect(t.outcome?.status).toBe("success");
    expect(attemptTelemetryRecord("a1", "claude", t).delegation_belt).toBeUndefined();
  });

  it("aggregates one stable run receipt without guessing native subagent prose", () => {
    expect(aggregateRunDelegation(true, [])).toEqual({
      requested: true,
      effective: false,
      used: false,
      reason: "pending",
      remediation: null,
    });
    const unused = createAttemptTelemetry("auto", false, "auto", [], null, "claudexor");
    expect(aggregateRunDelegation(true, [attemptTelemetryRecord("a1", "claude", unused)])).toEqual({
      requested: true,
      effective: true,
      used: false,
      reason: "injected_unused",
      remediation: null,
    });
    observeAttemptTelemetry(unused, beltToolCall());
    expect(aggregateRunDelegation(true, [attemptTelemetryRecord("a1", "claude", unused)])).toEqual({
      requested: true,
      effective: true,
      used: true,
      reason: "used",
      remediation: null,
    });

    const degradedLane = createAttemptTelemetry("auto", false, "auto", [
      {
        capability: "delegation",
        harness_id: "cursor",
        eligible: false,
        requested: true,
        effective: false,
        reason: "manifest_unsupported",
        evidence_refs: ["manifest.capability_profile.mcp_injection"],
      },
    ]);
    expect(
      aggregateRunDelegation(true, [
        attemptTelemetryRecord("a1", "claude", unused),
        attemptTelemetryRecord("a-mixed", "cursor", degradedLane),
      ]),
    ).toEqual({
      requested: true,
      effective: true,
      used: true,
      reason: "partially_degraded",
      remediation:
        "One selected lane continued as ordinary Agent; inspect its Delegate requirement receipt or choose only Delegate-capable lanes.",
    });

    const failed = createAttemptTelemetry("auto", false, "auto", [], null, "claudexor");
    observeAttemptTelemetry(failed, startedWithBelt("failed"));
    expect(aggregateRunDelegation(true, [attemptTelemetryRecord("a2", "claude", failed)])).toEqual({
      requested: true,
      effective: true,
      used: false,
      reason: "startup_failed",
      remediation: "Repair the required delegation belt startup failure, then retry the run.",
    });

    const beforeInjection = createAttemptTelemetry("auto", false, "auto", [
      {
        capability: "delegation",
        harness_id: "claude",
        eligible: true,
        requested: true,
        effective: true,
        reason: "effective",
        evidence_refs: ["runtime.delegation_belt"],
      },
    ]);
    expect(
      aggregateRunDelegation(true, [attemptTelemetryRecord("a3", "claude", beforeInjection)]),
    ).toEqual({
      requested: true,
      effective: false,
      used: false,
      reason: "pending",
      remediation: null,
    });
  });
});

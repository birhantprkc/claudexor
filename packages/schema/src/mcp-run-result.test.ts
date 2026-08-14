import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "./primitives.js";
import { McpRunHandleResult, McpRunToolResult } from "./mcp-run-result.js";
import { type RunFacts, validateRunFactsInvariants } from "./run-facts.js";
import { makeOutcomeFacts } from "./status-projection.js";

const timestamp = "2026-08-14T00:00:00.000Z";

function validRunFacts(): RunFacts {
  return validateRunFactsInvariants({
    schema_version: SCHEMA_VERSION,
    run_id: "run-mcp-result",
    task_id: "task-mcp-result",
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
    generated_at: timestamp,
  });
}

const toolResult = {
  summary: "terminal plan",
  runId: "run-mcp-result",
  runDir: "/tmp/run-mcp-result",
  status: "succeeded",
  applyEligibility: null,
};

describe("MCP run result RunFacts contract (GH #85)", () => {
  it("keeps legacy omission additive while preserving explicit object and null", () => {
    const receipt = validRunFacts();

    expect(McpRunToolResult.parse(toolResult).runFacts).toBeNull();
    expect(McpRunHandleResult.parse({ summary: "status" }).runFacts).toBeNull();
    expect(McpRunToolResult.parse({ ...toolResult, runFacts: receipt }).runFacts).toEqual(receipt);
    expect(McpRunHandleResult.parse({ summary: "status", runFacts: receipt }).runFacts).toEqual(
      receipt,
    );
    expect(McpRunToolResult.parse({ ...toolResult, runFacts: null }).runFacts).toBeNull();
    expect(McpRunHandleResult.parse({ summary: "status", runFacts: null }).runFacts).toBeNull();
  });

  it("rejects a present malformed receipt on both public result families", () => {
    expect(() =>
      McpRunToolResult.parse({ ...toolResult, runFacts: { run_id: "partial" } }),
    ).toThrow();
    expect(() =>
      McpRunHandleResult.parse({ summary: "status", runFacts: { run_id: "partial" } }),
    ).toThrow();
  });

  it.each(["McpRunToolResult", "McpRunHandleResult"])(
    "%s generated schema exposes optional default-null RunFacts",
    (name) => {
      const schema = JSON.parse(
        readFileSync(new URL(`../generated/${name}.schema.json`, import.meta.url), "utf8"),
      ) as {
        definitions: Record<
          string,
          { properties: Record<string, { default?: unknown }>; required?: string[] }
        >;
      };
      const root = schema.definitions[name];

      expect(root.properties.runFacts).toMatchObject({ default: null });
      expect(root.required ?? []).not.toContain("runFacts");
    },
  );
});

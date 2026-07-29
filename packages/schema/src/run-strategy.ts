import type { ModeKind } from "./primitives.js";

export interface RunControlApplicabilityItem {
  applicable: boolean;
  reason?: string;
}

export interface RunControlApplicability {
  reviewerPanel: RunControlApplicabilityItem;
  protectedPathApprovals: RunControlApplicabilityItem;
}

const REVIEWER_UNAVAILABLE_REASON =
  "Reviewer controls only apply to Agent runs; Council is the Plan critique path.";
const APPROVAL_UNAVAILABLE_REASON =
  "Protected-path approvals only apply to Agent runs; Ask and Plan are read-only.";

/**
 * Focused applicability owner for the two run-control families that authorize
 * Agent review/change behavior. Surfaces project this result; they do not
 * independently infer mode applicability from read-only labels or UI layout.
 */
export function runControlApplicability(value: { mode?: ModeKind }): RunControlApplicability {
  const applicable = (value.mode ?? "agent") === "agent";
  return {
    reviewerPanel: applicable
      ? { applicable: true }
      : { applicable: false, reason: REVIEWER_UNAVAILABLE_REASON },
    protectedPathApprovals: applicable
      ? { applicable: true }
      : { applicable: false, reason: APPROVAL_UNAVAILABLE_REASON },
  };
}

/** Mode/strategy coherence (D11): meaningless flag combinations are refused
 * at every wire boundary instead of being silently ignored. ONE owner — the
 * control-api normalization funnel throws these as 400s; kept beside the
 * schema (not baked in as a union) so `.omit`/`.shape` consumers survive. */
export function runStartStrategyViolations(value: {
  mode?: ModeKind;
  deepScan?: boolean;
  untilClean?: boolean;
  attempts?: number | null;
  create?: boolean;
  council?: boolean;
  n?: number;
  delegate?: boolean;
  reviewerPanel?: unknown;
  reviewerModels?: unknown;
  reviewerEfforts?: unknown;
  protectedPathApprovals?: unknown;
  synthesis?: unknown;
  tests?: unknown;
  denyPaths?: unknown;
  outputSchema?: unknown;
}): string[] {
  const mode = value.mode ?? "agent";
  const violations: string[] = [];
  if (value.deepScan === true && mode !== "ask") {
    violations.push(`deepScan is an ask strategy; mode is '${mode}'`);
  }
  if (value.untilClean === true && mode !== "agent") {
    violations.push(`untilClean is an agent strategy; mode is '${mode}'`);
  }
  if (value.attempts != null && mode !== "agent") {
    violations.push(`attempts is an agent strategy; mode is '${mode}'`);
  }
  if (value.create === true && mode !== "agent") {
    violations.push(`create is an agent strategy; mode is '${mode}'`);
  }
  // Council (INV-031) is a PLAN strategy: N harnesses draft in parallel, the
  // primary merges into one plan + one question set.
  if (value.council === true && mode !== "plan") {
    violations.push(`council is a plan strategy; mode is '${mode}'`);
  }
  // `n` widens best-of (agent), deep-scan (ask), or council membership (plan).
  // On a PLAIN plan run (no council) it is meaningless and refused; council is
  // the one flag that legalizes `n` on a plan.
  const nLegal =
    mode === "agent" ||
    (mode === "ask" && value.deepScan === true) ||
    (mode === "plan" && value.council === true);
  if (value.n !== undefined && !nLegal) {
    violations.push(
      mode === "plan"
        ? `n sets council membership width on a plan run; pass --council (mode is 'plan' without council)`
        : `n sets the best-of race width (agent) or deep-scan width (ask); mode is '${mode}'`,
    );
  }
  if (value.council === true && value.n !== undefined && (value.n < 2 || value.n > 4)) {
    violations.push(`council membership n must be between 2 and 4 (got ${value.n})`);
  }
  if (value.delegate === true && mode !== "agent") {
    violations.push(`delegate is an agent strategy; mode is '${mode}'`);
  }
  const applicability = runControlApplicability({ mode });
  if (value.reviewerPanel !== undefined && !applicability.reviewerPanel.applicable) {
    violations.push(
      `reviewerPanel only applies to agent runs (plan review was retired in v3; Council is the plan critique path); mode is '${mode}'`,
    );
  }
  if (hasRecordEntries(value.reviewerModels) && !applicability.reviewerPanel.applicable) {
    violations.push(
      `reviewerModels only applies to agent runs (plan review was retired in v3; Council is the plan critique path); mode is '${mode}'`,
    );
  }
  if (hasRecordEntries(value.reviewerEfforts) && !applicability.reviewerPanel.applicable) {
    violations.push(
      `reviewerEfforts only applies to agent runs (plan review was retired in v3; Council is the plan critique path); mode is '${mode}'`,
    );
  }
  if (
    hasArrayEntries(value.protectedPathApprovals) &&
    !applicability.protectedPathApprovals.applicable
  ) {
    violations.push(
      `protectedPathApprovals only applies to agent runs (read-only modes do not change protected paths); mode is '${mode}'`,
    );
  }
  if (value.synthesis !== undefined && mode !== "agent") {
    violations.push(`synthesis only applies to agent best-of runs; mode is '${mode}'`);
  }
  if (value.tests !== undefined && mode !== "agent") {
    violations.push(`tests only applies to agent runs; mode is '${mode}'`);
  }
  if (value.denyPaths !== undefined && mode !== "agent") {
    violations.push(`denyPaths only applies to agent runs; mode is '${mode}'`);
  }
  if (value.outputSchema !== undefined && mode === "plan") {
    violations.push(`outputSchema applies to agent/ask runs, not plan runs`);
  }
  return violations;
}

function hasRecordEntries(value: unknown): boolean {
  return (
    !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0
  );
}

function hasArrayEntries(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

/**
 * Whether this run shape needs a Git-backed workspace before a provider can
 * start. Read-only modes do not unless their durable thread itself lives in a
 * worktree. Agent race/create/single always do; the one existing non-Git write
 * path is live convergence, whose copy-baseline workspace is explicitly
 * implemented by the engine.
 */
export function runStartRequiresGit(
  value: {
    mode?: ModeKind;
    untilClean?: boolean;
    attempts?: number | null;
    execution?: { isolation?: "envelope" | "live" };
  },
  context: { effectiveWorkspaceRequiresGit?: boolean } = {},
): boolean {
  // A thread may execute "live" *inside a worktree*: isolated threads and
  // protected-path promotion are resolved by the daemon from durable thread /
  // project state, not from the wire isolation flag. That effective workspace
  // must win over the convergence exception below, because creating/reusing it
  // requires Git before any provider can start.
  if (context.effectiveWorkspaceRequiresGit === true) return true;
  if ((value.mode ?? "agent") !== "agent") return false;
  const convergence = value.untilClean === true || value.attempts != null;
  return !(convergence && value.execution?.isolation === "live");
}

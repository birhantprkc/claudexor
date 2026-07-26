import { join } from "node:path";
import { ArtifactStore, type RunPaths } from "@claudexor/artifact-store";
import { EventLog } from "@claudexor/event-log";
import { makeOutcomeFacts, type ModeKind } from "@claudexor/schema";
import { containsSecretLikeToken, newId, sha256 } from "@claudexor/util";
import { createRevertAnchorOrNull, snapshotTree } from "@claudexor/workspace";
import type { AttemptTelemetry } from "./attemptTelemetry.js";
import type { CandidateRun } from "./candidateEvidence.js";
import { delegationBeltToolFailure, delegationBeltUnavailable } from "./delegationToolEvidence.js";

export type DelegationFailureKind = "startup" | "runtime";

/** One owner for the post-injection failure boundary shared by race,
 * convergence, and attempt finalization. Runtime takes precedence if corrupt
 * evidence ever reports both facts. */
export function delegationFailureKind(t: AttemptTelemetry): DelegationFailureKind | null {
  if (delegationBeltToolFailure(t)) return "runtime";
  if (delegationBeltUnavailable(t)) return "startup";
  return null;
}

export function delegationFailureError(t: AttemptTelemetry): string | null {
  const kind = delegationFailureKind(t);
  return kind === "runtime"
    ? "delegation belt tool failed after injection"
    : kind === "startup"
      ? "delegation belt failed to start after injection"
      : null;
}

/** Build the terminal cause/provenance without duplicating the race and
 * convergence messages or raw-attempt links. */
export function delegationFailureTerminal(run: CandidateRun, lane: "race" | "convergence") {
  const kind = delegationFailureKind(run.telemetry);
  if (!kind) throw new Error("delegation failure terminal requested for a healthy attempt");
  const runtime = kind === "runtime";
  const message = runtime
    ? lane === "race"
      ? `Delegate belt tool failed in ${run.harnessId}; no deliverable or native fallback may replace the failed injected operation`
      : `Delegate belt tool failed in ${run.harnessId}; convergence cannot review, repair, or continue after an unrecovered injected operation fails`
    : lane === "race"
      ? `Delegate startup failed in ${run.harnessId}; no degraded sibling may replace an injected failed belt`
      : `Delegate startup failed in ${run.harnessId}; convergence cannot repair or continue after an injected belt fails`;
  return {
    phase: runtime ? "delegation_runtime" : "delegation_startup",
    error: new Error(message),
    metadata: {
      category: "harness_error" as const,
      harnessId: run.harnessId,
      attemptId: run.attemptId,
      rawDetailRef: `attempts/${run.attemptId}/attempt.yaml`,
      nextActions: [
        `Inspect attempts/${run.attemptId}/attempt.yaml`,
        runtime
          ? "Repair the failed Delegate belt operation, then retry the run"
          : "Repair the required Delegate belt startup, then retry the run",
      ],
    },
  };
}

/** An explicitly in-place harness may have changed the live tree before a
 * required Delegate failure becomes terminal. Persist those unavoidable bytes
 * as blocked and revertable; envelope runs stay diagnostic-only. */
export async function persistFailedInPlaceWorkProduct(input: {
  live: boolean;
  run: CandidateRun;
  store: ArtifactStore;
  log: EventLog;
  paths: RunPaths;
  execRoot: string;
  preTurnSha: string | null;
  postTurnSha?: string | null;
  taskId: string;
  mode: ModeKind;
  kind: "patch" | "new_repo";
  attempts?: number;
}): Promise<void> {
  if (!input.live || !input.run.diff.trim()) return;
  if (containsSecretLikeToken(input.run.diff)) {
    throw new Error("failed in-place patch diff contains secret-like token; refusing artifact");
  }
  let postTurnSha = input.postTurnSha;
  if (postTurnSha === undefined) {
    try {
      postTurnSha = await snapshotTree(input.execRoot);
    } catch {
      postTurnSha = null;
    }
  }
  const revertAnchorId = await createRevertAnchorOrNull(
    input.execRoot,
    input.preTurnSha,
    postTurnSha,
  );
  const facts = makeOutcomeFacts("failed", { reason: "harness_failed", noChanges: false });
  input.store.writeText(join(input.paths.finalDir, "patch.diff"), input.run.diff);
  input.store.writeYaml(join(input.paths.finalDir, "work_product.yaml"), {
    id: newId("wp"),
    kind: input.kind,
    source_task_id: input.taskId,
    producer_attempt_id: input.run.attemptId,
    meta: {
      harness_id: input.run.harnessId,
      result_kind: "patch",
      mode: input.mode,
      ...(input.attempts !== undefined ? { attempts: input.attempts } : {}),
      lifecycle: facts.lifecycle,
      outcome_facts: facts,
      review_verified: false,
      patch_sha256: sha256(input.run.diff),
      adopted: true,
      apply_state: "applied_review_blocked",
      pre_turn_sha: input.preTurnSha,
      post_turn_sha: postTurnSha,
      revert_anchor_id: revertAnchorId,
    },
  });
  input.log.emit("work_product.emitted", {
    winner: input.run.attemptId,
    apply_state: "applied_review_blocked",
  });
}

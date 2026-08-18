/**
 * A2: the WIDENED reactive rotation predicate (W5.4 + the structural branch).
 *
 * Two independent ways an attempt becomes rotation-eligible:
 *
 * 1. TYPED fast path (W5.4 canon, unchanged): the attempt saw a TYPED vendor
 *    rate-limit signal. Deliberately NOT hardened against thinking/tool
 *    activity — the canon guard is no-deliverable/no-mutation, not
 *    no-progress.
 *
 * 2. STRUCTURAL branch (owner decision 7=A): the attempt ended in a TERMINAL,
 *    non-transient death BEFORE the agent demonstrably did any work. This
 *    deliberately covers ANY pre-progress non-transient death — an invalid
 *    flag, a missing binary, an untyped vendor refusal — bounded by the
 *    profile pool size, and is NEVER narrowed by error-text matching.
 *    Transient-retryable deaths are excluded: the transient machinery retries
 *    them on the SAME profile first (rotation never fires on a plain
 *    transient).
 *
 * Both branches require an empty deliverable and no observed workspace
 * mutation — a partially-acted attempt never silently reruns under another
 * credential.
 */
import type { AttemptOutputMarkers } from "./attemptOutputMarkers.js";

/** Typed evidence one native try presents to the rotation predicate. */
export interface RotationEvidence {
  /** A TYPED vendor rate-limit signal was observed this try (W5.4). */
  sawTypedLimit: boolean;
  /** No POLICY-ACCEPTED answer material (`acceptedTryOutput`: an errored try's
   * mid-stream narration — e.g. a vendor refusal arriving as MESSAGE prose —
   * never counts, for ANY adapter) and (candidate lane) no workspace diff. */
  deliverableEmpty: boolean;
  /** A workspace mutation was OBSERVED: a non-empty diff (candidate lane) or
   * any typed file_change event (both lanes — the read-only lane has no
   * workspace diff, so disclosed file changes are its only mutation truth). */
  mutationObserved: boolean;
  /** The try ended in a terminal error that is NOT transient-retryable (the
   * transient machinery owns same-profile retries for the retryable class). */
  terminalNonTransientDeath: boolean;
  /** The agent demonstrably started working (attemptOutputMarkers policy:
   * thinking/tool/file/patch/compaction — deliberately NOT message/error). */
  sawAgentProgress: boolean;
}

/**
 * `rotation_retry_eligible`: the one predicate both lanes and both branches
 * read. Optional fields default CONSERVATIVELY (absent evidence never widens
 * eligibility), so the frozen truth-table pins keep their meaning.
 */
export function rotationRetryEligible(input: {
  sawTypedLimit: boolean;
  deliverableEmpty: boolean;
  mutationObserved?: boolean;
  terminalNonTransientDeath?: boolean;
  sawAgentProgress?: boolean;
}): boolean {
  if (!input.deliverableEmpty || input.mutationObserved === true) return false;
  if (input.sawTypedLimit) return true;
  return input.terminalNonTransientDeath === true && input.sawAgentProgress !== true;
}

/**
 * Fold one native try's lane-local facts + the attempt's typed output markers
 * into RotationEvidence. `attemptErrored` / `sawRetryable` come from the
 * lane's per-try failure state; `workspaceDiffNonEmpty` exists only in the
 * candidate lane (the read-only lane omits it and relies on file_change
 * markers alone).
 */
export function reactiveRotationEvidence(args: {
  markers: AttemptOutputMarkers;
  sawTypedLimit: boolean;
  sawRetryable: boolean;
  attemptErrored: boolean;
  deliverableEmpty: boolean;
  workspaceDiffNonEmpty?: boolean;
}): RotationEvidence {
  return {
    sawTypedLimit: args.sawTypedLimit,
    deliverableEmpty: args.deliverableEmpty,
    mutationObserved: (args.workspaceDiffNonEmpty ?? false) || args.markers.fileChanges > 0,
    terminalNonTransientDeath: args.attemptErrored && !args.sawRetryable,
    sawAgentProgress: args.markers.sawAgentProgress,
  };
}

import type { HarnessAdapter } from "@claudexor/core";
import type { LiveInputCapability } from "@claudexor/schema";

/**
 * One live agent attempt offered to the daemon's live-input registry
 * (`POST /v2/runs/:id/messages`). Structural twin of the daemon's
 * LiveAttemptContext: the orchestrator never imports the daemon.
 */
export interface LiveAttemptContext {
  runId: string;
  taskId: string;
  attemptId: string;
  harnessId: string;
  /** LIVE getter: a native transient retry mints a new session id per try. */
  currentSessionId: () => string | null;
  /** The adapter's declared channel (`capabilityProfile.live_input`, default none). */
  liveInput: LiveInputCapability;
  adapter: HarnessAdapter;
  /** Thread turns are not steerable in v1 (INV-137: the packet would lose the message). */
  threadBound: boolean;
}

export interface LiveAttemptRelease {
  /** Ends this attempt's steering window; a stale release cannot evict a replacement. */
  release(): void;
}

/**
 * `RunInput.onLiveAttempt`: called once per agent attempt (runCandidateInEnvelope,
 * where the native session id is owned) and released in that attempt's finally.
 * Steering lifetime is therefore attempt-local — a native transient retry keeps
 * the registration (the getter follows the new session), while a convergence
 * attempt, Exact Retry or rerun_with_feedback is a NEW registration that never
 * re-injects earlier messages. Absent handler: no run is steerable.
 */
export type LiveAttemptHook = (ctx: LiveAttemptContext) => LiveAttemptRelease;

const NOT_OFFERED: LiveAttemptRelease = { release: () => {} };

/**
 * Register the attempt with the daemon hook when one is wired. The channel is
 * the routed manifest's `capability_profile.live_input` (the same declaration
 * the agent-capability catalog projects as `liveInput`), never the adapter
 * object's static profile: a fixture adapter declares it only in `discover()`.
 * A `none` declaration makes the registry answer `unsupported`.
 */
export function liveAttempt(
  runInput: { onLiveAttempt?: LiveAttemptHook; threadId?: string } | undefined,
  routed: { adapter: HarnessAdapter; liveInput: LiveInputCapability },
  paths: { runId: string },
  contract: { task_id: string },
  attemptId: string,
  currentSessionId: () => string | null,
): LiveAttemptRelease {
  const hook = runInput?.onLiveAttempt;
  if (!hook) return NOT_OFFERED;
  return hook({
    runId: paths.runId,
    taskId: contract.task_id,
    attemptId,
    harnessId: routed.adapter.id,
    currentSessionId,
    liveInput: routed.liveInput,
    adapter: routed.adapter,
    threadBound: typeof runInput?.threadId === "string" && runInput.threadId.length > 0,
  });
}

import type { ThreadContinuityContext } from "@claudexor/orchestrator";

/** The thread-store reads this projection needs; narrower than the whole store. */
export interface ThreadContinuitySource {
  getTurn(id: string): { created_at?: string } | undefined;
  turnsFor(threadId: string): ReadonlyArray<{
    id: string;
    prompt: string;
    run_id: string | null;
    created_at: string;
  }>;
  laneCheckpointsForThread(
    threadId: string,
  ): ReadonlyArray<{ harness_id: string; profile_id: string | null; turn_id: string }>;
}

/**
 * Continuity facts for one thread turn (INV-137): the prior turns the engine
 * builds its delta packet from, plus every lane checkpoint of the thread.
 *
 * Only a BOUND thread turn has any — a non-thread one-shot has no conversation
 * to continue, so this returns undefined and the engine hydrates nothing.
 *
 * Lives here rather than inline in `claudexord.ts` because it is a pure
 * thread-store projection with no daemon lifecycle in it, and `claudexord.ts`
 * is a tracked complexity-ratchet file (INV-124) whose job is wiring.
 */
export function threadContinuityContext(input: {
  threads: ThreadContinuitySource;
  threadId: string | null | undefined;
  turnId: string | null | undefined;
  profileId: string | null;
}): ThreadContinuityContext | undefined {
  const { threads, threadId, turnId, profileId } = input;
  if (!threadId || !turnId) return undefined;
  const currentCreatedAt = threads.getTurn(turnId)?.created_at ?? "";
  return {
    turnId,
    profileId,
    priorTurns: threads
      .turnsFor(threadId)
      .filter(
        (t) =>
          t.id !== turnId &&
          t.run_id != null &&
          (!currentCreatedAt || t.created_at < currentCreatedAt),
      )
      .map((t) => ({ id: t.id, prompt: t.prompt, runId: t.run_id })),
    laneCheckpoints: threads.laneCheckpointsForThread(threadId).map((c) => ({
      harness: c.harness_id,
      profileId: c.profile_id ?? null,
      turnId: c.turn_id,
    })),
  };
}

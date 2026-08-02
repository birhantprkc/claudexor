import { describe, expect, it } from "vitest";
import {
  threadContinuityContext,
  type ThreadContinuitySource,
} from "./thread-continuity-context.js";

/**
 * The daemon-side BUILDER of the INV-137 continuity context. Its three filter
 * conditions used to live inline inside `claudexord.ts`'s run-start closure,
 * where nothing could reach them: the orchestrator's continuity tests all
 * CONSTRUCT a `ThreadContinuityContext` and start from there, so a wrong prior
 * -turn set produced here would have hydrated a lane switch with the wrong
 * conversation and no test would have moved.
 */
function source(
  turns: ReadonlyArray<{ id: string; prompt: string; run_id: string | null; created_at: string }>,
  checkpoints: ReadonlyArray<{
    harness_id: string;
    profile_id: string | null;
    turn_id: string;
  }> = [],
): ThreadContinuitySource {
  return {
    getTurn: (id) => turns.find((t) => t.id === id),
    turnsFor: () => turns,
    laneCheckpointsForThread: () => checkpoints,
  };
}

const turns = [
  { id: "t1", prompt: "first", run_id: "run-1", created_at: "2026-01-01T00:00:00.000Z" },
  { id: "t2", prompt: "never ran", run_id: null, created_at: "2026-01-01T00:01:00.000Z" },
  { id: "t3", prompt: "current", run_id: "run-3", created_at: "2026-01-01T00:02:00.000Z" },
  { id: "t4", prompt: "later", run_id: "run-4", created_at: "2026-01-01T00:03:00.000Z" },
];

describe("threadContinuityContext", () => {
  it("keeps only prior turns that actually ran, excluding the current turn", () => {
    const ctx = threadContinuityContext({
      threads: source(turns),
      threadId: "th-1",
      turnId: "t3",
      profileId: null,
    });
    // t2 never bound a run (nothing to continue FROM), t3 is the current turn,
    // t4 is newer than it. Only t1 is prior conversation.
    expect(ctx?.priorTurns).toEqual([{ id: "t1", prompt: "first", runId: "run-1" }]);
  });

  it("treats an unknown current turn as 'no ordering bound' rather than dropping history", () => {
    // The current turn is not in the store yet (created_at unknown): the engine
    // must still see the ran turns, just without the newer-than cut.
    const ctx = threadContinuityContext({
      threads: source(turns),
      threadId: "th-1",
      turnId: "t9",
      profileId: null,
    });
    expect(ctx?.priorTurns.map((t) => t.id)).toEqual(["t1", "t3", "t4"]);
  });

  it("never feeds the current turn back to itself when its timestamp is missing", () => {
    // The ordering cut is disabled without a `created_at` on the current turn,
    // so the id check is the only thing left standing between the engine and a
    // continuity packet that quotes the prompt currently being run.
    const undated = [
      { id: "t1", prompt: "first", run_id: "run-1", created_at: "2026-01-01T00:00:00.000Z" },
      { id: "t3", prompt: "current", run_id: "run-3", created_at: "" },
    ];
    const ctx = threadContinuityContext({
      threads: source(undated),
      threadId: "th-1",
      turnId: "t3",
      profileId: null,
    });
    expect(ctx?.priorTurns).toEqual([{ id: "t1", prompt: "first", runId: "run-1" }]);
  });

  it("carries the requested profile and renames lane checkpoints for the engine", () => {
    const ctx = threadContinuityContext({
      threads: source(turns, [
        { harness_id: "codex", profile_id: "prof-1", turn_id: "t1" },
        { harness_id: "claude", profile_id: null, turn_id: "t3" },
      ]),
      threadId: "th-1",
      turnId: "t3",
      profileId: "prof-2",
    });
    expect(ctx?.profileId).toBe("prof-2");
    expect(ctx?.laneCheckpoints).toEqual([
      { harness: "codex", profileId: "prof-1", turnId: "t1" },
      { harness: "claude", profileId: null, turnId: "t3" },
    ]);
  });

  it("has no continuity for an unbound one-shot run", () => {
    const threads = source(turns);
    expect(
      threadContinuityContext({ threads, threadId: null, turnId: "t3", profileId: null }),
    ).toBeUndefined();
    expect(
      threadContinuityContext({ threads, threadId: "th-1", turnId: null, profileId: null }),
    ).toBeUndefined();
  });
});

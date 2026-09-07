import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableJournal } from "@claudexor/journal";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandStore, commandProjection } from "./command-store.js";
import { InteractionStore, interactionProjection } from "./interactions.js";
import { JournalManager } from "./journal-manager.js";
import { OperatorDecisionStore, operatorDecisionProjection } from "./operator-decisions.js";
import { RunEventStore, runEventProjection } from "./run-events.js";
import { ThreadStore, threadProjection } from "./threads.js";

const roots: string[] = [];
const closable: Array<{ close(): void }> = [];
const timestamp = "2026-09-07T00:00:00.000Z";
afterEach(() => {
  vi.restoreAllMocks();
  for (const value of closable.splice(0)) value.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function seed() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "claudexor-selected-projections-")));
  roots.push(root);
  const journal = new DurableJournal({ rootDir: join(root, "journal"), partition: "global" });
  closable.push(journal);
  return { root, journal };
}

function manager(root: string) {
  const value = new JournalManager(root);
  closable.push(value);
  return value;
}

describe("journal projection selection", () => {
  it("replays mixed valid command, interaction, decision, thread and event history", () => {
    const { root, journal } = seed();
    const command = new CommandStore(journal);
    command.accept({ id: "job-1", params: {}, idempotencyKey: "job-key", clientId: "test" });
    command.update("job-1", { state: "running", runId: "run-1" });
    const threads = new ThreadStore(journal);
    const thread = threads.createThread({ title: "A retained thread" });
    const turn = threads.createTurn(thread.id, "A retained turn");
    new InteractionStore(journal).request({
      runId: "run-1",
      taskId: "task-1",
      attemptId: "a01",
      harnessId: "fake",
      request: { interaction_id: "int-1", source_tool: "AskUserQuestion", questions: [] },
      requestedAt: timestamp,
      timeoutAt: null,
    });
    const decision = {
      runId: "run-1",
      action: "accept_risk" as const,
      findingIds: ["finding-1"],
      acceptedRisks: ["A retained decision"],
      patchSha256: `sha256:${"0".repeat(64)}`,
      decidedAt: timestamp,
    };
    new OperatorDecisionStore(journal).record(decision);
    new RunEventStore(journal).record({
      ts: timestamp,
      run_id: "run-1",
      task_id: "task-1",
      type: "run.failed",
      payload: {},
    });
    journal.append("run.event.extra", { invalidAsRunEvent: true });
    const originalCount = journal.currentSequence();
    journal.close();

    const reopened = manager(root);
    const commands = reopened.registerProjection(commandProjection());
    const interactions = reopened.registerProjection(interactionProjection());
    const decisions = reopened.registerProjection(operatorDecisionProjection());
    const events = reopened.registerProjection(runEventProjection());
    const threadSlot = reopened.registerProjection(threadProjection());
    expect(reopened.prepare().inspection.status).toBe("ready");
    expect(commands.prepared().get("job-1")?.state).toBe("running");
    expect(interactions.prepared().status("run-1", "int-1")).toBe("pending");
    expect(decisions.prepared().get("run-1")).toEqual(decision);
    expect(threadSlot.prepared().getThread(thread.id)?.title).toBe("A retained thread");
    expect(threadSlot.prepared().getTurn(turn.id)?.prompt).toBe("A retained turn");
    expect(() => events.prepared().validateProjection()).not.toThrow();
    reopened.activatePrepared();
    reopened.recoverAfterStartup();
    // A legacy terminal without RunFacts keeps its distinct recovery result;
    // ignoring the selected terminal would take the generic interruption path.
    expect(commands.current().get("job-1")).toMatchObject({
      state: "interrupted",
      errorCode: "legacy_terminal_recovery_unavailable",
    });
    expect(interactions.current().status("run-1", "int-1")).toBe("resolved");
    expect(reopened.events().slice(0, originalCount).at(-1)?.type).toBe("run.event.extra");
  });

  it("validates once during preparation while keeping direct and explicit validation", () => {
    const { root, journal } = seed();
    journal.append("future.unknown", {});
    journal.close();
    const validate = vi.spyOn(RunEventStore.prototype, "validateProjection");
    const reopened = manager(root);
    const slot = reopened.registerProjection(runEventProjection());
    expect(reopened.prepare().inspection.status).toBe("ready");
    expect(validate).toHaveBeenCalledTimes(1);
    slot.prepared().validateProjection();
    expect(validate).toHaveBeenCalledTimes(2);
    reopened.close();
    const direct = new DurableJournal({ rootDir: join(root, "journal"), partition: "global" });
    closable.push(direct);
    direct.append("run.event", { malformed: true });
    expect(() => new RunEventStore(direct)).toThrow();
  });

  it.each([
    ["command.accepted", commandProjection],
    ["interaction.requested", interactionProjection],
    ["operator.decision_recorded", operatorDecisionProjection],
    ["thread.entities_upserted", threadProjection],
    ["run.event", runEventProjection],
  ])("fails closed on malformed selected %s records", (type, projection) => {
    const { root, journal } = seed();
    journal.append("future.unknown", { anything: true });
    journal.append(type, type === "thread.entities_upserted" ? { threads: [{ id: "bad" }] } : {});
    journal.close();
    const reopened = manager(root);
    reopened.registerProjection<unknown>(projection());
    expect(reopened.prepare().inspection.status).toBe("recovery_required");
    expect(() => reopened.activatePrepared()).toThrow(/requires recovery/);
  });
});

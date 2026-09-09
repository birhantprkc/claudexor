import { mkdtempSync, mkdirSync, realpathSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ControlJournalEvent, ControlSetupJobEvent, type ControlSetupJob } from "@claudexor/schema";
import { DurableJournal } from "../../journal/dist/index.js";
import { journalEvents } from "../../daemon/src/journal-events.js";
import { SetupJobStore } from "../../cli/src/setup-job-store.js";
import { DaemonControlApiServer, type DaemonFacadeClient } from "./daemon-server.js";

const stageIo = vi.hoisted(() => ({
  beforeSync: null as null | (() => Promise<void>),
}));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      if (String(args[0]).includes("journal-compaction-") && String(args[0]).endsWith(".compact")) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          const barrier = stageIo.beforeSync;
          stageIo.beforeSync = null;
          await barrier?.();
          await sync();
        };
      }
      return handle;
    },
  };
});

afterEach(() => {
  stageIo.beforeSync = null;
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setupJob(): ControlSetupJob {
  return {
    jobId: "setup-background-fixture",
    harness: "codex",
    action: "login",
    transport: "daemon",
    state: "queued",
    phase: "preparing",
    command: null,
    guideUrl: null,
    message: "fixture only; no login is launched",
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    profileId: null,
    authCapability: {
      attemptId: "fixture-attempt",
      challengeDigest: "a".repeat(64),
      requestDigest: "b".repeat(64),
      disclosure: {
        schemaVersion: 1,
        protocolVersion: 1,
        harness: "codex",
        requested: "subscription",
        requiredRoute: "vendor_native",
        requiredSource: "native_session",
        networkScope: "selected_harness_only",
        billingKnowledge: "unknown",
        incrementalCostKnowledge: "unknown",
        mayConsumeQuota: true,
        generatedAt: "2026-01-01T00:00:00.000Z",
      },
      state: "disclosed",
    },
  };
}

async function sse(response: Response) {
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  return {
    async next(): Promise<unknown> {
      for (;;) {
        const boundary = buffered.indexOf("\n\n");
        if (boundary >= 0) {
          const frame = buffered.slice(0, boundary);
          buffered = buffered.slice(boundary + 2);
          const data = frame.split("\n").find((line) => line.startsWith("data: "));
          if (data) return JSON.parse(data.slice(6));
          continue;
        }
        const chunk = await reader.read();
        if (chunk.done) throw new Error("journal stream closed before expected event");
        buffered += decoder.decode(chunk.value, { stream: true });
      }
    },
    async close() {
      await reader.cancel().catch(() => {});
    },
  };
}

it("keeps global, project and setup SSE cursors usable through real background publication and reopen", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "claudexor-background-sse-")));
  const stagingDir = join(root, "journal-compaction");
  mkdirSync(stagingDir, { mode: 0o700 });
  const open = (partition: string) =>
    new DurableJournal({
      rootDir: join(root, "journal"),
      partition,
      deferCompaction: true,
      compactionThresholdBytes: 0,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });
  let global = open("global");
  let project = open("project:fixture");
  let setup = new SetupJobStore(root, { journal: global });
  setup.create(setupJob());
  for (const journal of [global, project]) {
    journal.appendBatch(
      Array.from({ length: 40 }, (_, index) => ({
        type: "fixture.retained",
        payload: { index, text: "retained history ".repeat(4096) },
      })),
    );
  }
  const initialGlobal = global.currentCursor();
  const initialProject = project.currentCursor();
  const initialSetup = setup.snapshot("setup-background-fixture").cursor;
  const daemon: DaemonFacadeClient = {
    enqueue: async () => {
      throw new Error("this fixture owns journal/SSE only");
    },
    status: async () => {
      throw new Error("no run in journal/SSE fixture");
    },
    list: async () => [],
    cancel: async () => {
      throw new Error("no run to cancel");
    },
  };
  const server = new DaemonControlApiServer({
    token: "journal-background-fixture-token",
    daemon,
    pollMs: 2,
    services: {
      journalEvents: async (partition, cursor) => {
        const journal = partition === "global" ? global : project;
        return journalEvents(journal, journal.state(), cursor);
      },
      setupJobStatus: async () => setup.status("setup-background-fixture"),
      setupJobEvents: async (input) =>
        setup.events("setup-background-fixture", (input as { afterCursor?: string }).afterCursor),
    },
  });
  const streams: Awaited<ReturnType<typeof sse>>[] = [];
  let release = () => {};
  let background: Promise<unknown> | null = null;
  const { host, port } = await server.start();
  const base = `http://${host}:${port}`;
  const headers = {
    authorization: "Bearer journal-background-fixture-token",
    "X-Claudexor-Protocol-Major": "3",
  };
  const connect = async (path: string, cursor: string) => {
    const stream = await sse(
      await fetch(`${base}/v2${path}`, {
        headers: { ...headers, "Last-Event-ID": cursor },
        signal: AbortSignal.timeout(20_000),
      }),
    );
    streams.push(stream);
    return stream;
  };
  try {
    const globalStream = await connect("/global/events", initialGlobal);
    const projectStream = await connect("/projects/fixture/events", initialProject);
    const setupStream = await connect("/setup/jobs/setup-background-fixture/events", initialSetup);
    let lastSetup = initialSetup;
    let lastGlobal = initialGlobal;
    let lastProject = initialProject;
    for (const [ordinal, journal] of [global, project].entries()) {
      const entered = deferred();
      const held = deferred();
      release = held.resolve;
      stageIo.beforeSync = async () => {
        entered.resolve();
        await held.promise;
      };
      let finished = false;
      background = journal.compactInBackground({ stagingDir }).then((value) => {
        finished = true;
        return value;
      });
      await entered.promise;
      const acknowledged = journal.appendBatch([
        { type: "fixture.ack", payload: { ordinal, row: 1 } },
        { type: "fixture.ack", payload: { ordinal, row: 2 } },
      ]);
      setup.update("setup-background-fixture", { message: `during maintenance ${ordinal}` });
      const target = ordinal === 0 ? globalStream : projectStream;
      const first = ControlJournalEvent.parse(await target.next());
      const second = ControlJournalEvent.parse(await target.next());
      expect([first.cursor, second.cursor]).toEqual(
        acknowledged.map((record) => journal.cursorFor(record)),
      );
      expect([first.payload, second.payload]).toEqual(acknowledged.map((record) => record.payload));
      const setupEvent = ControlSetupJobEvent.parse(await setupStream.next());
      expect(setupEvent.previousCursor).toBe(lastSetup);
      expect(setupEvent.job.message).toBe(`during maintenance ${ordinal}`);
      lastSetup = setupEvent.cursor;
      // Global has the setup row as well; preserve its last delivered cursor.
      const setupGlobal = ControlJournalEvent.parse(await globalStream.next());
      expect(setupGlobal.type).toBe("setup.job.saved");
      lastGlobal = setupGlobal.cursor;
      if (ordinal === 1) lastProject = second.cursor;
      expect((await fetch(`${base}/healthz`)).status).toBe(200);
      expect(finished).toBe(false);
      release();
      expect(await background).not.toBeNull();
      background = null;
      expect(journal.sequenceAfter(ordinal === 0 ? initialGlobal : initialProject)).toBe(
        ordinal === 0 ? 41 : 40,
      );
    }
    global.append("fixture.after", { retained: "global" });
    project.append("fixture.after", { retained: "project" });
    expect(ControlJournalEvent.parse(await globalStream.next()).type).toBe("fixture.after");
    expect(ControlJournalEvent.parse(await projectStream.next()).type).toBe("fixture.after");
    expect(readdirSync(stagingDir)).toEqual([]);
    const histories = [global, project].map((journal) =>
      journal.records().map(({ seq, time, type, payload }) => ({ seq, time, type, payload })),
    );
    await Promise.all(streams.splice(0).map((stream) => stream.close()));
    global.close();
    project.close();
    global = open("global");
    project = open("project:fixture");
    setup = new SetupJobStore(root, { journal: global });
    expect(
      [global, project].map((journal) =>
        journal.records().map(({ seq, time, type, payload }) => ({ seq, time, type, payload })),
      ),
    ).toEqual(histories);
    const resumedGlobal = await connect("/global/events", lastGlobal);
    const resumedProject = await connect("/projects/fixture/events", lastProject);
    expect(ControlJournalEvent.parse(await resumedGlobal.next()).type).toBe("fixture.after");
    expect(ControlJournalEvent.parse(await resumedProject.next()).type).toBe("fixture.after");
    const resumedSetup = await connect("/setup/jobs/setup-background-fixture/events", lastSetup);
    setup.update("setup-background-fixture", { message: "after reopen" });
    const resumed = ControlSetupJobEvent.parse(await resumedSetup.next());
    expect(resumed.previousCursor).toBe(lastSetup);
    expect(resumed.job.message).toBe("after reopen");
    expect(
      (
        await fetch(`${base}/v2/global/events`, {
          headers: { ...headers, "Last-Event-ID": initialProject },
        })
      ).status,
    ).toBe(409);
  } finally {
    release();
    await background?.catch(() => {});
    await Promise.all(streams.map((stream) => stream.close()));
    await server.stop();
    global.close();
    project.close();
    rmSync(root, { recursive: true, force: true });
  }
});

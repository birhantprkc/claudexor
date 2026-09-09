import { randomBytes, createHash } from "node:crypto";
import {
  existsSync,
  constants,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  renameSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DurableJournal,
  JournalAppendUncertainError,
  JournalRecoveryRequiredError,
  type JournalRecord,
} from "./index.js";

const hooks = vi.hoisted(() => ({
  stream: undefined as (() => Promise<void>) | undefined,
  sync: undefined as (() => Promise<void>) | undefined,
  close: undefined as (() => Promise<void>) | undefined,
  rename: undefined as (() => void) | undefined,
  open: undefined as (() => void) | undefined,
  writer: -1,
  writerFlags: 0,
  recoveryTracking: false,
  recoveryFault: "" as "" | "open" | "identity" | "truncate" | "flush" | "close",
  recoveryFd: -1,
  recoveryEvents: [] as string[],
  recoveryFlags: [] as number[],
}));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      if (!String(args[0]).includes("journal-compaction-")) return handle;
      return new Proxy(handle, {
        get(target, key) {
          if (key === "sync")
            return async () => {
              await hooks.sync?.();
              await target.sync();
            };
          if (key === "close")
            return async () => {
              await target.close();
              await hooks.close?.();
            };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
});
vi.mock("node:zlib", async (original) => {
  const zlib = await original<typeof import("node:zlib")>();
  return {
    ...zlib,
    createGzip: (...args: Parameters<typeof zlib.createGzip>) => {
      const gzip = zlib.createGzip(...args);
      const transform = gzip._transform.bind(gzip);
      gzip._transform = (chunk, encoding, done) => {
        transform(chunk, encoding, (error, data) => {
          void Promise.resolve()
            .then(() => hooks.stream?.())
            .then(() => done(error, data), done);
        });
      };
      return gzip;
    },
  };
});
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      const journal = String(args[0]).endsWith("journal.bin");
      const flags = typeof args[1] === "number" ? args[1] : 0;
      const append = (flags & fs.constants.O_APPEND) !== 0;
      const recovery =
        journal && hooks.recoveryTracking && !append && (flags & fs.constants.O_RDWR) !== 0;
      if (journal) hooks.open?.();
      if (recovery) {
        hooks.recoveryEvents.push("open");
        hooks.recoveryFlags.push(flags);
        if (hooks.recoveryFault === "open") throw new Error("injected recovery open failure");
      }
      const fd = fs.openSync(...args);
      if (journal && append) {
        hooks.writer = fd;
        hooks.writerFlags = flags;
      }
      if (recovery) hooks.recoveryFd = fd;
      return fd;
    },
    fstatSync: (...args: Parameters<typeof fs.fstatSync>) => {
      const stat = fs.fstatSync(...args);
      if (args[0] !== hooks.recoveryFd || hooks.recoveryFault !== "identity") return stat;
      return new Proxy(stat, {
        get(target, key) {
          if (key === "ino") {
            // Windows inode numbers can exceed exact Number precision: +1 may be a no-op.
            const different =
              typeof target.ino === "bigint" ? target.ino + 1n : target.ino === 0 ? 1 : 0;
            expect(different).not.toBe(target.ino);
            return different;
          }
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
    ftruncateSync: (fd: number, length?: number) => {
      if (hooks.recoveryTracking) {
        hooks.recoveryEvents.push("truncate");
        expect(fd).toBe(hooks.recoveryFd);
        if (hooks.recoveryFault === "truncate")
          throw new Error("injected recovery truncate failure");
      }
      fs.ftruncateSync(fd, length);
    },
    fsyncSync: (fd: number) => {
      if (hooks.recoveryTracking && fd === hooks.recoveryFd) {
        hooks.recoveryEvents.push("flush");
        if (hooks.recoveryFault === "flush") throw new Error("injected recovery flush failure");
      }
      fs.fsyncSync(fd);
    },
    writeSync: (...args: Parameters<typeof fs.writeSync>) => {
      if (hooks.recoveryTracking && args[0] === hooks.writer) {
        expect(hooks.recoveryFd).toBe(-1);
        expect(hooks.writerFlags & fs.constants.O_APPEND).not.toBe(0);
        hooks.recoveryEvents.push("append");
      }
      return fs.writeSync(...args);
    },
    closeSync: (fd: number) => {
      fs.closeSync(fd);
      if (hooks.recoveryTracking && fd === hooks.recoveryFd) {
        hooks.recoveryEvents.push("close");
        hooks.recoveryFd = -1;
        if (hooks.recoveryFault === "close") throw new Error("injected recovery close failure");
      }
    },
    rmSync: (...args: Parameters<typeof fs.rmSync>) => {
      if (hooks.recoveryTracking && String(args[0]).endsWith("append.pending.json")) {
        expect(hooks.recoveryFd).toBe(-1);
        hooks.recoveryEvents.push("remove-intent");
      }
      fs.rmSync(...args);
    },
    renameSync: (...args: Parameters<typeof fs.renameSync>) => {
      if (String(args[0]).endsWith(".compact")) {
        expect(() => fs.fstatSync(hooks.writer)).toThrow(); // close BEFORE rename on every OS
        hooks.rename?.();
      }
      fs.renameSync(...args);
    },
  };
});

let root: string;
let stagingDir: string;
const journals: DurableJournal[] = [];
beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "journal-background-")));
  stagingDir = join(root, "staging");
  mkdirSync(stagingDir, { mode: 0o700 });
});
afterEach(() => {
  for (const key of ["stream", "sync", "close", "rename", "open"] as const) hooks[key] = undefined;
  hooks.recoveryTracking = false;
  hooks.recoveryFault = "";
  hooks.recoveryFd = -1;
  hooks.recoveryEvents = [];
  hooks.recoveryFlags = [];
  for (const journal of journals.splice(0)) journal.close();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});
function fixture(count = 64, extra: Partial<ConstructorParameters<typeof DurableJournal>[0]> = {}) {
  const journal = new DurableJournal({
    rootDir: join(root, "journal"),
    partition: "global",
    now: () => new Date("2026-01-01T00:00:00Z"),
    compactionThresholdBytes: 0,
    deferCompaction: true,
    ...extra,
  });
  journals.push(journal);
  if (count)
    journal.appendBatch(
      Array.from({ length: count }, (_, n) => ({
        type: "history",
        payload: { n, text: "record ".repeat(2048) },
      })),
    );
  return journal;
}
function logical(rows: JournalRecord[]) {
  return rows.map(({ partition, epoch, seq, time, type, payload }) => ({
    partition,
    epoch,
    seq,
    time,
    type,
    payload,
  }));
}
function barrier(phase: "stream" | "sync" | "close") {
  let arrived!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  hooks[phase] = async () => {
    hooks[phase] = undefined;
    arrived();
    await held;
  };
  return { entered, release };
}
function digest(journal: DurableJournal) {
  return createHash("sha256").update(readFileSync(journal.path)).digest("hex");
}

describe("streamed compaction", () => {
  it("keeps stale explicit-compaction epochs stale after a later background pass", async () => {
    const journal = fixture();
    const stale = journal.currentCursor();
    expect(journal.compact()).not.toBeNull();
    const cursor = journal.currentCursor();
    journal.appendBatch(
      Array.from({ length: 8 }, () => ({ type: "new", payload: "tail".repeat(2048) })),
    );
    expect(await journal.compactInBackground({ stagingDir })).not.toBeNull();
    expect(() => journal.sequenceAfter(stale)).toThrow(/stale/);
    expect(journal.records(journal.sequenceAfter(cursor))).toHaveLength(8);
    const foreign = fixture(0, { partition: "project:foreign" }).currentCursor();
    expect(() => journal.sequenceAfter(foreign)).toThrow(/stale/);
  });

  it("keeps every ACKed batch and logical cursor through streaming, fsync, close and restart", async () => {
    const journal = fixture();
    const cursors = [0, 23, 64].map((seq) => journal.cursorAt(seq));
    const stream = barrier("stream");
    const flush = barrier("sync");
    const close = barrier("close");
    const flight = journal.compactInBackground({ stagingDir });
    const ignoredSignal = new AbortController();
    expect(journal.compactInBackground({ stagingDir, signal: ignoredSignal.signal })).toBe(flight);
    ignoredSignal.abort();
    await stream.entered;
    journal.appendBatch([
      { type: "during.stream", payload: { value: 1 } },
      { type: "during.stream", payload: { value: 2 } },
    ]);
    stream.release();
    await flush.entered;
    journal.appendBatch([
      { type: "during.flush", payload: "a" },
      { type: "during.flush", payload: "b" },
    ]);
    flush.release();
    await close.entered;
    journal.appendBatch([
      { type: "during.close", payload: [1, 2] },
      { type: "during.close", payload: [3, 4] },
    ]);
    const expected = logical(journal.records());
    close.release();
    expect(await flight).toMatchObject({ records: 70 });
    expect(logical(journal.records())).toEqual(expected);
    for (const [index, cursor] of cursors.entries())
      expect(logical(journal.records(journal.sequenceAfter(cursor)))).toEqual(
        expected.slice([0, 23, 64][index]),
      );
    const detached = journal.records();
    (detached[0]!.payload as { text: string }).text = "changed by reader";
    expect(logical(journal.records())).toEqual(expected);
    expect(journal.append("after.install", true).seq).toBe(71);
    journal.close();
    const replay = fixture(0);
    expect(logical(replay.records(0)).slice(0, 70)).toEqual(expected);
    expect(replay.sequenceAfter(cursors[2])).toBe(64);
    expect(replay.records(replay.sequenceAfter(cursors[2]))).toHaveLength(7);
    expect(readdirSync(stagingDir)).toEqual([]);
  });

  it("serializes records incrementally without cloning or mapping the private history", async () => {
    const journal = fixture();
    const source = (journal as unknown as { entries: JournalRecord[] }).entries;
    const stringify = JSON.stringify;
    vi.spyOn(JSON, "stringify").mockImplementation((value, replacer, space) => {
      if (Array.isArray(value) && value[0]?.type === "history")
        throw new Error("whole history stringify");
      return stringify(value, replacer, space);
    });
    vi.spyOn(source, "map").mockImplementation(() => {
      throw new Error("whole history map");
    });
    vi.spyOn(source, "slice").mockImplementation(() => {
      throw new Error("whole history copy");
    });
    expect(await journal.compactInBackground({ stagingDir })).not.toBeNull();
  });

  it.each(["close", "abort"] as const)(
    "%s cancels a blocked stream without installing or waiting for completion",
    async (action) => {
      const journal = fixture();
      const before = digest(journal);
      const gate = barrier("stream");
      const controller = new AbortController();
      const flight = journal.compactInBackground({ stagingDir, signal: controller.signal });
      await gate.entered;
      if (action === "close") journal.close();
      else controller.abort();
      expect(await flight).toBeNull();
      gate.release();
      expect(digest(journal)).toBe(before);
      expect(readdirSync(stagingDir)).toEqual([]);
    },
  );

  it.each(["success", "noop", "error"] as const)(
    "explicit synchronous compact %s revokes a held background without changing its API",
    async (outcome) => {
      const journal = fixture(outcome === "noop" ? 0 : 64);
      if (outcome === "noop") journal.append("tiny", null);
      const oldCursor = journal.currentCursor();
      const gate = barrier("stream");
      const flight = journal.compactInBackground({ stagingDir });
      await gate.entered;
      const stringify = JSON.stringify;
      if (outcome === "error")
        vi.spyOn(JSON, "stringify").mockImplementation((value, ...args) => {
          if (Array.isArray(value) && value[0]?.type === "history") throw new Error("sync failed");
          return stringify(value, ...args);
        });
      if (outcome === "error") expect(() => journal.compact()).toThrow("sync failed");
      else {
        const receipt = journal.compact();
        if (outcome === "noop") expect(receipt).toBeNull();
        else {
          expect(receipt).not.toBeNull();
          expect(receipt).not.toHaveProperty("then");
        }
      }
      const installed = digest(journal);
      expect(await flight).toBeNull();
      gate.release();
      expect(digest(journal)).toBe(installed);
      if (outcome === "success") expect(() => journal.sequenceAfter(oldCursor)).toThrow(/stale/);
      else expect(journal.sequenceAfter(oldCursor)).toBe(journal.currentSequence());
      journal.append("after.sync", true);
      expect(readdirSync(stagingDir)).toEqual([]);
    },
  );

  it("rejects failed publication with the complete new file retained and typed recovery", async () => {
    const journal = fixture();
    const expected = logical(journal.records());
    hooks.rename = () => {
      hooks.open = () => {
        throw new Error("reopen injected failure");
      };
    };
    await expect(journal.compactInBackground({ stagingDir })).rejects.toBeInstanceOf(
      JournalRecoveryRequiredError,
    );
    expect(journal.state().status).toBe("recovery_required");
    hooks.open = undefined;
    hooks.rename = undefined;
    journal.close();
    expect(logical(fixture(0).records())).toEqual(expected);
    expect(readdirSync(stagingDir)).toEqual([]);
  });

  it("failed rename reopens only the proven original writer and leaves ACKed history intact", async () => {
    const journal = fixture();
    const before = digest(journal);
    hooks.rename = () => {
      throw new Error("rename injected failure");
    };
    await expect(journal.compactInBackground({ stagingDir })).rejects.toThrow(
      "rename injected failure",
    );
    expect(digest(journal)).toBe(before);
    expect(journal.state().status).toBe("ready");
    expect(journal.append("after.rename.failure", true).seq).toBe(65);
    expect(readdirSync(stagingDir)).toEqual([]);
  });

  it("failed async fsync leaves the canonical file unchanged and appendable", async () => {
    const journal = fixture();
    const before = digest(journal);
    hooks.sync = async () => {
      throw new Error("stage fsync injected failure");
    };
    await expect(journal.compactInBackground({ stagingDir })).rejects.toThrow(
      "stage fsync injected failure",
    );
    expect(digest(journal)).toBe(before);
    expect(journal.append("after.flush.failure", true).seq).toBe(65);
    expect(readdirSync(stagingDir)).toEqual([]);
  });

  it("refuses canonical file replacement instead of swallowing its typed recovery as cancellation", async () => {
    const journal = fixture();
    const gate = barrier("sync");
    const flight = journal.compactInBackground({ stagingDir });
    await gate.entered;
    const original = readFileSync(journal.path);
    renameSync(journal.path, `${journal.path}.displaced`);
    writeFileSync(journal.path, original, { mode: 0o600 });
    gate.release();
    await expect(flight).rejects.toBeInstanceOf(JournalRecoveryRequiredError);
    expect(journal.state().status).toBe("recovery_required");
    expect(readFileSync(journal.path)).toEqual(original);
    expect(readdirSync(stagingDir)).toEqual([]);
  });

  it("uncertain append aborts maintenance without installing its unacknowledged tail", async () => {
    let fail = false;
    const journal = fixture(64, {
      appendAndSync: (fd, bytes) => {
        writeSync(fd, bytes);
        if (fail) throw new Error("uncertain append");
        fsyncSync(fd);
      },
    });
    const expected = logical(journal.records());
    const gate = barrier("sync");
    const flight = journal.compactInBackground({ stagingDir });
    await gate.entered;
    fail = true;
    expect(() =>
      journal.appendBatch([
        { type: "unacked", payload: 1 },
        { type: "unacked", payload: 2 },
      ]),
    ).toThrow(JournalAppendUncertainError);
    gate.release();
    expect(await flight).toBeNull();
    journal.close();
    const replay = fixture(0);
    expect(logical(replay.records()).slice(0, 64)).toEqual(expected);
    expect(replay.records().filter((r) => r.type === "unacked")).toEqual([]);
    expect(replay.records().at(-1)?.type).toBe("journal.recovery_tail_discarded");
  });

  it.each([18, 24])(
    "preserves incompressible %s-record history at the envelope/output caps",
    async (count) => {
      const journal = fixture(0);
      journal.appendBatch(
        Array.from({ length: count }, () => ({
          type: "random",
          payload: randomBytes(768 * 1024).toString("base64"),
        })),
      );
      const before = digest(journal);
      const cursor = journal.currentCursor();
      expect(await journal.compactInBackground({ stagingDir })).toBeNull();
      expect(digest(journal)).toBe(before);
      expect(journal.sequenceAfter(cursor)).toBe(count);
      expect(journal.append("after.cap", true).seq).toBe(count + 1);
      expect(readdirSync(stagingDir)).toEqual([]);
    },
  );
});

/** Exercise the Windows-only descriptor branch on every developer platform;
 * the same tests also run against real Windows filesystem handles in CI. */
function windowsRecovery<T>(run: () => T): T {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  hooks.recoveryTracking = true;
  try {
    return run();
  } finally {
    hooks.recoveryTracking = false;
    Object.defineProperty(process, "platform", platform);
  }
}

function crashedJournal(tailBytes?: number) {
  let crash = false;
  const journal = fixture(0, {
    appendAndSync: (fd, bytes) => {
      writeSync(
        fd,
        bytes,
        0,
        crash ? Math.min(tailBytes ?? bytes.length, bytes.length) : bytes.length,
      );
      fsyncSync(fd);
      if (crash) throw new Error("simulated crash before append ACK");
    },
  });
  journal.append("acknowledged", { retained: "prefix" });
  const retained = logical(journal.records());
  const prefix = readFileSync(journal.path);
  const cursor = journal.currentCursor();
  crash = true;
  expect(() =>
    journal.appendBatch([
      { type: "unacknowledged", payload: "one" },
      { type: "unacknowledged", payload: "two" },
    ]),
  ).toThrow(JournalAppendUncertainError);
  const intentPath = join(journal.partitionDir, "append.pending.json");
  const pending = readFileSync(intentPath);
  const before = readFileSync(journal.path);
  journal.close();
  return { path: journal.path, intentPath, prefix, pending, before, retained, cursor };
}

describe("Windows pending suffix descriptor", () => {
  it("truncates the validated suffix, closes before removing intent and retains append-at-EOF", () => {
    const seed = crashedJournal();
    const replay = windowsRecovery(() => fixture(0));
    expect(hooks.recoveryFlags).toEqual([constants.O_RDWR | constants.O_NOFOLLOW]);
    expect(hooks.recoveryEvents).toEqual([
      "open",
      "truncate",
      "flush",
      "close",
      "remove-intent",
      "append",
      "remove-intent",
    ]);
    expect(hooks.recoveryFd).toBe(-1);
    expect(logical(replay.records()).slice(0, 1)).toEqual(seed.retained);
    expect(replay.records().map((row) => row.type)).toEqual([
      "acknowledged",
      "journal.recovery_tail_discarded",
    ]);
    expect(replay.sequenceAfter(seed.cursor)).toBe(1);
    expect(replay.append("after.recovery", { at: "new EOF" }).seq).toBe(3);
    expect(existsSync(seed.intentPath)).toBe(false);
    replay.close();
    const restarted = fixture(0);
    expect(restarted.records().map((row) => row.type)).toEqual([
      "acknowledged",
      "journal.recovery_tail_discarded",
      "after.recovery",
    ]);
    expect(readFileSync(seed.path).subarray(0, seed.prefix.length)).toEqual(seed.prefix);
  });

  it("uses no nonappend descriptor for a zero-byte interrupted append", () => {
    const seed = crashedJournal(0);
    const replay = windowsRecovery(() => fixture(0));
    expect(hooks.recoveryFlags).toEqual([]);
    expect(hooks.recoveryEvents).toEqual(["remove-intent"]);
    expect(logical(replay.records())).toEqual(seed.retained);
    expect(replay.append("after.empty.recovery", true).seq).toBe(2);
  });

  it("keeps read-only preparation inert until explicit activation", () => {
    const seed = crashedJournal(3);
    const prepared = windowsRecovery(() =>
      DurableJournal.prepare({
        rootDir: join(root, "journal"),
        partition: "global",
        deferCompaction: true,
      }),
    );
    journals.push(prepared);
    expect(hooks.recoveryEvents).toEqual([]);
    expect(readFileSync(seed.path)).toEqual(seed.before);
    expect(readFileSync(seed.intentPath)).toEqual(seed.pending);
    windowsRecovery(() => prepared.activatePrepared());
    expect(hooks.recoveryEvents).toEqual([
      "open",
      "truncate",
      "flush",
      "close",
      "remove-intent",
      "append",
      "remove-intent",
    ]);
    expect(prepared.state()).toEqual({ status: "ready", discardedTailBytes: 3 });
    expect(prepared.append("after.activation", true).seq).toBe(3);
  });

  it.each(["open", "identity", "truncate", "flush", "close"] as const)(
    "%s failure retains intent and refuses readiness without leaking the recovery handle",
    (fault) => {
      const seed = crashedJournal();
      hooks.recoveryFault = fault;
      const refused = windowsRecovery(() => fixture(0));
      expect(refused.state().status).toBe("recovery_required");
      expect(() => refused.append("must.not.ack", true)).toThrow(JournalRecoveryRequiredError);
      expect(readFileSync(seed.intentPath)).toEqual(seed.pending);
      expect(hooks.recoveryEvents).not.toContain("remove-intent");
      expect(hooks.recoveryFd).toBe(-1);
      expect(readFileSync(seed.path)).toEqual(
        ["flush", "close"].includes(fault) ? seed.prefix : seed.before,
      );
      if (fault !== "open") expect(hooks.recoveryEvents.at(-1)).toBe("close");
      refused.close();
      hooks.recoveryFault = "";
      const recovered = windowsRecovery(() => fixture(0));
      expect(recovered.state().status).toBe("ready");
      expect(recovered.records().filter((row) => row.type === "unacknowledged")).toEqual([]);
      expect(logical(recovered.records()).slice(0, 1)).toEqual(seed.retained);
      expect(recovered.append("after.retry", true).type).toBe("after.retry");
    },
  );

  it("does not open a recovery descriptor for malformed intent or corrupt prefix", () => {
    const seed = crashedJournal();
    writeFileSync(seed.intentPath, "{}", { mode: 0o600 });
    const malformed = windowsRecovery(() => fixture(0));
    expect(malformed.state().status).toBe("recovery_required");
    expect(hooks.recoveryEvents).toEqual([]);
    expect(readFileSync(seed.path)).toEqual(seed.before);
    malformed.close();
    writeFileSync(seed.intentPath, seed.pending);
    const corrupt = Buffer.from(seed.before);
    corrupt[0] = corrupt[0]! ^ 0xff;
    writeFileSync(seed.path, corrupt);
    const refused = windowsRecovery(() => fixture(0));
    expect(refused.state().status).toBe("recovery_required");
    expect(hooks.recoveryEvents).toEqual([]);
    expect(readFileSync(seed.path)).toEqual(corrupt);
    expect(readFileSync(seed.intentPath)).toEqual(seed.pending);
  });
});

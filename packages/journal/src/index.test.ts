import {
  fsyncSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DurableJournal,
  JournalAppendUncertainError,
  JournalRecoveryRequiredError,
} from "./index.js";

let root: string;

beforeEach(() => {
  // `.native` matters on Windows: the plain resolver keeps the 8.3 short
  // form of %TEMP% (`RUNNER~1`), which the daemon's canonical-directory
  // guard rightly refuses.
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "claudexor-journal-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function openJournal(appendAndSync?: (fd: number, bytes: Buffer) => void) {
  return new DurableJournal({
    rootDir: root,
    partition: "global",
    epochFactory: () => "epoch-test",
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    ...(appendAndSync ? { appendAndSync } : {}),
  });
}

function overwrite(path: string, mutate: (bytes: Buffer) => void): Buffer {
  const bytes = readFileSync(path);
  mutate(bytes);
  writeFileSync(path, bytes, { mode: 0o600 });
  return bytes;
}

describe("DurableJournal", () => {
  it.each([
    [18, "base64 envelope"],
    [24, "compressed output"],
  ] as const)(
    "keeps acknowledged history appendable when the %s-record %s exceeds the frame cap",
    (count, _boundary) => {
      const journal = openJournal();
      journal.appendBatch(
        Array.from({ length: count }, (_, index) => ({
          type: "large.logical.history",
          payload: { index, bytes: randomBytes(768 * 1024).toString("base64") },
        })),
      );
      const before = createHash("sha256").update(readFileSync(journal.path)).digest("hex");
      const cursor = journal.currentCursor();
      expect(journal.compact()).toBeNull();
      expect(createHash("sha256").update(readFileSync(journal.path)).digest("hex")).toBe(before);
      expect(journal.state().status).toBe("ready");
      expect(journal.sequenceAfter(cursor)).toBe(count);
      expect(journal.append("after.failed.compaction", { retained: true }).seq).toBe(count + 1);
      journal.close();

      const reopened = openJournal();
      expect(reopened.records().map((record) => record.seq)).toEqual(
        Array.from({ length: count + 1 }, (_, index) => index + 1),
      );
      expect(reopened.records(count)[0]?.payload).toEqual({ retained: true });
      expect(reopened.state().status).toBe("ready");
      reopened.close();
    },
  );

  it("keeps a ready journal when compacted snapshot serialization hits the string limit", () => {
    const journal = openJournal();
    const internals = journal as unknown as {
      entries: Array<{ time: string; type: string; payload: unknown }>;
      knownFileBytes: number;
    };
    internals.entries.push({
      time: "2026-01-01T00:00:00.000Z",
      type: "oversized.history",
      payload: { value: 1 },
    });
    internals.knownFileBytes = Number.MAX_SAFE_INTEGER;
    const before = readFileSync(journal.path);
    const originalStringify = JSON.stringify;
    const stringify = vi.spyOn(JSON, "stringify").mockImplementation((value, replacer, space) => {
      if (
        Array.isArray(value) &&
        value.length === 1 &&
        (value[0] as { type?: unknown } | undefined)?.type === "oversized.history"
      ) {
        throw new RangeError("Invalid string length");
      }
      return originalStringify(value, replacer, space);
    });
    try {
      expect(journal.compact()).toBeNull();
      expect(readFileSync(journal.path)).toEqual(before);
      expect(journal.state()).toMatchObject({ status: "ready" });
    } finally {
      stringify.mockRestore();
    }
    journal.close();
  });

  it("keeps a ready journal when one logical payload cannot be cloned", () => {
    const journal = openJournal();
    const internals = journal as unknown as {
      entries: Array<{ time: string; type: string; payload: unknown }>;
      knownFileBytes: number;
    };
    internals.entries.push({
      time: "2026-01-01T00:00:00.000Z",
      type: "oversized.payload",
      payload: { capacityMarker: true },
    });
    internals.knownFileBytes = Number.MAX_SAFE_INTEGER;
    const before = readFileSync(journal.path);
    const originalStringify = JSON.stringify;
    const stringify = vi.spyOn(JSON, "stringify").mockImplementation((value, replacer, space) => {
      if (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        (value as { capacityMarker?: unknown }).capacityMarker === true
      ) {
        throw new RangeError("Invalid string length");
      }
      return originalStringify(value, replacer, space);
    });
    try {
      expect(journal.compact()).toBeNull();
      expect(readFileSync(journal.path)).toEqual(before);
      expect(journal.state()).toMatchObject({ status: "ready" });
    } finally {
      stringify.mockRestore();
    }
    journal.close();
  });

  it("keeps a ready journal when compacted payload materialization hits the string limit", () => {
    const journal = openJournal();
    const internals = journal as unknown as {
      entries: Array<{ time: string; type: string; payload: unknown }>;
      knownFileBytes: number;
    };
    internals.entries.push({
      time: "2026-01-01T00:00:00.000Z",
      type: "oversized.compacted.payload",
      payload: { capacityMarker: true },
    });
    internals.knownFileBytes = Number.MAX_SAFE_INTEGER;
    const before = readFileSync(journal.path);
    const originalToString = Buffer.prototype.toString;
    Buffer.prototype.toString = function (encoding?: BufferEncoding, start?: number, end?: number) {
      if (encoding === "base64") throw new RangeError("Invalid string length");
      return originalToString.call(this, encoding, start, end);
    };
    try {
      expect(journal.compact()).toBeNull();
      expect(readFileSync(journal.path)).toEqual(before);
      expect(journal.state()).toMatchObject({ status: "ready" });
    } finally {
      Buffer.prototype.toString = originalToString;
    }
    journal.close();
  });

  it("replays an fsynced hash chain and resumes an epoch-bound cursor at N+1", () => {
    const journal = openJournal();
    const first = journal.append("setup.job.saved", { id: "one" });
    const second = journal.append("setup.job.saved", { id: "two" });
    const cursor = journal.currentCursor();
    const firstCursor = journal.cursorAt(first.seq);
    expect(second.previousFrameHash).toBe(first.frameHash);
    journal.close();

    const reopened = openJournal();
    expect(reopened.records().map((record) => [record.seq, record.epoch])).toEqual([
      [1, "epoch-test"],
      [2, "epoch-test"],
    ]);
    expect(reopened.sequenceAfter(cursor)).toBe(2);
    expect(reopened.sequenceAfter(firstCursor)).toBe(1);
    expect(reopened.records(1).map((record) => record.seq)).toEqual([2]);
    expect(() => reopened.sequenceAfter(`${cursor}!!!`)).toThrow(/malformed/);
    reopened.close();

    const other = new DurableJournal({
      rootDir: join(root, "other"),
      partition: "global",
      epochFactory: () => "other-epoch",
    });
    expect(() => other.sequenceAfter(cursor)).toThrow(/stale epoch/);
    other.close();
  });

  it("appends a batch as one hash-chained durable group", () => {
    const journal = openJournal();
    const records = journal.appendBatch([
      { type: "quota.snapshot.scoped_prepared", payload: { id: "scope" } },
      { type: "quota.snapshot.upserted", payload: { id: "base" } },
    ]);
    expect(records).toHaveLength(2);
    expect(records[1]?.previousFrameHash).toBe(records[0]?.frameHash);
    journal.close();

    const reopened = openJournal();
    expect(reopened.records().map((record) => [record.type, record.payload])).toEqual([
      ["quota.snapshot.scoped_prepared", { id: "scope" }],
      ["quota.snapshot.upserted", { id: "base" }],
    ]);
    reopened.close();
  });

  // Windows refuses `rename` over a path whose target is held open (the live
  // journal handle lacks FILE_SHARE_DELETE), so the POSIX atomic-replace
  // rewrite these cases depend on cannot run there. That gap is the journal
  // writer's own, older than this lane, and is tracked separately.
  it("addresses partition entries with the platform separator, not a literal slash", () => {
    // Read-only preparation walks the partition and keys its file map by path.
    // A `${dir}/${name}` key never matched the `join()`-built path the caller
    // looks up on Windows, so a reopened daemon read its own journal as
    // missing and demanded recovery. This suite runs on the Windows lane,
    // which is the only place the two spellings differ.
    // Its own root: preparation refuses a journal root whose parent is
    // world-writable, and the system temp dir is exactly that on Linux.
    const rootDir = join(root, "separator");
    const seeded = new DurableJournal({ rootDir, partition: "global" });
    seeded.append("accepted", { value: 1 });
    seeded.close();

    const prepared = (
      DurableJournal as unknown as {
        prepare(options: { rootDir: string; partition: string }): DurableJournal;
      }
    ).prepare({ rootDir, partition: "global" });
    expect(prepared.state().status).toBe("ready");
    expect(prepared.records().map((record) => record.type)).toEqual(["accepted"]);
    prepared.close();
  });

  const itPosixReplace = it.runIf(process.platform !== "win32");

  itPosixReplace(
    "discards a complete first frame when a batch stops before its second frame",
    () => {
      const crashed = openJournal((fd, batch) => {
        const secondFrameOffset = batch.indexOf(batch.subarray(0, 8), 8);
        expect(secondFrameOffset).toBeGreaterThan(0);
        writeSync(fd, batch, 0, secondFrameOffset);
        fsyncSync(fd);
        throw new Error("simulated stop between batch frames");
      });
      expect(() =>
        crashed.appendBatch([
          { type: "quota.snapshot.scoped_prepared", payload: { id: "scope" } },
          { type: "quota.snapshot.upserted", payload: { id: "base" } },
        ]),
      ).toThrow(JournalAppendUncertainError);
      crashed.close();

      const recovered = openJournal();
      expect(recovered.state()).toMatchObject({ status: "ready" });
      expect(recovered.records().map((record) => record.type)).toEqual([
        "journal.recovery_tail_discarded",
      ]);
      recovered.close();
    },
  );

  itPosixReplace(
    "discards an incomplete EOF frame, fsyncs an audit record, and stays replayable",
    () => {
      const crashed = openJournal((fd, frame) => {
        writeSync(fd, frame, 0, 3);
        fsyncSync(fd);
        throw new Error("simulated partial append");
      });
      expect(() => crashed.append("setup.job.saved", { id: "one" })).toThrow(
        JournalAppendUncertainError,
      );
      crashed.close();

      const recovered = openJournal();
      expect(recovered.state()).toEqual({ status: "ready", discardedTailBytes: 3 });
      expect(recovered.records().map((record) => record.type)).toEqual([
        "journal.recovery_tail_discarded",
      ]);
      recovered.close();
      const restarted = openJournal();
      expect(restarted.records()[0]?.type).toBe("journal.recovery_tail_discarded");
      restarted.close();
    },
  );

  it.each([
    ["complete frame checksum", (bytes: Buffer) => (bytes[Math.floor(bytes.length / 2)] ^= 1)],
    ["protected length prefix", (bytes: Buffer) => bytes.writeUInt32BE(999, 14)],
  ])("fails closed on %s corruption without changing bytes", (_name, mutate) => {
    const journal = openJournal();
    journal.append("setup.job.saved", { id: "one" });
    const path = journal.path;
    journal.close();
    const corrupt = overwrite(path, mutate);
    const reopened = openJournal();
    expect(reopened.state().status).toBe("recovery_required");
    expect(() => reopened.append("setup.job.saved", { id: "two" })).toThrow(
      JournalRecoveryRequiredError,
    );
    expect(readFileSync(path)).toEqual(corrupt);
    reopened.close();
  });

  it("fails closed when a complete middle frame breaks the chain", () => {
    const journal = openJournal();
    journal.append("one", { value: 1 });
    journal.append("two", { value: 2 });
    const path = journal.path;
    journal.close();
    overwrite(path, (bytes) => {
      bytes[Math.floor(bytes.length / 4)] ^= 1;
    });
    const reopened = openJournal();
    expect(reopened.state().status).toBe("recovery_required");
    reopened.close();
  });

  it("poisons the live writer when append or fsync completion is uncertain", () => {
    const journal = openJournal(() => {
      throw new Error("simulated fsync failure");
    });
    expect(() => journal.append("one", { value: 1 })).toThrow(JournalAppendUncertainError);
    expect(journal.state()).toMatchObject({ status: "recovery_required" });
    expect(() => journal.append("two", { value: 2 })).toThrow(JournalRecoveryRequiredError);
    journal.close();
  });

  it("keeps records byte-equivalent when callers mutate input and returned objects", () => {
    const journal = openJournal();
    const payload = { nested: { value: 1 } };
    const returned = journal.append("one", payload);
    payload.nested.value = 2;
    returned.payload.nested.value = 3;
    expect(journal.records<typeof payload>()[0]?.payload.nested.value).toBe(1);
    journal.close();
  });

  it("does not acknowledge before the injected append path has fsynced", () => {
    let synced = false;
    const journal = openJournal((fd, frame) => {
      let offset = 0;
      while (offset < frame.length) offset += writeSync(fd, frame, offset, frame.length - offset);
      fsyncSync(fd);
      synced = true;
    });
    journal.append("one", { value: 1 });
    expect(synced).toBe(true);
    journal.close();
  });

  itPosixReplace(
    "atomically compacts frames, invalidates the old epoch cursor, and remains appendable",
    () => {
      const journal = openJournal();
      for (let index = 0; index < 100; index += 1) {
        journal.append("probe.saved", { index, repeated: "same-value".repeat(20) });
      }
      const cursor = journal.currentCursor();
      const before = journal.physicalBytes();
      const compacted = journal.compact();
      expect(compacted).toMatchObject({ beforeBytes: before, records: 100 });
      expect(compacted!.afterBytes).toBeLessThan(before);
      expect(() => journal.sequenceAfter(cursor)).toThrow(/stale epoch/);
      expect(journal.append("probe.saved", { index: 100 }).seq).toBe(101);
      journal.close();

      const reopened = openJournal();
      expect(reopened.records()).toHaveLength(101);
      expect(reopened.records()[0]?.payload).toMatchObject({ index: 0 });
      expect(reopened.records()[100]?.payload).toMatchObject({ index: 100 });
      reopened.close();
    },
  );

  itPosixReplace(
    "reopens a compacted grown history without spreading records over the call stack",
    () => {
      const logicalRecordCount = 176_345;
      const journal = openJournal();
      const internals = journal as unknown as {
        entries: Array<{ time: string; type: string; payload: unknown }>;
        knownFileBytes: number;
      };
      for (let index = 0; index < logicalRecordCount; index += 1) {
        internals.entries.push({
          time: "2026-01-01T00:00:00.000Z",
          type: "grown.history",
          payload: { index },
        });
      }
      // The production trigger is a physically grown journal. Setting only the
      // size comparison avoids manufacturing 176k fsynced frames in this unit
      // test while exercising the exact compact + replay logical-record paths.
      internals.knownFileBytes = Number.MAX_SAFE_INTEGER;

      expect(journal.compact()).toMatchObject({ records: logicalRecordCount });
      expect(journal.currentSequence()).toBe(logicalRecordCount);
      journal.close();

      const reopened = openJournal();
      expect(reopened.state().status).toBe("ready");
      expect(reopened.currentSequence()).toBe(logicalRecordCount);
      expect(reopened.records(logicalRecordCount - 1)[0]?.payload).toEqual({
        index: logicalRecordCount - 1,
      });
      reopened.close();
    },
  );
});

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DurableJournal,
  journalPartitionDirectory,
  type DurableJournalOptions,
  type JournalRecord,
  type JournalRecoveryState,
} from "./index.js";

interface JournalPreparationReceipt {
  fingerprint: string;
  preparationIdentity: string;
  virtual: boolean;
  deferredRepair: null | {
    kind: "discard_unacknowledged_append";
    discardedBytes: number;
  };
}

interface PreparedJournal extends DurableJournal {
  preparation(): JournalPreparationReceipt;
  revalidatePreparation(): void;
  activatePrepared(): void;
}

function prepareJournal(options: DurableJournalOptions): PreparedJournal {
  const prepare = (
    DurableJournal as unknown as {
      prepare(options: DurableJournalOptions): PreparedJournal;
    }
  ).prepare;
  return prepare(options);
}

let root: string;

beforeEach(() => {
  // `.native` matters on Windows: the plain resolver keeps the 8.3 short
  // form of %TEMP% (`RUNNER~1`), which the daemon's canonical-directory
  // guard rightly refuses.
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "claudexor-journal-prepare-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function treeReceipt(path: string): string {
  const hash = createHash("sha256");
  const visit = (entryPath: string, relative: string): void => {
    if (!existsSync(entryPath)) {
      hash.update(`missing\0${relative}\0`);
      return;
    }
    const stat = lstatSync(entryPath, { bigint: true });
    hash.update(
      `${relative}\0${stat.mode}\0${stat.uid}\0${stat.gid}\0${stat.nlink}\0${stat.size}\0${stat.mtimeNs}\0${stat.ctimeNs}\0`,
    );
    if (stat.isFile()) hash.update(readFileSync(entryPath));
    if (stat.isDirectory()) {
      for (const name of readdirSync(entryPath).sort()) {
        visit(join(entryPath, name), relative ? `${relative}/${name}` : name);
      }
    }
  };
  visit(path, "");
  return hash.digest("hex");
}

function preparedState(value: PreparedJournal): {
  state: JournalRecoveryState;
  records: JournalRecord[];
  receipt: JournalPreparationReceipt;
} {
  return { state: value.state(), records: value.records(), receipt: value.preparation() };
}

describe("DurableJournal read-only preparation", () => {
  it("keeps a missing registered partition virtual until explicit activation", () => {
    const journalRoot = join(root, "journal");
    const partitionDir = journalPartitionDirectory(journalRoot, "project:missing");
    const before = treeReceipt(root);

    const prepared = prepareJournal({ rootDir: journalRoot, partition: "project:missing" });
    expect(preparedState(prepared)).toMatchObject({
      state: { status: "ready" },
      records: [],
      receipt: { virtual: true, deferredRepair: null },
    });
    expect(existsSync(journalRoot)).toBe(false);
    expect(existsSync(partitionDir)).toBe(false);
    expect(treeReceipt(root)).toBe(before);

    prepared.revalidatePreparation();
    expect(treeReceipt(root)).toBe(before);
    prepared.activatePrepared();
    expect(existsSync(partitionDir)).toBe(true);
    expect(prepared.state().status).toBe("ready");
    prepared.close();
  });

  it("matches normal reopen compaction when a prepared journal is promoted", () => {
    const seed = (journalRoot: string): number => {
      const journal = new DurableJournal({
        rootDir: journalRoot,
        partition: "global",
        now: () => new Date("2026-08-13T00:00:00.000Z"),
        epochFactory: () => "seed-epoch",
      });
      for (let index = 0; index < 100; index += 1) {
        journal.append("probe.saved", { index, repeated: "same-value".repeat(20) });
      }
      const bytes = journal.physicalBytes();
      journal.close();
      return bytes;
    };
    const normalRoot = join(root, "normal");
    const preparedRoot = join(root, "prepared");
    const normalBefore = seed(normalRoot);
    const preparedBefore = seed(preparedRoot);

    const normal = new DurableJournal({
      rootDir: normalRoot,
      partition: "global",
      compactionThresholdBytes: 1,
      now: () => new Date("2026-08-13T00:00:00.000Z"),
    });
    const promoted = prepareJournal({
      rootDir: preparedRoot,
      partition: "global",
      compactionThresholdBytes: 1,
      now: () => new Date("2026-08-13T00:00:00.000Z"),
    });
    expect(promoted.physicalBytes()).toBe(preparedBefore);
    promoted.activatePrepared();

    expect(normal.physicalBytes()).toBeLessThan(normalBefore);
    expect(promoted.physicalBytes()).toBeLessThan(preparedBefore);
    expect(promoted.physicalBytes()).toBe(normal.physicalBytes());
    expect(promoted.records().map(({ type, payload }) => ({ type, payload }))).toEqual(
      normal.records().map(({ type, payload }) => ({ type, payload })),
    );
    normal.close();
    promoted.close();
  });

  it("keeps only a compact receipt alongside a prepared large logical history", () => {
    const journalRoot = join(root, "large-history");
    const logicalRecordCount = 20_000;
    const seeded = new DurableJournal({ rootDir: journalRoot, partition: "global" });
    seeded.appendBatch(
      Array.from({ length: logicalRecordCount }, (_, index) => ({
        type: "grown.history",
        payload: { index, repeated: "same-value" },
      })),
    );
    expect(seeded.compact()).toMatchObject({ records: logicalRecordCount });
    seeded.close();

    const prepared = prepareJournal({ rootDir: journalRoot, partition: "global" });
    const receiptBefore = prepared.preparation();
    expect(prepared.records()).toHaveLength(logicalRecordCount);
    expect(Object.keys(receiptBefore).sort()).toEqual([
      "deferredRepair",
      "fingerprint",
      "preparationIdentity",
      "virtual",
    ]);
    expect(JSON.stringify(receiptBefore).length).toBeLessThan(384);
    prepared.activatePrepared();
    expect(prepared.records()).toHaveLength(logicalRecordCount);
    expect(prepared.preparation()).toEqual(receiptBefore);
    prepared.close();
  });

  it("defers an uncertain append repair without truncating, deleting intent, or appending a receipt", () => {
    const journalRoot = join(root, "journal");
    const seeded = new DurableJournal({ rootDir: journalRoot, partition: "global" });
    seeded.append("accepted", { value: 1 });
    seeded.close();
    const crashed = new DurableJournal({
      rootDir: journalRoot,
      partition: "global",
      appendAndSync: (fd, frame) => {
        writeSync(fd, frame, 0, 3);
        throw new Error("simulated uncertain append");
      },
    });
    expect(() => crashed.append("unacknowledged", { value: 2 })).toThrow(/uncertain/);
    const partitionDir = crashed.partitionDir;
    crashed.close();
    const before = treeReceipt(partitionDir);

    const prepared = prepareJournal({ rootDir: journalRoot, partition: "global" });
    expect(preparedState(prepared)).toMatchObject({
      state: { status: "ready" },
      records: [{ type: "accepted", payload: { value: 1 } }],
      receipt: {
        virtual: false,
        deferredRepair: { kind: "discard_unacknowledged_append", discardedBytes: 3 },
      },
    });
    expect(treeReceipt(partitionDir)).toBe(before);
    expect(existsSync(join(partitionDir, "append.pending.json"))).toBe(true);
    prepared.revalidatePreparation();
    prepared.activatePrepared();
    expect(existsSync(join(partitionDir, "append.pending.json"))).toBe(false);
    expect(prepared.records().map((record) => record.type)).toEqual([
      "accepted",
      "journal.recovery_tail_discarded",
    ]);
    prepared.close();
  });

  it("reports corrupt and non-private input without changing bytes or permissions", () => {
    const journalRoot = join(root, "journal");
    const seeded = new DurableJournal({ rootDir: journalRoot, partition: "global" });
    seeded.append("accepted", { value: 1 });
    const path = seeded.path;
    const partitionDir = seeded.partitionDir;
    seeded.close();
    const bytes = readFileSync(path);
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    rmSync(path);
    const fd = openSync(path, "wx", 0o600);
    writeFileSync(fd, bytes);
    closeSync(fd);
    chmodSync(path, 0o640);
    const before = treeReceipt(partitionDir);
    const mode = statSync(path).mode & 0o777;

    const prepared = prepareJournal({ rootDir: journalRoot, partition: "global" });
    expect(prepared.state().status).toBe("recovery_required");
    expect(treeReceipt(partitionDir)).toBe(before);
    expect(statSync(path).mode & 0o777).toBe(mode);
    prepared.close();
  });

  it("fails closed before activation when any prepared byte changes", () => {
    const journalRoot = join(root, "journal");
    const seeded = new DurableJournal({ rootDir: journalRoot, partition: "global" });
    seeded.append("accepted", { value: 1 });
    const path = seeded.path;
    seeded.close();

    const prepared = prepareJournal({ rootDir: journalRoot, partition: "global" });
    const fd = openSync(path, "a");
    writeFileSync(fd, Buffer.from([0]));
    closeSync(fd);
    const changed = treeReceipt(prepared.partitionDir);

    expect(() => prepared.revalidatePreparation()).toThrow(/changed since read-only preparation/);
    expect(() => prepared.activatePrepared()).toThrow(/changed since read-only preparation/);
    expect(treeReceipt(prepared.partitionDir)).toBe(changed);
    prepared.close();
  });

  it("treats an existing non-directory partition path as recovery-required without writes", () => {
    for (const kind of ["regular", "symlink"] as const) {
      const journalRoot = join(root, `non-directory-${kind}`);
      const partitionDir = journalPartitionDirectory(journalRoot, "global");
      mkdirSync(journalRoot, { mode: 0o700 });
      if (kind === "regular") {
        writeFileSync(partitionDir, "partition-sentinel", { mode: 0o600 });
      } else {
        const outside = join(root, `outside-${kind}`);
        mkdirSync(outside, { mode: 0o700 });
        writeFileSync(join(outside, "sentinel"), "outside-sentinel", { mode: 0o600 });
        symlinkSync(outside, partitionDir);
      }
      const before = treeReceipt(root);

      const prepared = prepareJournal({ rootDir: journalRoot, partition: "global" });
      expect(prepared.state()).toMatchObject({ status: "recovery_required" });
      expect(() => prepared.activatePrepared()).toThrow(/requires recovery/);
      expect(treeReceipt(root)).toBe(before);
      prepared.close();
    }
  });

  it.runIf(process.platform !== "win32")(
    "treats a FIFO partition path as recovery-required without opening it",
    () => {
      const journalRoot = join(root, "fifo-partition");
      const partitionDir = journalPartitionDirectory(journalRoot, "global");
      mkdirSync(journalRoot, { mode: 0o700 });
      execFileSync("mkfifo", [partitionDir]);
      const before = treeReceipt(root);

      const prepared = prepareJournal({ rootDir: journalRoot, partition: "global" });
      expect(prepared.state()).toMatchObject({ status: "recovery_required" });
      expect(() => prepared.activatePrepared()).toThrow(/requires recovery/);
      expect(treeReceipt(root)).toBe(before);
      prepared.close();
    },
  );

  it("rejects non-private trusted roots, journal roots, and partitions without tightening modes", () => {
    for (const target of ["trusted-root", "root", "partition"] as const) {
      const daemonRoot = join(root, `public-${target}`);
      let journalRoot = daemonRoot;
      mkdirSync(daemonRoot, { mode: 0o700 });
      if (target === "trusted-root") journalRoot = join(daemonRoot, "journal");
      const partitionDir = journalPartitionDirectory(journalRoot, "global");
      if (target === "partition") mkdirSync(partitionDir, { mode: 0o700 });
      const unsafePath =
        target === "trusted-root" ? daemonRoot : target === "root" ? journalRoot : partitionDir;
      chmodSync(unsafePath, 0o755);
      const before = treeReceipt(root);

      const prepared = prepareJournal({ rootDir: journalRoot, partition: "global" });
      expect(prepared.state()).toMatchObject({ status: "recovery_required" });
      expect(() => prepared.activatePrepared()).toThrow(/requires recovery/);
      expect(treeReceipt(root)).toBe(before);
      expect(statSync(unsafePath).mode & 0o777).toBe(0o755);
      prepared.close();
    }
  });

  it.runIf(typeof process.getuid === "function")(
    "reports a foreign-owned root through a privilege-free uid observation",
    () => {
      const journalRoot = join(root, "foreign-owner");
      mkdirSync(journalRoot, { mode: 0o700 });
      const actualUid = process.getuid!();
      const uid = vi.spyOn(process, "getuid").mockReturnValue(actualUid + 1);
      try {
        const prepared = prepareJournal({ rootDir: journalRoot, partition: "global" });
        expect(prepared.state()).toMatchObject({ status: "recovery_required" });
        expect(() => prepared.activatePrepared()).toThrow(/requires recovery/);
        prepared.close();
      } finally {
        uid.mockRestore();
      }
      expect(statSync(journalRoot).uid).toBe(actualUid);
    },
  );

  it("rejects a symlinked root ancestor without reading or writing the outside tree", () => {
    for (const kind of ["root", "ancestor"] as const) {
      const outside = join(root, `outside-journal-${kind}`);
      mkdirSync(outside, { mode: 0o700 });
      writeFileSync(join(outside, "sentinel"), "outside-sentinel", { mode: 0o600 });
      const link = join(root, `journal-${kind}-link`);
      let journalRoot = link;
      if (kind === "ancestor") {
        mkdirSync(join(outside, "journal"), { mode: 0o700 });
        journalRoot = join(link, "journal");
      }
      symlinkSync(outside, link);
      const before = treeReceipt(root);

      const prepared = prepareJournal({ rootDir: journalRoot, partition: "global" });
      expect(prepared.state()).toMatchObject({ status: "recovery_required" });
      expect(() => prepared.activatePrepared()).toThrow(/requires recovery/);
      expect(treeReceipt(root)).toBe(before);
      expect(readFileSync(join(outside, "sentinel"), "utf8")).toBe("outside-sentinel");
      prepared.close();
    }
  });

  it("detects a byte-identical partition-root replacement by path identity", () => {
    const journalRoot = join(root, "identity-replacement");
    const seeded = new DurableJournal({ rootDir: journalRoot, partition: "global" });
    seeded.append("accepted", { value: 1 });
    const partitionDir = seeded.partitionDir;
    const journalBytes = readFileSync(seeded.path);
    seeded.close();
    const prepared = prepareJournal({ rootDir: journalRoot, partition: "global" });
    renameSync(partitionDir, `${partitionDir}.original`);
    mkdirSync(partitionDir, { mode: 0o700 });
    writeFileSync(join(partitionDir, "journal.bin"), journalBytes, { mode: 0o600 });
    const replacement = treeReceipt(partitionDir);

    expect(() => prepared.revalidatePreparation()).toThrow(/changed since read-only preparation/);
    expect(() => prepared.activatePrepared()).toThrow(/requires recovery/);
    expect(treeReceipt(partitionDir)).toBe(replacement);
    prepared.close();
  });

  it("addresses partition entries with the platform separator, not a literal slash", () => {
    // A `${dir}/${name}` key never matched the `join()`-built path callers look
    // up on Windows, so a reopened daemon read the journal as missing and
    // demanded recovery. Proven here by the receipt: the walker must see the
    // journal bytes it just wrote.
    const journalRoot = join(root, "separator");
    const seeded = new DurableJournal({ rootDir: journalRoot, partition: "global" });
    seeded.append("accepted", { value: 1 });
    seeded.close();

    const prepared = prepareJournal({ rootDir: journalRoot, partition: "global" });
    expect(preparedState(prepared)).toMatchObject({
      state: { status: "ready" },
      records: [expect.objectContaining({ type: "accepted" })],
      receipt: { virtual: false, deferredRepair: null },
    });
    prepared.close();
  });

  it("contains traversal-like partition ids inside the journal root", () => {
    const journalRoot = join(root, "traversal-journal");
    const outside = join(root, "outside-partition");
    const prepared = prepareJournal({ rootDir: journalRoot, partition: "../../outside-partition" });

    expect(prepared.partitionDir.startsWith(`${journalRoot}/`)).toBe(true);
    expect(existsSync(outside)).toBe(false);
    prepared.activatePrepared();
    expect(existsSync(prepared.partitionDir)).toBe(true);
    expect(existsSync(outside)).toBe(false);
    prepared.close();
  });

  it("closes and poisons a direct prepared writer when post-open replay fails", () => {
    const journalRoot = join(root, "direct-writer-cleanup");
    const seeded = new DurableJournal({ rootDir: journalRoot, partition: "global" });
    seeded.append("accepted", { value: 1 });
    seeded.close();
    const prepared = prepareJournal({ rootDir: journalRoot, partition: "global" });
    const originalRevalidate = prepared.revalidatePreparation.bind(prepared);
    prepared.revalidatePreparation = () => {
      originalRevalidate();
      const fd = openSync(prepared.path, "a");
      try {
        writeSync(fd, Buffer.from([0]));
      } finally {
        closeSync(fd);
      }
    };

    expect(() => prepared.activatePrepared()).toThrow(/requires recovery/);
    const internals = prepared as unknown as { fd: number; writable: boolean };
    expect(internals.fd).toBe(-1);
    expect(internals.writable).toBe(false);
    expect(prepared.state()).toMatchObject({ status: "recovery_required" });
    expect(() => prepared.activatePrepared()).toThrow(/requires recovery/);
    expect(() => prepared.append("must-not-write", {})).toThrow(/requires recovery/);
    prepared.close();
  });
});

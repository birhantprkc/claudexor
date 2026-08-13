import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DurableJournal,
  journalPartitionDirectory,
  type DurableJournalOptions,
  type JournalRecord,
  type JournalRecoveryState,
} from "./index.js";

interface JournalPreparationReceipt {
  fingerprint: string;
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
  root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-journal-prepare-")));
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
      "journal.recovery_discarded_append",
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
});

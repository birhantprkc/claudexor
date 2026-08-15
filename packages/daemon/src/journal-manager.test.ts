import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DurableJournal, JournalCursorError } from "@claudexor/journal";
import { JournalManager } from "./journal-manager.js";
import { fingerprintPartition } from "./journal-recovery-files.js";

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-journal-manager-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function registerProbe(manager: JournalManager, name = "probe") {
  return manager.registerProjection({
    name,
    create: (journal) => ({ journal }),
    validate: ({ journal }) => {
      journal.records();
    },
  });
}

function corruptFirstByte(path: string): Buffer {
  const bytes = readFileSync(path);
  bytes[0] = (bytes[0] ?? 0) ^ 0xff;
  writeFileSync(path, bytes, { mode: 0o600 });
  return bytes;
}

function seedCorruptPartition(partition = "global") {
  const first = new JournalManager(root, { partition });
  const slot = registerProbe(first);
  first.start();
  slot.current().journal.append("probe.saved", { value: 1 });
  const journalPath = slot.current().journal.path;
  first.close();
  return { journalPath, corruptBytes: corruptFirstByte(journalPath) };
}

function recoveryOperationsDir(manager: JournalManager): string {
  return join(manager.rootDir, "recovery-operations", basename(manager.partitionDir));
}

function treeReceipt(path: string): { bytes: Buffer; mode: number } {
  return { bytes: readFileSync(path), mode: statSync(path).mode & 0o777 };
}

interface StoredOperation {
  status: "prepared" | "completed";
  quarantinePath: string;
  receipt: unknown;
}

function storedOperation(): StoredOperation {
  const operationsRoot = join(root, "recovery-operations");
  const partitionDirs = readdirSync(operationsRoot);
  if (partitionDirs.length !== 1) {
    throw new Error(`expected one recovery partition, found ${partitionDirs.length}`);
  }
  const dir = join(operationsRoot, partitionDirs[0]!);
  const names = readdirSync(dir).filter((name) => name.endsWith(".json"));
  if (names.length !== 1) throw new Error(`expected one recovery operation, found ${names.length}`);
  return JSON.parse(readFileSync(join(dir, names[0]!), "utf8")) as StoredOperation;
}

describe("JournalManager", () => {
  it("projects durable events behind opaque partition cursors", () => {
    const manager = new JournalManager(root, { partition: "project:events" });
    const slot = registerProbe(manager);
    manager.start();
    slot.current().journal.append("probe.first", { value: 1 });
    slot.current().journal.append("probe.second", { value: 2 });
    const events = manager.events();
    expect(events.map((event) => [event.partition, event.type])).toEqual([
      ["project:events", "probe.first"],
      ["project:events", "probe.second"],
    ]);
    expect(manager.events(events[0]!.cursor).map((event) => event.type)).toEqual(["probe.second"]);
    manager.close();
  });

  it("isolates recovery and projection availability by partition", () => {
    const partitions = ["global", "project:a", "project:b"] as const;
    const seeded = partitions.map((partition) => {
      const manager = new JournalManager(root, { partition });
      const slot = registerProbe(manager);
      expect(manager.start().partition).toBe(partition);
      slot.current().journal.append("probe.saved", { partition });
      const path = slot.current().journal.path;
      manager.close();
      return { partition, path };
    });
    corruptFirstByte(seeded[1]!.path);

    const reopened = partitions.map((partition) => {
      const manager = new JournalManager(root, { partition });
      const slot = registerProbe(manager);
      return { partition, manager, slot, inspection: manager.start() };
    });
    expect(reopened[0]!.inspection.status).toBe("ready");
    expect(reopened[1]!.inspection.status).toBe("recovery_required");
    expect(reopened[2]!.inspection.status).toBe("ready");
    expect(() => reopened[1]!.slot.current()).toThrow(/requires recovery/);
    for (const entry of [reopened[0]!, reopened[2]!]) {
      expect(entry.slot.current().journal.records()).toHaveLength(1);
      entry.slot.current().journal.append("probe.after_reopen", { partition: entry.partition });
    }
    for (const entry of reopened) entry.manager.close();
  });

  it("owns one writer, seals registration, and validates every projection", () => {
    const manager = new JournalManager(root, {
      now: () => new Date("2026-07-14T00:00:00.000Z"),
    });
    const first = registerProbe(manager, "first");
    const second = registerProbe(manager, "second");
    expect(manager.start().status).toBe("ready");
    expect(first.current().journal).toBe(second.current().journal);
    expect(first.generation()).toBe(1);
    expect(manager.validate().projectionStatus.every((row) => row.status === "valid")).toBe(true);
    expect(() => registerProbe(manager, "late")).toThrow(/registration is closed/);
    manager.close();
  });

  it("fails closed and revokes the writer when prepared projection activation throws", () => {
    const manager = new JournalManager(root, {
      faults: {
        beforeProjectionActivation: () => {
          throw new Error("simulated projection activation failure");
        },
      },
    });
    const slot = registerProbe(manager);
    expect(manager.prepare().inspection.status).toBe("ready");
    const preparedProjection = slot.prepared();

    expect(() => manager.activatePrepared()).toThrow(/requires recovery/);
    expect(manager.inspect().status).toBe("recovery_required");
    expect(manager.ready()).toBe(false);
    expect(() => slot.current()).toThrow(/requires recovery/);
    expect(() => preparedProjection.journal.append("probe", {})).toThrow(/closed/);
    manager.close();
  });

  it("turns a disappeared prepared partition into recovery without recreating it", () => {
    const seeded = new DurableJournal({ rootDir: join(root, "journal"), partition: "global" });
    seeded.append("probe.saved", { value: 1 });
    const original = seeded.partitionDir;
    const bytes = readFileSync(seeded.path);
    seeded.close();
    const manager = new JournalManager(root);
    registerProbe(manager);
    expect(manager.prepare().inspection.status).toBe("ready");
    const moved = `${original}.moved`;
    renameSync(original, moved);

    expect(() => manager.revalidatePreparation()).toThrow(/requires recovery/);
    expect(() => manager.activatePrepared()).toThrow(/requires recovery/);
    expect(manager.inspect().status).toBe("recovery_required");
    expect(existsSync(original)).toBe(false);
    expect(readFileSync(join(moved, "journal.bin"))).toEqual(bytes);
    manager.close();
  });

  it("turns a pathname replacement race into recovery without touching replacement bytes", () => {
    const seeded = new DurableJournal({ rootDir: join(root, "journal"), partition: "global" });
    seeded.append("probe.saved", { value: 1 });
    const original = seeded.partitionDir;
    const originalBytes = readFileSync(seeded.path);
    seeded.close();
    const manager = new JournalManager(root);
    registerProbe(manager);
    expect(manager.prepare().inspection.status).toBe("ready");
    renameSync(original, `${original}.original`);
    mkdirSync(original, { mode: 0o700 });
    writeFileSync(join(original, "journal.bin"), originalBytes, { mode: 0o600 });

    expect(manager.validate()).toMatchObject({
      status: "recovery_required",
      projectionStatus: [expect.objectContaining({ name: "probe", status: "invalid" })],
    });
    expect(() => manager.activatePrepared()).toThrow(/requires recovery/);
    expect(manager.inspect().status).toBe("recovery_required");
    expect(readFileSync(join(original, "journal.bin"))).toEqual(originalBytes);
    manager.close();
  });

  it("rejects unsafe recovery-operation roots and ancestors without following or mutating them", () => {
    for (const kind of [
      "regular",
      "symlink",
      "public",
      "public-ancestor",
      "symlink-ancestor",
    ] as const) {
      const caseRoot = join(root, `unsafe-operations-${kind}`);
      mkdirSync(caseRoot, { mode: 0o700 });
      const manager = new JournalManager(caseRoot);
      registerProbe(manager);
      const sentinel = join(caseRoot, "no-write-sentinel");
      writeFileSync(sentinel, "must-stay-byte-identical", { mode: 0o640 });
      const sentinelBefore = treeReceipt(sentinel);
      const operationsDir = recoveryOperationsDir(manager);
      const operationsParent = join(caseRoot, "recovery-operations");
      const outside = join(root, `unsafe-operations-outside-${kind}`);
      mkdirSync(outside, { mode: 0o700 });
      writeFileSync(join(outside, "sentinel"), "outside-sentinel", { mode: 0o600 });
      if (kind === "symlink-ancestor") {
        symlinkSync(outside, operationsParent);
        mkdirSync(join(outside, basename(operationsDir)), { mode: 0o700 });
      } else {
        mkdirSync(operationsParent, { mode: 0o700 });
        if (kind === "regular") writeFileSync(operationsDir, "not-a-directory", { mode: 0o600 });
        if (kind === "symlink") symlinkSync(outside, operationsDir);
        if (kind === "public") {
          mkdirSync(operationsDir, { mode: 0o700 });
          chmodSync(operationsDir, 0o755);
        }
        if (kind === "public-ancestor") chmodSync(operationsParent, 0o755);
      }
      const outsideBefore = readFileSync(join(outside, "sentinel"));

      expect(manager.prepare()).toMatchObject({
        inspection: { status: "recovery_required" },
      });
      expect(() => manager.activatePrepared()).toThrow(/requires recovery/);
      expect(readFileSync(join(outside, "sentinel"))).toEqual(outsideBefore);
      expect(treeReceipt(sentinel)).toEqual(sentinelBefore);
      if (kind === "regular") expect(readFileSync(operationsDir, "utf8")).toBe("not-a-directory");
      if (kind === "public") expect(statSync(operationsDir).mode & 0o777).toBe(0o755);
      if (kind === "public-ancestor") {
        expect(statSync(operationsParent).mode & 0o777).toBe(0o755);
      }
      manager.close();
    }
  });

  it.runIf(process.platform !== "win32")(
    "rejects a FIFO recovery-operation root without opening or replacing it",
    () => {
      const caseRoot = join(root, "unsafe-operations-fifo");
      mkdirSync(caseRoot, { mode: 0o700 });
      const manager = new JournalManager(caseRoot);
      registerProbe(manager);
      const sentinel = join(caseRoot, "no-write-sentinel");
      writeFileSync(sentinel, "must-stay-byte-identical", { mode: 0o640 });
      const sentinelBefore = treeReceipt(sentinel);
      const operationsDir = recoveryOperationsDir(manager);
      mkdirSync(join(caseRoot, "recovery-operations"), { mode: 0o700 });
      execFileSync("mkfifo", [operationsDir]);

      expect(manager.prepare()).toMatchObject({
        inspection: { status: "recovery_required" },
      });
      expect(() => manager.activatePrepared()).toThrow(/requires recovery/);
      expect(statSync(operationsDir).isFIFO()).toBe(true);
      expect(treeReceipt(sentinel)).toEqual(sentinelBefore);
      manager.close();
    },
  );

  it("keeps a still-prepared sibling partition valid across another partition's quarantine (S2-CR1)", () => {
    // Mixed root: healthy global (prepared, still-prepared at quarantine
    // time) + corrupt project. The FIRST quarantine on a root creates the
    // shared recovery-operations/ parent; that daemon-owned infrastructure
    // write must not poison the sibling's read-only preparation identity.
    const global = new JournalManager(root);
    const globalSlot = registerProbe(global);
    global.start();
    globalSlot.current().journal.append("probe.saved", { partition: "global" });
    global.close();
    seedCorruptPartition("project:victim");

    const preparedGlobal = new JournalManager(root);
    registerProbe(preparedGlobal);
    expect(preparedGlobal.prepare().inspection.status).toBe("ready");
    const project = new JournalManager(root, { partition: "project:victim" });
    registerProbe(project);
    const projectInspection = project.prepare().inspection;
    expect(projectInspection.status).toBe("recovery_required");

    const receipt = project.quarantineAndStartFresh({
      idempotencyKey: "recover-project-victim",
      expectedFingerprint: projectInspection.fingerprint,
      confirmation: "quarantine_and_start_fresh",
    });
    expect(receipt.partition).toBe("project:victim");
    expect(project.inspect().status).toBe("ready");

    // The sibling's preparation must still revalidate and activate.
    preparedGlobal.revalidatePreparation();
    preparedGlobal.activatePrepared();
    expect(preparedGlobal.ready()).toBe(true);
    expect(preparedGlobal.inspect().status).toBe("ready");
    project.close();
    preparedGlobal.close();
  });

  it("still fails revalidation when the shared recovery-operations parent appears TAMPERED (S2-CR1)", () => {
    // The quarantine-infrastructure exemption is existence-only: a shared
    // parent that appears with a non-private mode (or as a symlink) after
    // read-only preparation is genuine ancestry tampering and must still
    // fail closed.
    for (const kind of ["public", "symlink"] as const) {
      const caseRoot = join(root, `tampered-shared-parent-${kind}`);
      mkdirSync(caseRoot, { mode: 0o700 });
      const manager = new JournalManager(caseRoot);
      registerProbe(manager);
      expect(manager.prepare().inspection.status).toBe("ready");
      const operationsParent = join(caseRoot, "recovery-operations");
      if (kind === "public") {
        mkdirSync(operationsParent, { mode: 0o755 });
      } else {
        const outside = join(root, `tampered-shared-parent-outside-${kind}`);
        mkdirSync(outside, { mode: 0o700 });
        symlinkSync(outside, operationsParent);
      }

      expect(() => manager.revalidatePreparation()).toThrow(/requires recovery/);
      expect(manager.inspect().status).toBe("recovery_required");
      manager.close();
    }
  });

  it("binds prepared recovery-operation input to its pathname identity", () => {
    const caseRoot = join(root, "operations-identity-replacement");
    mkdirSync(caseRoot, { mode: 0o700 });
    const manager = new JournalManager(caseRoot);
    registerProbe(manager);
    const operationsDir = recoveryOperationsDir(manager);
    mkdirSync(join(caseRoot, "recovery-operations"), { mode: 0o700 });
    mkdirSync(operationsDir, { mode: 0o700 });
    expect(manager.prepare()).toMatchObject({ inspection: { status: "ready" } });
    const contentFingerprint = fingerprintPartition(operationsDir, caseRoot).fingerprint;
    renameSync(operationsDir, `${operationsDir}.original`);
    mkdirSync(operationsDir, { mode: 0o700 });

    expect(fingerprintPartition(operationsDir, caseRoot).fingerprint).toBe(contentFingerprint);
    expect(() => manager.revalidatePreparation()).toThrow(/requires recovery/);
    expect(() => manager.activatePrepared()).toThrow(/requires recovery/);
    expect(manager.inspect().status).toBe("recovery_required");
    expect(readdirSync(operationsDir)).toEqual([]);
    manager.close();
  });

  it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)(
    "reports an unreadable partition as recovery instead of throwing from fingerprinting",
    () => {
      const seeded = new DurableJournal({ rootDir: join(root, "journal"), partition: "global" });
      seeded.append("probe.saved", { value: 1 });
      const path = seeded.path;
      const partitionDir = seeded.partitionDir;
      const bytes = readFileSync(path);
      seeded.close();
      chmodSync(partitionDir, 0o000);
      const manager = new JournalManager(root);
      registerProbe(manager);
      try {
        expect(manager.prepare()).toMatchObject({
          inspection: { status: "recovery_required" },
        });
        expect(() => manager.activatePrepared()).toThrow(/requires recovery/);
      } finally {
        chmodSync(partitionDir, 0o700);
      }
      expect(readFileSync(path)).toEqual(bytes);
      expect(manager.inspect().status).toBe("recovery_required");
      manager.close();
    },
  );

  it("keeps inspect, validate and secret-safe export online without mutating corrupt bytes", () => {
    const { journalPath, corruptBytes } = seedCorruptPartition();
    const mode = statSync(journalPath).mode & 0o777;
    const manager = new JournalManager(root, {
      now: () => new Date("2026-07-14T01:00:00.000Z"),
    });
    registerProbe(manager);
    const inspection = manager.start();
    expect(inspection.status).toBe("recovery_required");
    expect(manager.validate().projectionStatus).toEqual([
      expect.objectContaining({ name: "probe", status: "invalid" }),
    ]);

    const outside = join(root, "outside-secret");
    writeFileSync(outside, "secret-sentinel", { mode: 0o640 });
    symlinkSync(outside, join(manager.partitionDir, "unknown-link"));
    linkSync(outside, join(manager.partitionDir, "unknown-hardlink"));
    const exported = manager.exportRecovery();
    const manifest = JSON.parse(
      readFileSync(join(exported.bundlePath, "manifest.json"), "utf8"),
    ) as { entries: Array<{ name: string; copiedAs: string | null }> };
    expect(manifest.entries.find((row) => row.name === "unknown-link")?.copiedAs).toBeNull();
    expect(manifest.entries.find((row) => row.name === "unknown-hardlink")?.copiedAs).toBeNull();
    expect(readFileSync(outside, "utf8")).toBe("secret-sentinel");
    expect(statSync(outside).mode & 0o777).toBe(0o640);
    expect(readFileSync(journalPath)).toEqual(corruptBytes);
    expect(statSync(journalPath).mode & 0o777).toBe(mode);
    manager.close();
  });

  it("quarantines by fingerprint, rebinds a fresh epoch, and replays idempotently", () => {
    const first = new JournalManager(root);
    const firstSlot = registerProbe(first);
    first.start();
    const oldJournal = firstSlot.current().journal;
    oldJournal.append("probe.saved", { value: 1 });
    const oldCursor = oldJournal.currentCursor();
    const path = oldJournal.path;
    first.close();
    corruptFirstByte(path);

    const manager = new JournalManager(root);
    const slot = registerProbe(manager);
    const inspection = manager.start();
    const request = {
      idempotencyKey: "recover-global-once",
      expectedFingerprint: inspection.fingerprint,
      confirmation: "quarantine_and_start_fresh" as const,
    };
    expect(manager.preflightQuarantine(request)).toEqual({ disposition: "new", receipt: null });
    const receipt = manager.quarantineAndStartFresh(request);
    expect(receipt.previousFingerprint).toBe(inspection.fingerprint);
    expect(manager.inspect().status).toBe("ready");
    expect(slot.generation()).toBe(2);
    expect(
      slot
        .current()
        .journal.records()
        .map((record) => record.type),
    ).toEqual(["journal.partition_quarantined"]);
    expect(() => slot.current().journal.sequenceAfter(oldCursor)).toThrow(JournalCursorError);
    expect(manager.quarantineAndStartFresh(request)).toEqual(receipt);
    expect(() =>
      manager.quarantineAndStartFresh({ ...request, expectedFingerprint: "0".repeat(64) }),
    ).toThrow(/idempotency conflict/);
    manager.close();
  });

  it("reports the exact project partition in export and quarantine receipts", () => {
    const partition = "project:alpha";
    const { journalPath } = seedCorruptPartition(partition);
    const manager = new JournalManager(root, { partition });
    registerProbe(manager);
    const inspection = manager.start();
    expect(inspection.partition).toBe(partition);
    const exported = manager.exportRecovery();
    expect(exported.partition).toBe(partition);
    const manifest = JSON.parse(
      readFileSync(join(exported.bundlePath, "manifest.json"), "utf8"),
    ) as { partition: string };
    expect(manifest.partition).toBe(partition);
    const receipt = manager.quarantineAndStartFresh({
      idempotencyKey: "recover-project-alpha",
      expectedFingerprint: inspection.fingerprint,
      confirmation: "quarantine_and_start_fresh",
    });
    expect(receipt.partition).toBe(partition);
    expect(receipt.quarantinePath).not.toContain("global-");
    expect(existsSync(journalPath)).toBe(true);
    manager.close();
  });

  it.each([
    ["healthy partition", "ready", "f".repeat(64), "only a corrupt partition"],
    ["stale fingerprint", "corrupt", "0".repeat(64), "fingerprint mismatch"],
  ])(
    "rejects %s before creating recovery operation state",
    (_name, state, fingerprint, message) => {
      const manager = new JournalManager(root);
      registerProbe(manager);
      if (state === "corrupt") seedCorruptPartition();
      manager.start();
      expect(() =>
        manager.preflightQuarantine({
          idempotencyKey: "preflight",
          expectedFingerprint: fingerprint,
          confirmation: "quarantine_and_start_fresh",
        }),
      ).toThrow(message);
      expect(existsSync(join(root, "recovery-operations"))).toBe(false);
      manager.close();
    },
  );

  it("finishes a prepared quarantine after a crash immediately after rename", () => {
    seedCorruptPartition();
    const crashing = new JournalManager(root, {
      faults: {
        afterQuarantineRename: () => {
          throw new Error("simulated crash after rename");
        },
      },
    });
    registerProbe(crashing);
    const inspection = crashing.start();
    expect(() =>
      crashing.quarantineAndStartFresh({
        idempotencyKey: "crash-after-rename",
        expectedFingerprint: inspection.fingerprint,
        confirmation: "quarantine_and_start_fresh",
      }),
    ).toThrow(/simulated crash/);
    expect(storedOperation().status).toBe("prepared");
    crashing.close();

    const resumed = new JournalManager(root);
    const slot = registerProbe(resumed);
    expect(resumed.prepare()).toMatchObject({
      inspection: { status: "ready" },
      virtual: true,
    });
    expect(storedOperation().status).toBe("prepared");
    resumed.revalidatePreparation();
    expect(storedOperation().status).toBe("prepared");
    resumed.activatePrepared();
    expect(
      slot
        .current()
        .journal.records()
        .map((record) => record.type),
    ).toEqual(["journal.partition_quarantined"]);
    expect(storedOperation().status).toBe("completed");
    resumed.close();
  });

  it("binds a durable fresh receipt after a crash before the completed marker", () => {
    seedCorruptPartition();
    const crashing = new JournalManager(root, {
      faults: {
        afterQuarantineReceipt: () => {
          throw new Error("simulated crash after receipt");
        },
      },
    });
    registerProbe(crashing);
    const inspection = crashing.start();
    expect(() =>
      crashing.quarantineAndStartFresh({
        idempotencyKey: "crash-after-receipt",
        expectedFingerprint: inspection.fingerprint,
        confirmation: "quarantine_and_start_fresh",
      }),
    ).toThrow(/simulated crash/);
    crashing.close();

    const resumed = new JournalManager(root);
    const slot = registerProbe(resumed);
    expect(resumed.prepare().inspection.status).toBe("ready");
    expect(storedOperation().status).toBe("prepared");
    resumed.revalidatePreparation();
    resumed.activatePrepared();
    expect(slot.current().journal.records()).toHaveLength(1);
    expect(storedOperation().status).toBe("completed");
    resumed.close();
  });

  it("fails closed when source and quarantine coexist without the exact receipt", () => {
    seedCorruptPartition();
    const crashing = new JournalManager(root, {
      faults: {
        afterQuarantineRename: () => {
          throw new Error("simulated crash");
        },
      },
    });
    registerProbe(crashing);
    const inspection = crashing.start();
    expect(() =>
      crashing.quarantineAndStartFresh({
        idempotencyKey: "ambiguous",
        expectedFingerprint: inspection.fingerprint,
        confirmation: "quarantine_and_start_fresh",
      }),
    ).toThrow(/simulated crash/);
    crashing.close();

    const rogue = new DurableJournal({ rootDir: join(root, "journal"), partition: "global" });
    rogue.append("rogue.record", { value: 1 });
    rogue.close();
    const restarted = new JournalManager(root);
    const slot = registerProbe(restarted);
    expect(restarted.prepare().inspection.status).toBe("recovery_required");
    expect(() => slot.current()).toThrow(/requires recovery/);
    restarted.close();
  });

  it("a FAILED archive rename leaves the partition open and re-archivable, not stranded closed (Ф2)", () => {
    const manager = new JournalManager(root, {
      partition: "project:archive-rename-fails",
      faults: {
        beforeArchiveRename: () => {
          throw new Error("simulated archive rename failure");
        },
      },
    });
    const slot = registerProbe(manager);
    manager.start();
    slot.current().journal.append("probe.saved", { value: 1 });
    const partitionDir = manager.partitionDir;

    // The rename fails; archivePartition rethrows.
    expect(() => manager.archivePartition()).toThrow(/archive rename failure/);
    // rename-THEN-close: the manager was NOT stranded closed — it reopened a
    // fresh generation and is still usable, with its directory still on disk.
    expect(manager.ready()).toBe(true);
    expect(existsSync(partitionDir)).toBe(true);
    slot.current().journal.append("probe.saved", { value: 2 });

    // A CLEAN retry (fault cleared) now archives and closes for good.
    const clean = new JournalManager(root, { partition: "project:archive-rename-fails" });
    registerProbe(clean);
    clean.start();
    const archived = clean.archivePartition();
    expect(typeof archived).toBe("string");
    expect(existsSync(archived as string)).toBe(true);
    expect(existsSync(partitionDir)).toBe(false);
    manager.close();
  });

  it("restoreArchivedPartition rolls an archived partition back into the active tree and reopens it (Ф2)", () => {
    const manager = new JournalManager(root, { partition: "project:restore-me" });
    const slot = registerProbe(manager);
    manager.start();
    slot.current().journal.append("probe.saved", { value: 7 });
    const partitionDir = manager.partitionDir;

    const archived = manager.archivePartition();
    expect(typeof archived).toBe("string");
    expect(existsSync(partitionDir)).toBe(false);

    // Roll back (the removeProject unregister-failure rollback path).
    manager.restoreArchivedPartition(archived as string);
    expect(existsSync(partitionDir)).toBe(true);
    expect(existsSync(archived as string)).toBe(false);
    // The manager is usable again after the reopen.
    expect(manager.ready()).toBe(true);
    slot.current().journal.records();
    manager.close();
  });
});

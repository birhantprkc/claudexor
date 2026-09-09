import { recoverJournal } from "./journal-recovery.js";
import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, lstatSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensureCanonicalPrivateDirectory, fsyncDirectory } from "@claudexor/util";
import { prepareAppendBatch } from "./append-batch.js";
import { ZERO_HASH, type JournalRecord } from "./frame-codec.js";
import { prepareJournalCompaction, type JournalCompactionResult } from "./journal-compaction.js";
import {
  prepareBackgroundCompaction,
  sameBoundary,
  type CompactionBoundary,
} from "./journal-background-compaction.js";
import {
  appendAndSync,
  ensurePrivateFile,
  sameJournalFile,
  openJournalWriter,
  reopenOriginalWriter,
  readIntent,
  removeFile,
  writeIntent,
} from "./journal-files.js";
import { sequenceAfterCursor, encodeCursor, JournalCursorError } from "./journal-cursor.js";
import { journalPartitionDirectory } from "./journal-partition.js";
import {
  fingerprintPreparedJournal,
  inspectPreparedJournal,
  type JournalPreparationReceipt,
  type PreparedJournalInspection,
} from "./read-only-preparation.js";
export type { JournalRecord, JournalPreparationReceipt };
export { JournalCursorError } from "./journal-cursor.js";
export { journalPartitionDirectory } from "./journal-partition.js";
export { JournalRecoveryRequiredError, JournalAppendUncertainError };
export type { JournalRecoveryLocation, JournalRecoveryState } from "./journal-recovery-state.js";
import {
  JournalRecoveryRequiredError,
  JournalAppendUncertainError,
  journalRecoveryAt,
  type JournalRecoveryState,
} from "./journal-recovery-state.js";
export interface DurableJournalOptions {
  rootDir: string;
  partition: string;
  now?: () => Date;
  epochFactory?: () => string;
  appendAndSync?: (fd: number, bytes: Buffer) => void;
  compactionThresholdBytes?: number;
  /** The daemon opts into after-admission maintenance; standalone callers keep inline compaction. */
  deferCompaction?: boolean;
}

const PREPARED_JOURNAL = Symbol("prepared-journal");

/** Single-writer, checksummed journal. A returned append has reached fsync. */
export class DurableJournal {
  readonly options: Readonly<DurableJournalOptions>;
  readonly partitionDir: string;
  readonly path: string;
  private readonly now: () => Date;
  private readonly appendFrame: (fd: number, bytes: Buffer) => void;
  private fd = -1;
  private entries: JournalRecord[] = [];
  private background: {
    controller: AbortController;
    promise: Promise<JournalCompactionResult["receipt"] | null>;
  } | null = null;
  private epoch: string;
  private nextSeq = 1;
  private previousFrameHash = ZERO_HASH;
  private knownFileBytes = 0;
  private recovery: JournalRecoveryState = { status: "ready", discardedTailBytes: 0 };
  private preparationState: JournalPreparationReceipt | null = null;
  private writable = false;
  private closed = false;

  static prepare(options: DurableJournalOptions): DurableJournal {
    if (!options.partition.trim()) throw new Error("journal partition must not be empty");
    const partitionDir = journalPartitionDirectory(options.rootDir, options.partition);
    const prepared = inspectPreparedJournal({
      rootDir: options.rootDir,
      partitionDir,
      journalPath: join(partitionDir, "journal.bin"),
      intentPath: join(partitionDir, "append.pending.json"),
      partition: options.partition,
      initialEpoch: (options.epochFactory ?? randomUUID)(),
    });
    const InternalJournal = DurableJournal as unknown as {
      new (
        value: DurableJournalOptions,
        token: typeof PREPARED_JOURNAL,
        inspection: PreparedJournalInspection,
      ): DurableJournal;
    };
    return new InternalJournal(options, PREPARED_JOURNAL, prepared);
  }

  constructor(options: DurableJournalOptions);
  constructor(
    options: DurableJournalOptions,
    token?: typeof PREPARED_JOURNAL,
    prepared?: PreparedJournalInspection,
  ) {
    if (!options.partition.trim()) throw new Error("journal partition must not be empty");
    this.options = Object.freeze({ ...options });
    this.now = options.now ?? (() => new Date());
    this.appendFrame = options.appendAndSync ?? appendAndSync;
    this.partitionDir = journalPartitionDirectory(options.rootDir, options.partition);
    this.path = join(this.partitionDir, "journal.bin");
    if (token === PREPARED_JOURNAL && prepared) {
      this.preparationState = prepared.receipt;
      this.recovery = structuredClone(prepared.recovery);
      for (const record of prepared.records) this.entries.push(record);
      this.epoch = prepared.epoch;
      this.nextSeq = prepared.nextSeq;
      this.previousFrameHash = prepared.previousFrameHash;
      this.knownFileBytes = prepared.knownFileBytes;
      return;
    }
    ensureCanonicalPrivateDirectory(options.rootDir);
    this.epoch = (options.epochFactory ?? randomUUID)();
    ensureCanonicalPrivateDirectory(this.partitionDir);
    ensurePrivateFile(this.path);
    this.openWriter();
    this.recover();
    this.compactAtThreshold();
  }

  state(): JournalRecoveryState {
    this.assertOpen();
    return structuredClone(this.recovery);
  }

  preparation(): JournalPreparationReceipt {
    this.assertOpen();
    if (!this.preparationState) throw new Error("journal was not opened through preparation");
    return structuredClone(this.preparationState);
  }

  revalidatePreparation(): void {
    this.assertOpen();
    if (!this.preparationState) throw new Error("journal was not opened through preparation");
    const actual = fingerprintPreparedJournal(this.options.rootDir, this.partitionDir);
    if (
      actual.fingerprint !== this.preparationState.fingerprint ||
      actual.preparationIdentity !== this.preparationState.preparationIdentity
    ) {
      throw new Error("journal changed since read-only preparation");
    }
  }

  activatePrepared(): void {
    this.assertOpen();
    if (!this.preparationState) throw new Error("journal was not opened through preparation");
    if (this.recovery.status === "recovery_required") {
      this.closeWriter();
      throw new JournalRecoveryRequiredError(this.recovery);
    }
    if (this.writable) return;
    try {
      this.revalidatePreparation();
      ensureCanonicalPrivateDirectory(this.options.rootDir);
      ensureCanonicalPrivateDirectory(this.partitionDir);
      ensurePrivateFile(this.path);
      this.entries.length = 0;
      this.nextSeq = 1;
      this.previousFrameHash = ZERO_HASH;
      this.knownFileBytes = 0;
      this.recovery = { status: "ready", discardedTailBytes: 0 };
      this.openWriter();
      this.recover();
      const activatedRecovery = this.state();
      if (activatedRecovery.status === "recovery_required") {
        throw new JournalRecoveryRequiredError(activatedRecovery);
      }
      this.compactAtThreshold();
    } catch (error) {
      this.failPreparedActivation(error);
    }
  }

  /** Select exact types before copying payloads; sequence numbers and cursors
   * still belong to the complete journal. Omit types to read every record. */
  records<T = unknown>(afterSeq = 0, types?: readonly string[]): JournalRecord<T>[] {
    this.assertReadable();
    return this.entries
      .filter((record) => record.seq > afterSeq && (!types || types.includes(record.type)))
      .map((record) => ({ ...record, payload: cloneJson(record.payload) as T }));
  }

  close(): void {
    if (this.closed) return;
    this.background?.controller.abort();
    this.closed = true;
    this.closeWriter();
  }

  currentCursor(): string {
    this.assertReadable();
    return encodeCursor(this.options.partition, this.epoch, this.nextSeq - 1);
  }

  cursorAt(seq: number): string {
    this.assertReadable();
    if (!Number.isSafeInteger(seq) || seq < 0 || seq >= this.nextSeq) {
      throw new JournalCursorError("journal cursor sequence is outside the current epoch");
    }
    return encodeCursor(this.options.partition, this.epoch, seq);
  }

  currentSequence(): number {
    this.assertReadable();
    return this.nextSeq - 1;
  }

  currentEpoch(): string {
    this.assertReadable();
    return this.epoch;
  }

  physicalBytes(): number {
    this.assertOpen();
    return this.knownFileBytes;
  }

  /** Atomically replace physical frames with one checksummed compressed frame. */
  compact(): { beforeBytes: number; afterBytes: number; records: number } | null {
    this.background?.controller.abort();
    this.assertReadable();
    this.assertWritable();
    const result = prepareJournalCompaction({
      path: this.path,
      partition: this.options.partition,
      entries: this.entries,
      knownFileBytes: this.knownFileBytes,
      now: this.now,
    });
    if (!result) return null;
    try {
      this.installCompaction(result);
      return result.receipt;
    } finally {
      rmSync(result.path, { force: true });
    }
  }

  /** Automatic maintenance preserves logical epoch/seq cursors, including ACKed
   * appends during preparation. The first caller's signal owns a shared flight. */
  compactInBackground(options: {
    stagingDir: string;
    signal?: AbortSignal;
  }): Promise<JournalCompactionResult["receipt"] | null> {
    if (this.background) return this.background.promise;
    this.assertReadable();
    this.assertWritable();
    if (options.signal?.aborted) return Promise.resolve(null);
    if (!this.atCompactionThreshold() || this.entries.length === 0) return Promise.resolve(null);
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    const entries = this.entries;
    const fd = this.fd;
    const epoch = this.epoch;
    const identity = fstatSync(fd);
    const current = (): CompactionBoundary => {
      controller.signal.throwIfAborted();
      this.assertReadable();
      this.assertWritable();
      if (this.entries !== entries || this.fd !== fd || this.epoch !== epoch)
        throw new Error("journal compaction generation changed");
      return {
        count: entries.length,
        nextSeq: this.nextSeq,
        previousFrameHash: this.previousFrameHash,
        knownFileBytes: this.knownFileBytes,
      };
    };
    const promise = prepareBackgroundCompaction({
      stagingDir: options.stagingDir,
      signal: controller.signal,
      partition: this.options.partition,
      epoch,
      time: this.now().toISOString(),
      entries,
      prefix: current(),
      current,
      install: (candidate, boundary) => {
        if (!sameBoundary(current(), boundary)) return false;
        const actual = fstatSync(fd);
        const path = lstatSync(this.path);
        if (
          !sameJournalFile(identity, actual, boundary.knownFileBytes) ||
          !sameJournalFile(identity, path, boundary.knownFileBytes) ||
          readIntent(this.intentPath())
        )
          throw new JournalRecoveryRequiredError(
            this.requireRecovery(
              boundary.knownFileBytes,
              "journal changed outside its single writer during compaction",
            ),
          );
        this.installCompaction(candidate);
        return true;
      },
    }).finally(() => {
      options.signal?.removeEventListener("abort", abort);
      if (this.background?.promise === promise) this.background = null;
    });
    this.background = { controller, promise };
    return promise;
  }

  sequenceAfter(cursor: string | null | undefined): number {
    this.assertReadable();
    return sequenceAfterCursor(cursor, this.options.partition, this.epoch, this.nextSeq);
  }

  cursorFor(record: Pick<JournalRecord, "partition" | "epoch" | "seq">): string {
    this.assertReadable();
    if (record.partition !== this.options.partition || record.epoch !== this.epoch) {
      throw new JournalCursorError("cannot encode a cursor for another partition or epoch");
    }
    return encodeCursor(record.partition, record.epoch, record.seq);
  }

  append<T>(type: string, payload: T): JournalRecord<T> {
    return this.appendBatch([{ type, payload }])[0] as JournalRecord<T>;
  }

  /** Append one logical record group with one intent and one fsync. Recovery
   * either retains the whole acknowledged group or truncates every group byte;
   * no prefix can become durable on its own. */
  appendBatch(records: readonly { type: string; payload: unknown }[]): JournalRecord[] {
    this.assertReadable();
    this.assertWritable();
    if (records.length === 0) throw new Error("journal append batch must not be empty");
    for (const record of records) {
      if (!record.type.trim()) throw new Error("journal record type must not be empty");
    }
    const actualBytes = Number(fstatSync(this.fd, { bigint: true }).size);
    if (actualBytes !== this.knownFileBytes) {
      throw new JournalRecoveryRequiredError(
        this.requireRecovery(this.knownFileBytes, "journal changed outside its single writer"),
      );
    }
    const batch = prepareAppendBatch({
      partition: this.options.partition,
      epoch: this.epoch,
      nextSeq: this.nextSeq,
      previousFrameHash: this.previousFrameHash,
      byteOffset: this.knownFileBytes,
      now: this.now,
      records,
    });
    const byteOffset = this.knownFileBytes;
    writeIntent(this.intentPath(), { v: 1, offset: byteOffset, length: batch.bytes.length });
    try {
      this.appendFrame(this.fd, batch.bytes);
      if (Number(fstatSync(this.fd, { bigint: true }).size) !== byteOffset + batch.bytes.length) {
        throw new Error("journal append did not write the complete batch");
      }
      removeFile(this.intentPath());
    } catch (error) {
      const recovery = this.requireRecovery(
        byteOffset,
        "append/fsync completion is uncertain; restart and inspect before further mutations",
      );
      throw new JournalAppendUncertainError(recovery, { cause: error });
    }
    for (const record of batch.records) this.entries.push(record);
    this.nextSeq = batch.nextSeq;
    this.previousFrameHash = batch.previousFrameHash;
    this.knownFileBytes += batch.bytes.length;
    return batch.records.map((record) => ({ ...record, payload: cloneJson(record.payload) }));
  }

  private recover(): void {
    let result: ReturnType<typeof recoverJournal>;
    try {
      result = recoverJournal(this.fd, this.path, this.options.partition, this.intentPath());
    } catch (error) {
      if (!(error instanceof JournalRecoveryRequiredError)) throw error;
      this.recovery = error.recovery;
      return;
    }
    this.entries = result.records;
    const last = this.entries.at(-1);
    if (last) {
      this.epoch = last.epoch;
      this.nextSeq = last.seq + 1;
      this.previousFrameHash = last.frameHash;
    }
    this.knownFileBytes = result.knownFileBytes;
    if (result.discardedBytes > 0) {
      this.recovery = { status: "ready", discardedTailBytes: result.discardedBytes };
      this.append("journal.recovery_tail_discarded", {
        recoveryId: randomUUID(),
        discardedBytes: result.discardedBytes,
        validBytes: result.knownFileBytes,
        originalBytes: result.knownFileBytes + result.discardedBytes,
        detectedAt: this.now().toISOString(),
      });
    }
  }

  private intentPath(): string {
    return join(this.partitionDir, "append.pending.json");
  }

  private openWriter(): void {
    this.fd = openJournalWriter(this.path);
    this.writable = true;
  }

  private compactAtThreshold(): void {
    if (
      !this.options.deferCompaction &&
      this.recovery.status === "ready" &&
      this.atCompactionThreshold()
    )
      this.compact();
  }

  private atCompactionThreshold(): boolean {
    return this.knownFileBytes >= (this.options.compactionThresholdBytes ?? 8 * 1024 * 1024);
  }

  /** One physical install owner for both producers; no serialization or await. */
  private installCompaction(result: JournalCompactionResult): void {
    const original = fstatSync(this.fd);
    if (result.knownFileBytes >= this.knownFileBytes)
      throw new Error("compaction did not reclaim bytes");
    let renamed = false;
    let closed = false;
    const fd = this.fd;
    this.fd = -1;
    this.writable = false;
    try {
      closeSync(fd);
      closed = true;
      renameSync(result.path, this.path);
      renamed = true;
      fsyncDirectory(dirname(this.path));
      this.openWriter();
    } catch (error) {
      this.closeWriter();
      if (closed && !renamed) {
        this.fd = reopenOriginalWriter(this.path, original);
        this.writable = this.fd >= 0;
      }
      if (!this.writable)
        throw new JournalRecoveryRequiredError(
          this.requireRecovery(
            0,
            `journal compaction install failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      throw error;
    }
    this.entries = result.records;
    this.epoch = result.epoch;
    this.nextSeq = result.nextSeq;
    this.previousFrameHash = result.previousFrameHash;
    this.knownFileBytes = result.knownFileBytes;
  }

  private closeWriter(): void {
    const fd = this.fd;
    this.fd = -1;
    this.writable = false;
    if (fd < 0) return;
    try {
      closeSync(fd);
    } catch {
      /* best-effort revocation: the handle number is never reused by this writer */
    }
  }

  private failPreparedActivation(error: unknown): never {
    this.closeWriter();
    this.entries.length = 0;
    this.nextSeq = 1;
    this.previousFrameHash = ZERO_HASH;
    this.knownFileBytes = 0;
    const recovery =
      error instanceof JournalRecoveryRequiredError
        ? error.recovery
        : this.requireRecovery(
            0,
            `prepared activation failed: ${error instanceof Error ? error.message : String(error)}`,
          );
    this.recovery = structuredClone(recovery);
    throw new JournalRecoveryRequiredError(recovery);
  }

  private requireRecovery(
    byteOffset: number,
    reason: string,
  ): Extract<JournalRecoveryState, { status: "recovery_required" }> {
    this.recovery = journalRecoveryAt(byteOffset, reason);
    this.background?.controller.abort();
    return this.recovery;
  }

  private assertReadable(): void {
    this.assertOpen();
    if (this.recovery.status === "recovery_required") {
      throw new JournalRecoveryRequiredError(this.recovery);
    }
  }

  private assertWritable(): void {
    if (!this.writable) throw new Error("journal preparation is not activated");
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("journal writer is closed");
  }
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

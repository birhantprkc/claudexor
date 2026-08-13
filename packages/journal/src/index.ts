import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  openSync,
  renameSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { ensureCanonicalPrivateDirectory, fsyncDirectory } from "@claudexor/util";
import { encodeJournalPayload, prepareAppendBatch } from "./append-batch.js";
import {
  COMPACTED_SNAPSHOT,
  HASH_BYTES,
  MAX_PAYLOAD_BYTES,
  ZERO_HASH,
  encodeFrame,
  replayFrames,
  type CompactedRecord,
  type CompactedSnapshotPayload,
  type FrameHeader,
  type JournalRecord,
} from "./frame-codec.js";
import {
  appendAndSync,
  ensurePrivateFile,
  readDescriptor,
  readIntent,
  removeFile,
  writeIntent,
} from "./journal-files.js";
import { cursorError, encodeCursor, JournalCursorError } from "./journal-cursor.js";
import { journalPartitionDirectory } from "./journal-partition.js";
import {
  fingerprintPreparedJournal,
  inspectPreparedJournal,
  type JournalPreparationReceipt,
  type PreparedJournalInspection,
} from "./read-only-preparation.js";
export type { JournalRecord } from "./frame-codec.js";
export type { JournalPreparationReceipt } from "./read-only-preparation.js";
export { JournalCursorError } from "./journal-cursor.js";
export { journalPartitionDirectory } from "./journal-partition.js";
export type JournalRecoveryLocation =
  { kind: "byte"; byteOffset: number } | { kind: "cursor"; epoch: string; seq: number };

export type JournalRecoveryState =
  | { status: "ready"; discardedTailBytes: number }
  | {
      status: "recovery_required";
      location: JournalRecoveryLocation;
      reason: string;
      discardedTailBytes: number;
    };
export interface DurableJournalOptions {
  rootDir: string;
  partition: string;
  now?: () => Date;
  epochFactory?: () => string;
  appendAndSync?: (fd: number, bytes: Buffer) => void;
  compactionThresholdBytes?: number;
}

const PREPARED_JOURNAL = Symbol("prepared-journal");

export class JournalRecoveryRequiredError extends Error {
  readonly code: string = "journal_recovery_required";
  readonly status = 503;
  readonly retryable = false;
  readonly requiredActions = ["inspect_recovery", "export_recovery", "quarantine_partition"];
  readonly evidenceRefs: string[] = [];
  readonly recovery: Extract<JournalRecoveryState, { status: "recovery_required" }>;

  constructor(recovery: Extract<JournalRecoveryState, { status: "recovery_required" }>) {
    const safe = Object.freeze({ ...recovery, location: Object.freeze({ ...recovery.location }) });
    const where =
      safe.location.kind === "byte"
        ? `byte ${safe.location.byteOffset}`
        : `cursor ${safe.location.epoch}:${safe.location.seq}`;
    super(`journal partition requires recovery at ${where}: ${safe.reason}`);
    this.name = "JournalRecoveryRequiredError";
    this.recovery = safe;
  }
}

export class JournalAppendUncertainError extends JournalRecoveryRequiredError {
  override readonly code = "journal_append_uncertain";

  constructor(
    recovery: Extract<JournalRecoveryState, { status: "recovery_required" }>,
    options?: ErrorOptions,
  ) {
    super(recovery);
    this.name = "JournalAppendUncertainError";
    if (options?.cause !== undefined)
      Object.defineProperty(this, "cause", { value: options.cause });
  }
}

/** Single-writer, checksummed journal. A returned append has reached fsync. */
export class DurableJournal {
  readonly options: Readonly<DurableJournalOptions>;
  readonly partitionDir: string;
  readonly path: string;
  private readonly now: () => Date;
  private readonly appendFrame: (fd: number, bytes: Buffer) => void;
  private fd = -1;
  private readonly entries: JournalRecord[] = [];
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
    if (actual !== this.preparationState.fingerprint) {
      throw new Error("journal changed since read-only preparation");
    }
  }

  activatePrepared(): void {
    this.assertOpen();
    if (!this.preparationState) throw new Error("journal was not opened through preparation");
    if (this.writable) return;
    if (this.recovery.status === "recovery_required") {
      throw new JournalRecoveryRequiredError(this.recovery);
    }
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
  }

  records<T = unknown>(afterSeq = 0): JournalRecord<T>[] {
    this.assertReadable();
    return this.entries
      .filter((record) => record.seq > afterSeq)
      .map((record) => ({ ...record, payload: cloneJson(record.payload) as T }));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.fd >= 0) closeSync(this.fd);
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
    this.assertReadable();
    this.assertWritable();
    if (this.entries.length === 0) return null;
    const logical: CompactedRecord[] = this.entries.map((record) => ({
      time: record.time,
      type: record.type,
      payload: cloneJson(record.payload),
    }));
    const compressed = gzipSync(Buffer.from(JSON.stringify(logical)));
    const payload: CompactedSnapshotPayload = {
      version: 1,
      count: logical.length,
      encoding: "gzip-base64",
      data: compressed.toString("base64"),
    };
    const payloadBytes = encodeJournalPayload(payload);
    // Oversized history stays readable in its existing frames; compaction is
    // an optimization, not a corruption or recovery boundary.
    if (payloadBytes.length > MAX_PAYLOAD_BYTES) return null;
    const epoch = randomUUID();
    const header: FrameHeader = {
      partition: this.options.partition,
      epoch,
      seq: 1,
      previousFrameHash: ZERO_HASH,
      time: this.now().toISOString(),
      type: COMPACTED_SNAPSHOT,
      logicalSpan: logical.length,
    };
    const frame = encodeFrame(header, payloadBytes);
    if (frame.length >= this.knownFileBytes) return null;
    const temp = `${this.path}.${randomUUID()}.compact`;
    const tempFd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      appendAndSync(tempFd, frame);
    } finally {
      closeSync(tempFd);
    }
    const beforeBytes = this.knownFileBytes;
    renameSync(temp, this.path);
    fsyncDirectory(dirname(this.path));
    closeSync(this.fd);
    this.fd = openSync(this.path, constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW);
    const frameHash = frame.subarray(frame.length - HASH_BYTES).toString("hex");
    this.entries.length = 0;
    for (const [index, record] of logical.entries()) {
      this.entries.push({
        partition: this.options.partition,
        epoch,
        seq: index + 1,
        previousFrameHash: index === 0 ? ZERO_HASH : frameHash,
        frameHash,
        time: record.time,
        type: record.type,
        payload: cloneJson(record.payload),
        byteOffset: 0,
      });
    }
    this.epoch = epoch;
    this.nextSeq = logical.length + 1;
    this.previousFrameHash = frameHash;
    this.knownFileBytes = frame.length;
    return { beforeBytes, afterBytes: frame.length, records: logical.length };
  }

  sequenceAfter(cursor: string | null | undefined): number {
    this.assertReadable();
    if (!cursor) return 0;
    if (!/^[A-Za-z0-9_-]{1,4096}$/.test(cursor)) throw cursorError("malformed");
    let value: unknown;
    try {
      value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    } catch {
      throw cursorError("malformed");
    }
    if (!isRecord(value) || Object.keys(value).sort().join(",") !== "e,p,s,v" || value.v !== 1) {
      throw cursorError("unsupported");
    }
    if (value.p !== this.options.partition || value.e !== this.epoch)
      throw cursorError("stale epoch");
    if (!Number.isSafeInteger(value.s) || Number(value.s) < 0 || Number(value.s) >= this.nextSeq) {
      throw cursorError("ahead of the durable partition");
    }
    if (encodeCursor(value.p as string, value.e as string, value.s as number) !== cursor) {
      throw cursorError("not canonically encoded");
    }
    return value.s as number;
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
    let bytes = readDescriptor(this.fd);
    let discardedBytes = 0;
    try {
      const intent = readIntent(this.intentPath());
      if (intent) {
        const prefix = replayFrames(bytes.subarray(0, intent.offset), this.options.partition);
        if (
          intent.offset > bytes.length ||
          bytes.length > intent.offset + intent.length ||
          prefix.error ||
          prefix.incompleteOffset !== null
        ) {
          this.requireRecovery(intent.offset, "append intent does not match the journal prefix");
          return;
        }
        discardedBytes = bytes.length - intent.offset;
        if (discardedBytes > 0) {
          ftruncateSync(this.fd, intent.offset);
          fsyncSync(this.fd);
          bytes = bytes.subarray(0, intent.offset);
        }
        removeFile(this.intentPath());
      }
    } catch (error) {
      this.requireRecovery(0, `append intent is malformed: ${String(error)}`);
      return;
    }
    const decoded = replayFrames(bytes, this.options.partition);
    if (decoded.incompleteOffset !== null) {
      this.requireRecovery(decoded.incompleteOffset, "unexplained suffix without append intent");
      return;
    }
    if (decoded.error) {
      this.requireRecovery(decoded.error.offset, decoded.error.reason);
      return;
    }
    for (const record of decoded.records) this.entries.push(record);
    const last = this.entries.at(-1);
    if (last) {
      this.epoch = last.epoch;
      this.nextSeq = last.seq + 1;
      this.previousFrameHash = last.frameHash;
    }
    this.knownFileBytes = bytes.length;
    if (discardedBytes > 0) {
      this.recovery = { status: "ready", discardedTailBytes: discardedBytes };
      this.append("journal.recovery_tail_discarded", {
        recoveryId: randomUUID(),
        discardedBytes,
        validBytes: bytes.length,
        originalBytes: bytes.length + discardedBytes,
        detectedAt: this.now().toISOString(),
      });
    }
  }

  private intentPath(): string {
    return join(this.partitionDir, "append.pending.json");
  }

  private openWriter(): void {
    this.fd = openSync(this.path, constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW);
    const stat = fstatSync(this.fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("journal file is not privately owned");
    if ((stat.mode & 0o777) !== 0o600) {
      fchmodSync(this.fd, 0o600);
      fsyncSync(this.fd);
    }
    this.writable = true;
  }

  private compactAtThreshold(): void {
    const threshold = this.options.compactionThresholdBytes ?? 8 * 1024 * 1024;
    if (this.recovery.status === "ready" && this.knownFileBytes >= threshold) this.compact();
  }

  private requireRecovery(
    byteOffset: number,
    reason: string,
  ): Extract<JournalRecoveryState, { status: "recovery_required" }> {
    const value = {
      status: "recovery_required" as const,
      location: { kind: "byte" as const, byteOffset },
      reason,
      discardedTailBytes: 0,
    };
    this.recovery = value;
    return value;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

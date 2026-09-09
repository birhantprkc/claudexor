import { randomUUID } from "node:crypto";
import { closeSync, constants, openSync, rmSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { encodeJournalPayload } from "./append-batch.js";
import {
  COMPACTED_SNAPSHOT,
  HASH_BYTES,
  MAX_COMPACTED_LOGICAL_BYTES,
  MAX_PAYLOAD_BYTES,
  ZERO_HASH,
  encodeFrame,
  type CompactedRecord,
  type CompactedSnapshotPayload,
  type FrameHeader,
  type JournalRecord,
} from "./frame-codec.js";
import { appendAndSync } from "./journal-files.js";

export interface JournalCompactionResult {
  path: string;
  receipt: { beforeBytes: number; afterBytes: number; records: number };
  records: JournalRecord[];
  epoch: string;
  nextSeq: number;
  previousFrameHash: string;
  knownFileBytes: number;
}

/** Prepare a fsynced candidate. Only DurableJournal installs canonical bytes. */
export function prepareJournalCompaction(input: {
  path: string;
  partition: string;
  entries: readonly JournalRecord[];
  knownFileBytes: number;
  now: () => Date;
}): JournalCompactionResult | null {
  if (input.entries.length === 0) return null;
  let logical: CompactedRecord[];
  try {
    logical = input.entries.map((record) => logicalRecord(record, cloneJson(record.payload)));
  } catch (error) {
    if (isCompactionCapacityError(error)) return null;
    throw error;
  }
  let serialized: string;
  try {
    const value = JSON.stringify(logical);
    if (value === undefined) return null;
    serialized = value;
  } catch (error) {
    if (isCompactionCapacityError(error)) return null;
    throw error;
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_COMPACTED_LOGICAL_BYTES) return null;
  let compressed: Buffer;
  try {
    // Stop producing a snapshot once it cannot fit the existing frame cap.
    compressed = gzipSync(Buffer.from(serialized), { maxOutputLength: MAX_PAYLOAD_BYTES });
  } catch (error) {
    if (isCompactionCapacityError(error)) return null;
    throw error;
  }
  const epoch = randomUUID();
  const snapshot = encodeCompactionSnapshot({
    partition: input.partition,
    epoch,
    time: input.now().toISOString(),
    count: logical.length,
    compressed,
  });
  if (!snapshot || snapshot.frame.length >= input.knownFileBytes) return null;
  const { frame, frameHash } = snapshot;
  let records: JournalRecord[];
  try {
    records = logical.map((record, index) =>
      compactedJournalRecord(
        record,
        input.partition,
        epoch,
        index,
        frameHash,
        cloneJson(record.payload),
      ),
    );
  } catch (error) {
    if (isCompactionCapacityError(error)) return null;
    throw error;
  }
  const temp = `${input.path}.${randomUUID()}.compact`;
  const tempFd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    try {
      appendAndSync(tempFd, frame);
    } finally {
      closeSync(tempFd);
    }
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  return {
    path: temp,
    receipt: {
      beforeBytes: input.knownFileBytes,
      afterBytes: frame.length,
      records: logical.length,
    },
    records,
    epoch,
    nextSeq: logical.length + 1,
    previousFrameHash: frameHash,
    knownFileBytes: frame.length,
  };
}

export function logicalRecord(record: CompactedRecord, payload = record.payload): CompactedRecord {
  return { time: record.time, type: record.type, payload };
}

/** Both producers share the versioned envelope and existing materialization caps. */
export function encodeCompactionSnapshot(input: {
  partition: string;
  epoch: string;
  time: string;
  count: number;
  compressed: Buffer;
}): { frame: Buffer; frameHash: string } | null {
  if (input.compressed.length > MAX_PAYLOAD_BYTES) return null;
  let payload: CompactedSnapshotPayload;
  let payloadBytes: Buffer;
  try {
    payload = {
      version: 1,
      count: input.count,
      encoding: "gzip-base64",
      data: input.compressed.toString("base64"),
    };
    payloadBytes = encodeJournalPayload(payload);
  } catch (error) {
    if (isCompactionCapacityError(error)) return null;
    throw error;
  }
  if (payloadBytes.length > MAX_PAYLOAD_BYTES) return null;
  const header: FrameHeader = {
    partition: input.partition,
    epoch: input.epoch,
    seq: 1,
    previousFrameHash: ZERO_HASH,
    time: input.time,
    type: COMPACTED_SNAPSHOT,
    logicalSpan: input.count,
  };
  const frame = encodeFrame(header, payloadBytes);
  const frameHash = frame.subarray(frame.length - HASH_BYTES).toString("hex");
  return { frame, frameHash };
}

export function compactedJournalRecord(
  record: CompactedRecord,
  partition: string,
  epoch: string,
  index: number,
  frameHash: string,
  payload = record.payload,
): JournalRecord {
  return {
    partition,
    epoch,
    seq: index + 1,
    previousFrameHash: index === 0 ? ZERO_HASH : frameHash,
    frameHash,
    time: record.time,
    type: record.type,
    payload,
    byteOffset: 0,
  };
}

export function isCompactionCapacityError(error: unknown): boolean {
  if (
    error instanceof RangeError &&
    (error.message === "Invalid string length" ||
      ("code" in error && error.code === "ERR_STRING_TOO_LONG"))
  ) {
    return true;
  }
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ERR_BUFFER_TOO_LARGE" ||
      error.code === "ERR_STRING_TOO_LONG" ||
      error.code === "journal_compaction_capacity")
  );
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

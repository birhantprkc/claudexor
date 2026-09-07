import { randomUUID } from "node:crypto";
import { closeSync, constants, openSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { gzipSync } from "node:zlib";
import { fsyncDirectory } from "@claudexor/util";
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
  receipt: { beforeBytes: number; afterBytes: number; records: number };
  records: JournalRecord[];
  epoch: string;
  nextSeq: number;
  previousFrameHash: string;
  knownFileBytes: number;
}

export function compactJournalFile(input: {
  path: string;
  partition: string;
  entries: readonly JournalRecord[];
  knownFileBytes: number;
  now: () => Date;
}): JournalCompactionResult | null {
  if (input.entries.length === 0) return null;
  let logical: CompactedRecord[];
  try {
    logical = input.entries.map((record) => ({
      time: record.time,
      type: record.type,
      payload: cloneJson(record.payload),
    }));
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
  // A base64 representation plus its JSON envelope is always larger than the
  // compressed bytes, so this snapshot cannot fit the frame payload. Avoid
  // creating an unnecessarily large string before returning the no-op.
  if (compressed.length > MAX_PAYLOAD_BYTES) return null;
  // Base64 and payload JSON are also materialization steps. Keep them inside
  // the same capacity boundary so an otherwise readable journal remains the
  // authoritative file when either conversion hits a runtime limit.
  let payload: CompactedSnapshotPayload;
  let payloadBytes: Buffer;
  try {
    payload = {
      version: 1,
      count: logical.length,
      encoding: "gzip-base64",
      data: compressed.toString("base64"),
    };
    payloadBytes = encodeJournalPayload(payload);
  } catch (error) {
    if (isCompactionCapacityError(error)) return null;
    throw error;
  }
  if (payloadBytes.length > MAX_PAYLOAD_BYTES) return null;
  const epoch = randomUUID();
  const header: FrameHeader = {
    partition: input.partition,
    epoch,
    seq: 1,
    previousFrameHash: ZERO_HASH,
    time: input.now().toISOString(),
    type: COMPACTED_SNAPSHOT,
    logicalSpan: logical.length,
  };
  const frame = encodeFrame(header, payloadBytes);
  if (frame.length >= input.knownFileBytes) return null;
  const frameHash = frame.subarray(frame.length - HASH_BYTES).toString("hex");
  // Materialize the replacement records before the rename. If cloning a
  // payload fails, the existing journal must remain the authoritative file.
  let records: JournalRecord[];
  try {
    records = logical.map((record, index) => ({
      partition: input.partition,
      epoch,
      seq: index + 1,
      previousFrameHash: index === 0 ? ZERO_HASH : frameHash,
      frameHash,
      time: record.time,
      type: record.type,
      payload: cloneJson(record.payload),
      byteOffset: 0,
    }));
  } catch (error) {
    if (isCompactionCapacityError(error)) return null;
    throw error;
  }
  const temp = `${input.path}.${randomUUID()}.compact`;
  const tempFd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    appendAndSync(tempFd, frame);
  } finally {
    closeSync(tempFd);
  }
  renameSync(temp, input.path);
  fsyncDirectory(dirname(input.path));
  return {
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

function isCompactionCapacityError(error: unknown): boolean {
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
    (error.code === "ERR_BUFFER_TOO_LARGE" || error.code === "ERR_STRING_TOO_LONG")
  );
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

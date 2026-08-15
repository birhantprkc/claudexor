import { randomUUID } from "node:crypto";
import { closeSync, constants, openSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { gzipSync } from "node:zlib";
import { fsyncDirectory } from "@claudexor/util";
import { encodeJournalPayload } from "./append-batch.js";
import {
  COMPACTED_SNAPSHOT,
  HASH_BYTES,
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
  const logical: CompactedRecord[] = input.entries.map((record) => ({
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
  const temp = `${input.path}.${randomUUID()}.compact`;
  const tempFd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    appendAndSync(tempFd, frame);
  } finally {
    closeSync(tempFd);
  }
  renameSync(temp, input.path);
  fsyncDirectory(dirname(input.path));
  const frameHash = frame.subarray(frame.length - HASH_BYTES).toString("hex");
  const records = logical.map((record, index) => ({
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

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

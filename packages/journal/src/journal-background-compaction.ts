import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setImmediate } from "node:timers/promises";
import { createGzip } from "node:zlib";
import { encodeJournalPayload } from "./append-batch.js";
import {
  HASH_BYTES,
  MAX_COMPACTED_LOGICAL_BYTES,
  MAX_PAYLOAD_BYTES,
  encodeFrame,
  type JournalRecord,
} from "./frame-codec.js";
import {
  compactedJournalRecord,
  encodeCompactionSnapshot,
  isCompactionCapacityError,
  logicalRecord,
  type JournalCompactionResult,
} from "./journal-compaction.js";

// A working batch, never a history retention limit or a user setting.
const STREAM_BATCH_BYTES = 64 * 1024;
const COMPACTION_FILE_PREFIX = "journal-compaction-";

export interface CompactionBoundary {
  count: number;
  nextSeq: number;
  previousFrameHash: string;
  knownFileBytes: number;
}

/** The journal owns freshness and installation; this helper owns only its
 * temporary file and immutable logical-record references. */
export async function prepareBackgroundCompaction(input: {
  stagingDir: string;
  signal: AbortSignal;
  partition: string;
  epoch: string;
  time: string;
  entries: readonly JournalRecord[];
  prefix: CompactionBoundary;
  current(): CompactionBoundary;
  install(candidate: JournalCompactionResult, boundary: CompactionBoundary): boolean;
}): Promise<JournalCompactionResult["receipt"] | null> {
  let handle: FileHandle | null = null;
  let path: string | null = null;
  try {
    await setImmediate(undefined, { signal: input.signal });
    const compressed = await compressRecords(input.entries, input.prefix.count, input.signal);
    const snapshot = encodeCompactionSnapshot({
      partition: input.partition,
      epoch: input.epoch,
      time: input.time,
      count: input.prefix.count,
      compressed,
    });
    if (!snapshot || snapshot.frame.length >= input.prefix.knownFileBytes) return null;
    input.signal.throwIfAborted();
    const records: JournalRecord[] = [];
    for (let index = 0; index < input.prefix.count; index += 1) {
      records.push(
        compactedJournalRecord(
          input.entries[index]!,
          input.partition,
          input.epoch,
          index,
          snapshot.frameHash,
        ),
      );
      if ((index + 1) % (STREAM_BATCH_BYTES / 128) === 0)
        await setImmediate(undefined, { signal: input.signal });
    }
    input.signal.throwIfAborted();
    path = join(input.stagingDir, `${COMPACTION_FILE_PREFIX}${randomUUID()}.compact`);
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    await writeBytes(handle, snapshot.frame, input.signal);
    const candidate: JournalCompactionResult = {
      path,
      records,
      epoch: input.epoch,
      nextSeq: input.prefix.nextSeq,
      previousFrameHash: snapshot.frameHash,
      knownFileBytes: snapshot.frame.length,
      receipt: {
        beforeBytes: input.prefix.knownFileBytes,
        afterBytes: snapshot.frame.length,
        records: input.prefix.count,
      },
    };
    for (;;) {
      input.signal.throwIfAborted();
      // appendBatch publishes its entries/counters together, after ACK. Capture
      // only complete batches, even when encoding yields partway through one.
      const boundary = input.current();
      await appendTail(handle, candidate, input.entries, boundary.count, input.signal);
      await handle.sync();
      input.signal.throwIfAborted();
      if (!sameBoundary(boundary, input.current())) continue;
      // Windows requires both the old canonical writer and stage handle closed
      // before rename. Closing can await; appends during it must be caught too.
      await handle.close();
      handle = null;
      input.signal.throwIfAborted();
      candidate.receipt = {
        beforeBytes: boundary.knownFileBytes,
        afterBytes: candidate.knownFileBytes,
        records: candidate.records.length,
      };
      if (input.install(candidate, boundary)) return candidate.receipt;
      input.signal.throwIfAborted();
      handle = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
    }
  } catch (error) {
    if (
      (input.signal.aborted &&
        (error === input.signal.reason ||
          (error instanceof Error && error.name === "AbortError"))) ||
      isCompactionCapacityError(error)
    )
      return null;
    throw error;
  } finally {
    try {
      await handle?.close();
    } finally {
      if (path)
        await unlink(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
    }
  }
}

export function sameBoundary(a: CompactionBoundary, b: CompactionBoundary): boolean {
  return (
    a.count === b.count &&
    a.nextSeq === b.nextSeq &&
    a.previousFrameHash === b.previousFrameHash &&
    a.knownFileBytes === b.knownFileBytes
  );
}

async function compressRecords(
  entries: readonly JournalRecord[],
  count: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let compressedBytes = 0;
  await pipeline(
    Readable.from(serializeRecords(entries, count, signal), {
      objectMode: false,
      highWaterMark: STREAM_BATCH_BYTES,
    }),
    createGzip(),
    new Writable({
      write(chunk: Buffer, _encoding, done) {
        compressedBytes += chunk.length;
        if (compressedBytes > MAX_PAYLOAD_BYTES) return done(capacityError("compressed bytes"));
        chunks.push(chunk);
        done();
      },
    }),
    { signal },
  );
  return Buffer.concat(chunks, compressedBytes);
}

async function* serializeRecords(
  entries: readonly JournalRecord[],
  count: number,
  signal: AbortSignal,
): AsyncGenerator<string> {
  let totalBytes = 2; // brackets
  let batchBytes = 0;
  yield "[";
  for (let index = 0; index < count; index += 1) {
    signal.throwIfAborted();
    const json = JSON.stringify(logicalRecord(entries[index]!));
    const bytes = Buffer.byteLength(json, "utf8") + (index === 0 ? 0 : 1);
    totalBytes += bytes;
    if (totalBytes > MAX_COMPACTED_LOGICAL_BYTES) throw capacityError("logical bytes");
    if (index > 0) yield ",";
    yield json;
    batchBytes += bytes;
    if (batchBytes >= STREAM_BATCH_BYTES) {
      await setImmediate(undefined, { signal });
      batchBytes = 0;
    }
  }
  yield "]";
}

async function appendTail(
  handle: FileHandle,
  candidate: JournalCompactionResult,
  entries: readonly JournalRecord[],
  count: number,
  signal: AbortSignal,
): Promise<void> {
  for (let index = candidate.records.length; index < count; index += 1) {
    signal.throwIfAborted();
    const record = entries[index]!;
    const header = {
      partition: record.partition,
      epoch: record.epoch,
      seq: record.seq,
      previousFrameHash: candidate.previousFrameHash,
      time: record.time,
      type: record.type,
    };
    const frame = encodeFrame(header, encodeJournalPayload(record.payload));
    const frameHash = frame.subarray(frame.length - HASH_BYTES).toString("hex");
    await writeBytes(handle, frame, signal);
    candidate.records.push({
      ...header,
      frameHash,
      payload: record.payload,
      byteOffset: candidate.knownFileBytes,
    });
    candidate.previousFrameHash = frameHash;
    candidate.knownFileBytes += frame.length;
    candidate.nextSeq = record.seq + 1;
  }
}

async function writeBytes(handle: FileHandle, bytes: Buffer, signal: AbortSignal): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    signal.throwIfAborted();
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset);
    if (bytesWritten === 0) throw new Error("journal compaction write made no progress");
    offset += bytesWritten;
  }
}

function capacityError(kind: string): Error {
  return Object.assign(new Error(`journal compaction exceeds the existing ${kind} cap`), {
    code: "journal_compaction_capacity",
  });
}

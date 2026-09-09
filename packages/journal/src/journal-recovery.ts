import { replayFrames, type JournalRecord } from "./frame-codec.js";
import { readDescriptor, readIntent, removeFile, truncatePendingSuffix } from "./journal-files.js";
import { JournalRecoveryRequiredError, journalRecoveryAt } from "./journal-recovery-state.js";

/** Recover only the original canonical file. A compaction candidate is never
 * consulted as recovery authority. Returns decoded ACK history for its writer. */
export function recoverJournal(
  fd: number,
  path: string,
  partition: string,
  intentPath: string,
): {
  records: JournalRecord[];
  knownFileBytes: number;
  discardedBytes: number;
} {
  let bytes = readDescriptor(fd);
  let discardedBytes = 0;
  try {
    const intent = readIntent(intentPath);
    if (intent) {
      const prefix = replayFrames(bytes.subarray(0, intent.offset), partition);
      if (
        intent.offset > bytes.length ||
        bytes.length > intent.offset + intent.length ||
        prefix.error ||
        prefix.incompleteOffset !== null
      ) {
        throw required(intent.offset, "append intent does not match the journal prefix");
      }
      discardedBytes = bytes.length - intent.offset;
      if (discardedBytes > 0) {
        truncatePendingSuffix(fd, path, intent.offset, bytes.length);
        bytes = bytes.subarray(0, intent.offset);
      }
      removeFile(intentPath);
    }
  } catch (error) {
    if (error instanceof JournalRecoveryRequiredError) throw error;
    throw required(0, `append intent is malformed: ${String(error)}`);
  }
  const decoded = replayFrames(bytes, partition);
  if (decoded.incompleteOffset !== null)
    throw required(decoded.incompleteOffset, "unexplained suffix without append intent");
  if (decoded.error) throw required(decoded.error.offset, decoded.error.reason);
  return { records: decoded.records, knownFileBytes: bytes.length, discardedBytes };
}

function required(byteOffset: number, reason: string): JournalRecoveryRequiredError {
  return new JournalRecoveryRequiredError(journalRecoveryAt(byteOffset, reason));
}

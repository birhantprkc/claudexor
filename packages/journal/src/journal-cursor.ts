export class JournalCursorError extends Error {
  readonly code = "journal_cursor_invalid";
  readonly status = 409;
  readonly retryable = true;
  readonly requiredActions = ["resnapshot"];
}

export function encodeCursor(partition: string, epoch: string, seq: number): string {
  return Buffer.from(JSON.stringify({ v: 1, p: partition, e: epoch, s: seq })).toString(
    "base64url",
  );
}

export function cursorError(detail: string): JournalCursorError {
  return new JournalCursorError(`journal cursor is ${detail}; resnapshot is required`);
}

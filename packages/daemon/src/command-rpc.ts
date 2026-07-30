import { commandStoreForRequest, type CommandAuthority } from "./command-authority.js";
import { publicJobRecord, type JobRecord } from "./job-record.js";

interface CommandLookupEnvelope {
  request?: unknown;
  idempotencyKey?: unknown;
  clientId?: unknown;
  operation?: unknown;
  idempotencyRequest?: unknown;
}

/** One parser for enqueue replay and the explicit findAccepted RPC. */
export function findAcceptedCommand(
  commands: CommandAuthority,
  input: CommandLookupEnvelope | null | undefined,
): JobRecord | null {
  return commandStoreForRequest(commands, input?.request).find({
    params: input?.request,
    idempotencyKey: String(input?.idempotencyKey ?? ""),
    clientId: String(input?.clientId ?? "daemon-client"),
    operation: typeof input?.operation === "string" ? input.operation : undefined,
    idempotencyParams: input?.idempotencyRequest,
  });
}

export function publicAcceptedCommand(
  commands: CommandAuthority,
  input: CommandLookupEnvelope | null | undefined,
): ReturnType<typeof publicJobRecord> | null {
  const record = findAcceptedCommand(commands, input);
  return record ? publicJobRecord(record) : null;
}

export function commandAcceptanceReceipt(record: JobRecord, reused: boolean) {
  return { id: record.id, state: record.state, reused };
}

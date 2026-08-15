import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import {
  ControlJournalQuarantineReceipt as QuarantineReceiptSchema,
  type ControlJournalQuarantineReceipt,
  type ControlJournalQuarantineRequest,
} from "@claudexor/schema";
import { readOwnedFile, sha256 } from "./journal-recovery-files.js";

export type JournalQuarantineRequest = ControlJournalQuarantineRequest & {
  idempotencyKey: string;
};

export interface QuarantineOperation {
  schemaVersion: 1;
  operationId: string;
  keyDigest: string;
  requestDigest: string;
  expectedFingerprint: string;
  quarantinePath: string;
  status: "prepared" | "completed";
  receipt: ControlJournalQuarantineReceipt | null;
}

export function readOperation(
  path: string,
  quarantineDir: string,
  partition: string,
  artifactPrefix: string,
): QuarantineOperation | null {
  if (!existsSync(path)) return null;
  const value = JSON.parse(readOwnedFile(path).toString("utf8")) as unknown;
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.operationId !== "string" ||
    typeof value.keyDigest !== "string" ||
    basename(path) !== `${value.keyDigest}.json` ||
    typeof value.requestDigest !== "string" ||
    typeof value.expectedFingerprint !== "string" ||
    typeof value.quarantinePath !== "string" ||
    value.quarantinePath !== join(quarantineDir, `${artifactPrefix}-${value.operationId}`) ||
    (value.status !== "prepared" && value.status !== "completed")
  ) {
    throw new Error("recovery operation is malformed");
  }
  const operation = value as unknown as QuarantineOperation;
  if (operation.status === "prepared" && operation.receipt !== null) {
    throw new Error("prepared recovery operation contains a receipt");
  }
  if (operation.status === "completed") {
    matchingReceipt(operation, undefined, partition, artifactPrefix);
  }
  return operation;
}

export function matchingReceipt(
  operation: QuarantineOperation,
  value: unknown,
  partition: string,
  artifactPrefix: string,
): ControlJournalQuarantineReceipt {
  const receipt = QuarantineReceiptSchema.parse(value ?? operation.receipt);
  if (
    receipt.operationId !== operation.operationId ||
    receipt.partition !== partition ||
    receipt.previousFingerprint !== operation.expectedFingerprint ||
    receipt.quarantinePath !== operation.quarantinePath ||
    receipt.quarantineArtifactId !== `${artifactPrefix}-${operation.operationId}`
  ) {
    throw typedError("recovery_receipt_mismatch", 503, "quarantine receipt does not match intent");
  }
  return receipt;
}

export function validateRequest(input: JournalQuarantineRequest): void {
  if (!input.idempotencyKey || input.idempotencyKey.length > 256) {
    throw typedError(
      "invalid_idempotency_key",
      400,
      "Idempotency-Key must contain 1-256 characters",
    );
  }
  if (input.confirmation !== "quarantine_and_start_fresh") {
    throw typedError("quarantine_confirmation_required", 400, "explicit confirmation is required");
  }
  if (!/^[a-f0-9]{64}$/.test(input.expectedFingerprint)) {
    throw typedError("invalid_recovery_fingerprint", 400, "expectedFingerprint must be SHA-256");
  }
}

export function quarantineRequestDigest(
  partition: string,
  input: JournalQuarantineRequest,
): string {
  return sha256(
    Buffer.from(
      JSON.stringify({
        partition,
        expectedFingerprint: input.expectedFingerprint,
        confirmation: input.confirmation,
      }),
    ),
  );
}

export function conflict(code: string): Error & { code: string; status: number } {
  return typedError(code, 409, code.replaceAll("_", " "));
}

export function typedError(code: string, status: number, message: string) {
  return Object.assign(new Error(message), { code, status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

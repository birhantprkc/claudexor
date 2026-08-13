import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DurableJournal } from "@claudexor/journal";
import type { ControlJournalQuarantineReceipt } from "@claudexor/schema";
import {
  fingerprintPartition,
  requireStableFingerprint,
  writeAtomicPrivateJson,
} from "./journal-recovery-files.js";
import {
  matchingReceipt,
  readOperation,
  typedError,
  type QuarantineOperation,
} from "./journal-recovery-operation.js";

export type PreparedOperationPlan =
  | { kind: "none"; fingerprint: string }
  | {
      kind: "source_intact" | "resume_after_activation" | "complete_after_activation";
      fingerprint: string;
      path: string;
      operation: QuarantineOperation;
    };

export function inspectPreparedOperation(input: {
  operationsDir: string;
  quarantineDir: string;
  partitionDir: string;
  partition: string;
  artifactPrefix: string;
  journal: DurableJournal | null;
}): PreparedOperationPlan {
  const operations = fingerprintPartition(input.operationsDir);
  const operationsFingerprint = requireStableFingerprint(
    operations,
    "journal recovery operations are unavailable",
  );
  if (!operations.exists) {
    return { kind: "none", fingerprint: operationFingerprint(operationsFingerprint, null) };
  }
  const prepared = readdirSync(input.operationsDir)
    .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
    .map((name) => {
      const path = join(input.operationsDir, name);
      return {
        path,
        operation: readOperation(path, input.quarantineDir, input.partition, input.artifactPrefix),
      };
    })
    .filter(
      (entry): entry is { path: string; operation: QuarantineOperation } =>
        entry.operation?.status === "prepared",
    );
  if (prepared.length === 0) {
    return { kind: "none", fingerprint: operationFingerprint(operationsFingerprint, null) };
  }
  if (prepared.length !== 1) throw new Error("multiple prepared recovery operations");
  const pending = prepared[0]!;
  const source = fingerprintPartition(input.partitionDir);
  const target = fingerprintPartition(pending.operation.quarantinePath);
  requireStableFingerprint(source, "journal recovery source is unavailable");
  const stableTargetFingerprint = requireStableFingerprint(
    target,
    "journal recovery quarantine is unavailable",
  );
  const sourceExists = source.exists;
  const targetExists = target.exists;
  const fingerprint = operationFingerprint(
    operationsFingerprint,
    targetExists ? stableTargetFingerprint : null,
  );
  if (targetExists && stableTargetFingerprint !== pending.operation.expectedFingerprint) {
    throw typedError("recovery_quarantine_mismatch", 503, "quarantined bytes changed");
  }
  if (sourceExists && !targetExists) {
    return { kind: "source_intact", fingerprint, ...pending };
  }
  if (!sourceExists && targetExists) {
    if (input.journal?.state().status === "ready") {
      if (!input.journal.preparation().virtual || input.journal.records().length !== 0) {
        throw typedError("recovery_operation_ambiguous", 503, "fresh journal is not empty");
      }
    }
    return { kind: "resume_after_activation", fingerprint, ...pending };
  }
  if (sourceExists && targetExists) {
    assertExactReceipt(input.journal, pending.operation, input.partition, input.artifactPrefix);
    return { kind: "complete_after_activation", fingerprint, ...pending };
  }
  throw typedError("recovery_operation_missing", 503, "recovery source and target are missing");
}

export function preparationFingerprint(journalFingerprint: string, operationFingerprint: string) {
  return createHash("sha256")
    .update(`${journalFingerprint}\0${operationFingerprint}\0`)
    .digest("hex");
}

export function revalidatePreparedState(
  input: Parameters<typeof inspectPreparedOperation>[0] & { expectedFingerprint: string },
): PreparedOperationPlan {
  if (!input.journal) throw new Error("journal is not prepared");
  input.journal.revalidatePreparation();
  const operation = inspectPreparedOperation(input);
  const actual = preparationFingerprint(
    input.journal.preparation().fingerprint,
    operation.fingerprint,
  );
  if (actual !== input.expectedFingerprint) {
    throw new Error("journal manager changed since read-only preparation");
  }
  return operation;
}

export function applyPreparedOperation(input: {
  plan: PreparedOperationPlan;
  journal: DurableJournal;
  partition: string;
  artifactPrefix: string;
  now: () => Date;
  afterReceipt?: () => void;
}): void {
  if (input.plan.kind === "none" || input.plan.kind === "source_intact") return;
  const currentFingerprint = operationFingerprint(
    requireStableFingerprint(
      fingerprintPartition(dirname(input.plan.path)),
      "journal recovery operations changed",
    ),
    requireStableFingerprint(
      fingerprintPartition(input.plan.operation.quarantinePath),
      "journal recovery quarantine changed",
    ),
  );
  if (currentFingerprint !== input.plan.fingerprint) {
    throw typedError("recovery_fingerprint_mismatch", 409, "prepared recovery input changed");
  }
  if (
    requireStableFingerprint(
      fingerprintPartition(input.plan.operation.quarantinePath),
      "journal recovery quarantine changed",
    ) !== input.plan.operation.expectedFingerprint
  ) {
    throw typedError("recovery_quarantine_mismatch", 503, "quarantined bytes changed");
  }
  let receipt: ControlJournalQuarantineReceipt;
  if (input.plan.kind === "resume_after_activation") {
    if (input.journal.records().length !== 0) {
      throw typedError("recovery_operation_ambiguous", 503, "fresh journal is not empty");
    }
    receipt = {
      schemaVersion: 1,
      operationId: input.plan.operation.operationId,
      partition: input.partition,
      previousFingerprint: input.plan.operation.expectedFingerprint,
      quarantineArtifactId: `${input.artifactPrefix}-${input.plan.operation.operationId}`,
      quarantinePath: input.plan.operation.quarantinePath,
      newEpoch: input.journal.currentEpoch(),
      completedAt: input.now().toISOString(),
    };
    input.journal.append("journal.partition_quarantined", receipt);
    input.afterReceipt?.();
  } else {
    receipt = assertExactReceipt(
      input.journal,
      input.plan.operation,
      input.partition,
      input.artifactPrefix,
    );
  }
  writeAtomicPrivateJson(
    input.plan.path,
    { ...input.plan.operation, status: "completed", receipt },
    false,
  );
}

export function completePreparedReceipt(input: {
  operation: QuarantineOperation;
  operationPath: string;
  journal: DurableJournal;
  partition: string;
  artifactPrefix: string;
}): ControlJournalQuarantineReceipt {
  if (
    requireStableFingerprint(
      fingerprintPartition(input.operation.quarantinePath),
      "journal recovery quarantine changed",
    ) !== input.operation.expectedFingerprint
  ) {
    throw typedError("recovery_quarantine_mismatch", 503, "quarantined bytes changed");
  }
  const receipt = assertExactReceipt(
    input.journal,
    input.operation,
    input.partition,
    input.artifactPrefix,
  );
  writeAtomicPrivateJson(
    input.operationPath,
    { ...input.operation, status: "completed", receipt },
    false,
  );
  return receipt;
}

export function reconcilePreparedOperationOnStart(input: {
  operationsDir: string;
  quarantineDir: string;
  partitionDir: string;
  partition: string;
  artifactPrefix: string;
  openGeneration(): void;
  resume(operation: QuarantineOperation, path: string): void;
  failed(error: unknown): void;
}): boolean {
  if (!existsSync(input.operationsDir)) return false;
  try {
    const prepared = readdirSync(input.operationsDir)
      .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
      .map((name) => {
        const path = join(input.operationsDir, name);
        return {
          path,
          operation: readOperation(
            path,
            input.quarantineDir,
            input.partition,
            input.artifactPrefix,
          ),
        };
      })
      .filter(
        (entry): entry is { path: string; operation: QuarantineOperation } =>
          entry.operation?.status === "prepared",
      );
    if (prepared.length === 0) return false;
    if (prepared.length !== 1) throw new Error("multiple prepared recovery operations");
    const pending = prepared[0]!;
    if (existsSync(input.partitionDir) && !existsSync(pending.operation.quarantinePath)) {
      input.openGeneration();
    } else {
      input.resume(pending.operation, pending.path);
    }
  } catch (error) {
    input.failed(error);
  }
  return true;
}

function assertExactReceipt(
  journal: DurableJournal | null,
  operation: QuarantineOperation,
  partition: string,
  artifactPrefix: string,
): ControlJournalQuarantineReceipt {
  if (!journal || journal.state().status === "recovery_required") {
    throw typedError("recovery_operation_ambiguous", 503, "fresh journal is unreadable");
  }
  const records = journal.records();
  if (records.length !== 1 || records[0]?.type !== "journal.partition_quarantined") {
    throw typedError("recovery_operation_ambiguous", 503, "fresh receipt is missing");
  }
  return matchingReceipt(operation, records[0].payload, partition, artifactPrefix);
}

function operationFingerprint(operations: string, quarantine: string | null): string {
  return createHash("sha256")
    .update(`${operations}\0${quarantine ?? "missing"}\0`)
    .digest("hex");
}

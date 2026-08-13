import { randomUUID } from "node:crypto";
import { existsSync, realpathSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  DurableJournal,
  JournalRecoveryRequiredError,
  journalPartitionDirectory,
  type JournalRecoveryState,
} from "@claudexor/journal";
import {
  type ControlJournalExportReceipt,
  type ControlJournalInspection,
  type ControlJournalQuarantineReceipt,
  type ControlJournalValidation,
} from "@claudexor/schema";
import { ensureCanonicalPrivateDirectory, fsyncDirectory } from "@claudexor/util";
import {
  exportJournalRecovery,
  fingerprintPartition,
  cloneRecovery,
  recoveryAt,
  recoveryFrom,
  safeMessage,
  sha256,
  writeAtomicPrivateJson,
} from "./journal-recovery-files.js";
import {
  conflict,
  matchingReceipt,
  quarantineRequestDigest,
  readOperation,
  typedError,
  validateRequest,
  type JournalQuarantineRequest,
  type QuarantineOperation,
} from "./journal-recovery-operation.js";
import { journalEvents } from "./journal-events.js";
import {
  applyPreparedOperation,
  completePreparedReceipt,
  inspectPreparedOperation,
  preparationFingerprint,
  reconcilePreparedOperationOnStart,
  revalidatePreparedState,
  type PreparedOperationPlan,
} from "./journal-prepared-operation.js";
import type { JournalProjectionDescriptor, JournalProjectionSlot } from "./journal-projection.js";
export type { JournalProjectionDescriptor, JournalProjectionSlot } from "./journal-projection.js";

export type { JournalQuarantineRequest } from "./journal-recovery-operation.js";

interface ProjectionRegistration<T = unknown> {
  descriptor: JournalProjectionDescriptor<T>;
  slot: ProjectionSlot<T>;
}

type JournalManagerFault =
  "afterQuarantineRename" | "afterQuarantineReceipt" | "beforeArchiveRename";

export interface JournalManagerOptions {
  partition?: string;
  now?: () => Date;
  faults?: Partial<Record<JournalManagerFault, () => void>>;
}

export interface JournalManagerPreparation {
  partition: string;
  coverage: "complete";
  inspection: ControlJournalInspection;
  validation: ControlJournalValidation;
  preparationFingerprint: string;
  virtual: boolean;
}

export class JournalManager {
  readonly rootDir: string;
  readonly partition: string;
  readonly journalRoot: string;
  readonly partitionDir: string;
  private readonly operationsDir: string;
  private readonly quarantineDir: string;
  private readonly artifactPrefix: string;
  private readonly now: () => Date;
  private readonly faults: Partial<Record<JournalManagerFault, () => void>>;
  private readonly registrations = new Map<string, ProjectionRegistration>();
  private journal: DurableJournal | null = null;
  private recovery: JournalRecoveryState = { status: "ready", discardedTailBytes: 0 };
  private generationValue = 0;
  private preparedOperation: PreparedOperationPlan | null = null;
  private preparationResult: JournalManagerPreparation | null = null;
  private started = false;
  private closed = false;

  constructor(rootDir: string, options: JournalManagerOptions = {}) {
    this.partition = options.partition?.trim() || "global";
    this.now = options.now ?? (() => new Date());
    this.faults = options.faults ?? {};
    this.rootDir = realpathSync(rootDir);
    this.journalRoot = join(this.rootDir, "journal");
    this.partitionDir = journalPartitionDirectory(this.journalRoot, this.partition);
    this.artifactPrefix = basename(this.partitionDir);
    this.operationsDir = join(this.rootDir, "recovery-operations", basename(this.partitionDir));
    this.quarantineDir = join(this.rootDir, "journal-quarantine");
  }

  registerProjection<T>(descriptor: JournalProjectionDescriptor<T>): JournalProjectionSlot<T> {
    this.assertOpen();
    if (this.started) throw new Error("journal projection registration is closed");
    if (!/^[A-Za-z0-9._-]+$/.test(descriptor.name) || this.registrations.has(descriptor.name)) {
      throw new Error(`invalid or duplicate journal projection '${descriptor.name}'`);
    }
    const slot = new ProjectionSlot<T>(() => this.recovery);
    this.registrations.set(descriptor.name, { descriptor, slot } as ProjectionRegistration);
    return slot;
  }

  start(): ControlJournalInspection {
    this.assertOpen();
    if (this.started) return this.inspect();
    if (this.registrations.size === 0) throw new Error("journal partition requires a projection");
    ensureCanonicalPrivateDirectory(this.rootDir);
    ensureCanonicalPrivateDirectory(this.journalRoot);
    this.started = true;
    if (!this.reconcilePrepared()) this.openGeneration();
    return this.inspect();
  }

  prepare(): JournalManagerPreparation {
    this.assertOpen();
    if (this.preparationResult) return structuredClone(this.preparationResult);
    if (this.started) throw new Error("journal manager is already running");
    if (this.registrations.size === 0) throw new Error("journal partition requires a projection");
    this.started = true;
    this.generationValue += 1;
    const projectionStatus: ControlJournalValidation["projectionStatus"] = [];
    try {
      this.journal = DurableJournal.prepare({
        rootDir: this.journalRoot,
        partition: this.partition,
        now: this.now,
      });
      this.recovery = this.journal.state();
      this.preparedOperation = inspectPreparedOperation({
        operationsDir: this.operationsDir,
        quarantineDir: this.quarantineDir,
        partitionDir: this.partitionDir,
        partition: this.partition,
        artifactPrefix: this.artifactPrefix,
        journal: this.journal,
      });
      if (this.recovery.status === "ready") {
        for (const registration of this.registrations.values()) {
          try {
            const projection = registration.descriptor.create(this.journal);
            registration.descriptor.validate(projection);
            registration.slot.bindPrepared(projection);
            projectionStatus.push({
              name: registration.descriptor.name,
              status: "valid",
              detail: null,
            });
          } catch (error) {
            this.enterRecovery(
              recoveryFrom(error, `projection '${registration.descriptor.name}' failed`),
            );
            projectionStatus.push({
              name: registration.descriptor.name,
              status: "invalid",
              detail: safeMessage(error),
            });
            break;
          }
        }
      }
    } catch (error) {
      this.enterRecovery(recoveryFrom(error, `${this.partition} journal could not be prepared`));
    }
    const journalFingerprint =
      this.journal?.preparation().fingerprint ?? fingerprintPartition(this.partitionDir);
    const preparedFingerprint = preparationFingerprint(
      journalFingerprint,
      this.preparedOperation?.fingerprint ?? fingerprintPartition(this.operationsDir),
    );
    const inspection = this.inspection(fingerprintPartition(this.partitionDir));
    this.preparationResult = {
      partition: this.partition,
      coverage: "complete",
      inspection,
      validation: { ...inspection, projectionStatus },
      preparationFingerprint: preparedFingerprint,
      virtual: this.journal?.preparation().virtual ?? !existsSync(this.partitionDir),
    };
    return structuredClone(this.preparationResult);
  }

  revalidatePreparation(): void {
    this.assertStarted();
    if (!this.preparationResult || !this.journal) throw new Error("journal is not prepared");
    this.preparedOperation = revalidatePreparedState({
      operationsDir: this.operationsDir,
      quarantineDir: this.quarantineDir,
      partitionDir: this.partitionDir,
      partition: this.partition,
      artifactPrefix: this.artifactPrefix,
      journal: this.journal,
      expectedFingerprint: this.preparationResult.preparationFingerprint,
    });
  }

  activatePrepared(): void {
    this.assertStarted();
    if (!this.preparationResult || !this.journal) throw new Error("journal is not prepared");
    this.revalidatePreparation();
    this.journal.activatePrepared();
    if (!this.preparedOperation) throw new Error("journal recovery operation is not prepared");
    try {
      applyPreparedOperation({
        plan: this.preparedOperation,
        journal: this.journal,
        partition: this.partition,
        artifactPrefix: this.artifactPrefix,
        now: this.now,
        afterReceipt: this.faults.afterQuarantineReceipt,
      });
    } catch (error) {
      const recovery = recoveryFrom(error, `${this.partition} prepared operation failed`);
      this.enterRecovery(recovery);
      throw new JournalRecoveryRequiredError(recovery);
    }
    this.recovery = this.journal.state();
    for (const registration of this.registrations.values()) {
      registration.slot.activate(this.generationValue);
    }
  }

  recoverAfterStartup(): void {
    this.assertStarted();
    try {
      for (const registration of this.registrations.values()) {
        registration.descriptor.recover?.(registration.slot.current());
      }
    } catch (error) {
      const recovery = recoveryFrom(error, `${this.partition} projection recovery failed`);
      this.enterRecovery(recovery);
      throw new JournalRecoveryRequiredError(recovery);
    }
  }

  inspect(): ControlJournalInspection {
    this.assertStarted();
    if (this.journal && this.recovery.status === "ready") {
      const state = this.journal.state();
      if (state.status === "recovery_required") this.enterRecovery(state);
    }
    return this.inspection(fingerprintPartition(this.partitionDir));
  }

  ready(): boolean {
    this.assertStarted();
    if (this.journal && this.recovery.status === "ready") {
      const state = this.journal.state();
      if (state.status === "recovery_required") this.enterRecovery(state);
    }
    return this.recovery.status === "ready";
  }

  validate(): ControlJournalValidation {
    this.assertStarted();
    const before = fingerprintPartition(this.partitionDir);
    const projectionStatus: ControlJournalValidation["projectionStatus"] = [];
    for (const registration of this.registrations.values()) {
      try {
        const projection = registration.slot.current();
        registration.descriptor.validate(projection);
        projectionStatus.push({
          name: registration.descriptor.name,
          status: "valid",
          detail: null,
        });
      } catch (error) {
        this.enterRecovery(
          recoveryFrom(error, `projection '${registration.descriptor.name}' failed`),
        );
        projectionStatus.push({
          name: registration.descriptor.name,
          status: "invalid",
          detail: safeMessage(error),
        });
      }
    }
    const after = fingerprintPartition(this.partitionDir);
    if (before !== after) this.enterRecovery(recoveryAt(0, "journal changed during validation"));
    return { ...this.inspection(after), projectionStatus };
  }

  events(afterCursor?: string) {
    this.assertStarted();
    return journalEvents(this.journal, this.recovery, afterCursor);
  }

  exportRecovery(): ControlJournalExportReceipt {
    this.assertStarted();
    return exportJournalRecovery({
      rootDir: this.rootDir,
      partitionDir: this.partitionDir,
      partition: this.partition,
      recovery: this.recovery,
      now: this.now,
    });
  }

  preflightQuarantine(input: JournalQuarantineRequest) {
    this.assertStarted();
    validateRequest(input);
    const keyDigest = sha256(Buffer.from(input.idempotencyKey));
    const path = join(this.operationsDir, `${keyDigest}.json`);
    const existing = readOperation(path, this.quarantineDir, this.partition, this.artifactPrefix);
    const requestDigest = quarantineRequestDigest(this.partition, input);
    if (existing) {
      if (existing.requestDigest !== requestDigest) throw conflict("idempotency_conflict");
      if (existing.status === "completed") {
        return {
          disposition: "completed",
          receipt: matchingReceipt(existing, undefined, this.partition, this.artifactPrefix),
        };
      }
      return { disposition: "prepared", receipt: null };
    }
    if (this.recovery.status !== "recovery_required") {
      throw typedError(
        "journal_partition_ready",
        409,
        "only a corrupt partition can be quarantined",
      );
    }
    if (fingerprintPartition(this.partitionDir) !== input.expectedFingerprint) {
      throw conflict("recovery_fingerprint_mismatch");
    }
    return { disposition: "new", receipt: null };
  }

  quarantineAndStartFresh(input: JournalQuarantineRequest): ControlJournalQuarantineReceipt {
    const preflight = this.preflightQuarantine(input);
    if (preflight.disposition === "completed") return preflight.receipt!;
    ensureCanonicalPrivateDirectory(dirname(this.operationsDir));
    ensureCanonicalPrivateDirectory(this.operationsDir);
    ensureCanonicalPrivateDirectory(this.quarantineDir);
    const keyDigest = sha256(Buffer.from(input.idempotencyKey));
    const operationPath = join(this.operationsDir, `${keyDigest}.json`);
    let operation = readOperation(
      operationPath,
      this.quarantineDir,
      this.partition,
      this.artifactPrefix,
    );
    if (!operation) {
      const operationId = randomUUID();
      operation = {
        schemaVersion: 1,
        operationId,
        keyDigest,
        requestDigest: quarantineRequestDigest(this.partition, input),
        expectedFingerprint: input.expectedFingerprint,
        quarantinePath: join(this.quarantineDir, `${this.artifactPrefix}-${operationId}`),
        status: "prepared",
        receipt: null,
      };
      writeAtomicPrivateJson(operationPath, operation, true);
    }
    return this.resume(operation, operationPath);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearSlots();
    this.journal?.close();
    this.journal = null;
  }

  /**
   * Remove-project archival (QA-049): close this partition's journal and move
   * its directory OUT of the active journal tree into `journal-archived/` — the
   * same non-destructive rename the partition-quarantine path uses, never a
   * delete. Returns the absolute archive path, or null when the partition never
   * materialized on disk. Idempotent: a missing source with an existing archive
   * returns that archive path; missing source and no archive returns null. A
   * pre-existing archive for a re-registered id is preserved under a suffixed
   * name rather than clobbered.
   */
  archivePartition(): string | null {
    const archiveDir = join(this.rootDir, "journal-archived");
    const target = join(archiveDir, this.artifactPrefix);
    if (!existsSync(this.partitionDir)) {
      // Nothing to move: close permanently and return the idempotent answer.
      this.close();
      return existsSync(target) ? target : null;
    }
    ensureCanonicalPrivateDirectory(archiveDir);
    const dest = existsSync(target)
      ? join(archiveDir, `${this.artifactPrefix}-${randomUUID()}`)
      : target;
    // RENAME THEN CLOSE (Ф2 finding 4): release the journal file handle for the
    // move, but do NOT mark the manager permanently closed until the fallible
    // rename SUCCEEDS. A rename failure that had pre-closed the partition would
    // strand it closed in-process with its directory still live in the active
    // tree. On failure, reopen a fresh generation so the partition stays
    // usable/re-archivable, then rethrow.
    this.clearSlots();
    this.journal?.close();
    this.journal = null;
    try {
      this.faults.beforeArchiveRename?.();
      renameSync(this.partitionDir, dest);
    } catch (error) {
      this.openGeneration();
      throw error;
    }
    this.closed = true;
    fsyncDirectory(this.journalRoot);
    fsyncDirectory(archiveDir);
    return dest;
  }

  /**
   * Roll a just-archived partition back into the active journal tree — the
   * removeProject rollback when the durable registry `unregister` fails AFTER a
   * successful archive (Ф2 finding 4). Moves `archivedPath` back to
   * `partitionDir` and reopens a fresh generation so the partition is usable
   * again. Throws (leaving the archive in place) when the active slot is already
   * occupied, so the caller can disclose the unrecoverable partial state.
   */
  restoreArchivedPartition(archivedPath: string): void {
    if (existsSync(this.partitionDir)) {
      throw new Error(
        `cannot restore archived partition: ${this.partitionDir} already exists in the active tree`,
      );
    }
    if (!existsSync(archivedPath)) {
      throw new Error(`cannot restore archived partition: ${archivedPath} is missing`);
    }
    renameSync(archivedPath, this.partitionDir);
    fsyncDirectory(this.journalRoot);
    this.closed = false;
    this.openGeneration();
  }

  private openGeneration(): void {
    this.assertOpen();
    this.journal?.close();
    this.journal = null;
    this.clearSlots();
    this.generationValue += 1;
    try {
      this.journal = new DurableJournal({
        rootDir: this.journalRoot,
        partition: this.partition,
        now: this.now,
      });
      this.recovery = this.journal.state();
      if (this.recovery.status === "recovery_required") return;
      for (const registration of this.registrations.values()) {
        const projection = registration.descriptor.create(this.journal);
        registration.descriptor.validate(projection);
        registration.slot.bind(projection, this.generationValue);
      }
      this.recoverAfterStartup();
    } catch (error) {
      const failed = this.journal;
      this.journal = null;
      try {
        failed?.close();
      } catch {
        /* preserve the projection/open failure */
      }
      this.enterRecovery(recoveryFrom(error, `${this.partition} journal could not be opened`));
    }
    if (this.recovery.status === "recovery_required") this.clearSlots();
  }

  private resume(
    operation: QuarantineOperation,
    operationPath: string,
  ): ControlJournalQuarantineReceipt {
    const sourceExists = existsSync(this.partitionDir);
    const targetExists = existsSync(operation.quarantinePath);
    if (sourceExists && targetExists) return this.completeFromReceipt(operation, operationPath);
    if (sourceExists) {
      if (fingerprintPartition(this.partitionDir) !== operation.expectedFingerprint) {
        throw conflict("recovery_fingerprint_mismatch");
      }
      this.clearSlots();
      this.journal?.close();
      this.journal = null;
      renameSync(this.partitionDir, operation.quarantinePath);
      fsyncDirectory(this.journalRoot);
      fsyncDirectory(dirname(operation.quarantinePath));
      if (fingerprintPartition(operation.quarantinePath) !== operation.expectedFingerprint) {
        throw typedError("recovery_quarantine_mismatch", 503, "quarantined bytes changed");
      }
      this.faults.afterQuarantineRename?.();
    } else if (!targetExists) {
      throw typedError("recovery_operation_missing", 503, "recovery source and target are missing");
    } else if (fingerprintPartition(operation.quarantinePath) !== operation.expectedFingerprint) {
      throw typedError("recovery_quarantine_mismatch", 503, "quarantined bytes changed");
    }

    this.openGeneration();
    if (!this.journal || this.recovery.status === "recovery_required") {
      throw new JournalRecoveryRequiredError(
        this.recovery.status === "recovery_required"
          ? this.recovery
          : recoveryAt(0, "fresh journal failed to initialize"),
      );
    }
    if (this.journal.records().length !== 0) {
      throw typedError("recovery_operation_ambiguous", 503, "fresh journal is not empty");
    }
    const receipt: ControlJournalQuarantineReceipt = {
      schemaVersion: 1,
      operationId: operation.operationId,
      partition: this.partition,
      previousFingerprint: operation.expectedFingerprint,
      quarantineArtifactId: `${this.artifactPrefix}-${operation.operationId}`,
      quarantinePath: operation.quarantinePath,
      newEpoch: this.journal.currentEpoch(),
      completedAt: this.now().toISOString(),
    };
    this.journal.append("journal.partition_quarantined", receipt);
    this.faults.afterQuarantineReceipt?.();
    writeAtomicPrivateJson(operationPath, { ...operation, status: "completed", receipt }, false);
    return receipt;
  }

  private completeFromReceipt(
    operation: QuarantineOperation,
    operationPath: string,
  ): ControlJournalQuarantineReceipt {
    if (!this.journal) this.openGeneration();
    if (!this.journal || this.recovery.status === "recovery_required") {
      throw typedError("recovery_operation_ambiguous", 503, "fresh journal is unreadable");
    }
    return completePreparedReceipt({
      operation,
      operationPath,
      journal: this.journal,
      partition: this.partition,
      artifactPrefix: this.artifactPrefix,
    });
  }

  private reconcilePrepared(): boolean {
    return reconcilePreparedOperationOnStart({
      operationsDir: this.operationsDir,
      quarantineDir: this.quarantineDir,
      partitionDir: this.partitionDir,
      partition: this.partition,
      artifactPrefix: this.artifactPrefix,
      openGeneration: () => this.openGeneration(),
      resume: (operation, path) => void this.resume(operation, path),
      failed: (error) =>
        this.enterRecovery(recoveryFrom(error, "prepared quarantine reconciliation failed")),
    });
  }

  private inspection(fingerprint: string): ControlJournalInspection {
    return {
      schemaVersion: 1,
      partition: this.partition,
      generation: this.generationValue,
      status: this.recovery.status,
      recovery: cloneRecovery(this.recovery),
      fingerprint,
      observedAt: this.now().toISOString(),
      evidenceRefs: [`recovery:${this.partition}:${fingerprint}`],
    };
  }

  private enterRecovery(state: Extract<JournalRecoveryState, { status: "recovery_required" }>) {
    this.recovery = cloneRecovery(state) as typeof state;
    this.clearSlots();
  }

  private clearSlots(): void {
    for (const registration of this.registrations.values()) registration.slot.clear();
  }

  private assertStarted(): void {
    this.assertOpen();
    if (!this.started) throw new Error("journal manager is not running");
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("journal manager is closed");
  }
}

class ProjectionSlot<T> implements JournalProjectionSlot<T> {
  private value: T | null = null;
  private preparedValue: T | null = null;
  private generationValue = 0;

  constructor(private readonly recovery: () => JournalRecoveryState) {}

  current(): T {
    if (this.value !== null) return this.value;
    const state = this.recovery();
    throw new JournalRecoveryRequiredError(
      state.status === "recovery_required"
        ? state
        : recoveryAt(0, "journal projection is unavailable"),
    );
  }

  prepared(): T {
    if (this.preparedValue !== null) return this.preparedValue;
    return this.current();
  }

  generation(): number {
    return this.generationValue;
  }

  bind(value: T, generation: number): void {
    this.value = value;
    this.generationValue = generation;
  }

  bindPrepared(value: T): void {
    this.preparedValue = value;
  }

  activate(generation: number): void {
    if (this.preparedValue === null) {
      if (this.value !== null) return;
      throw new Error("journal projection is not prepared");
    }
    this.bind(this.preparedValue, generation);
    this.preparedValue = null;
  }

  clear(): void {
    this.value = null;
    this.preparedValue = null;
  }
}

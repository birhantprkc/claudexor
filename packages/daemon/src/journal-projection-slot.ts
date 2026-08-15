import {
  type DurableJournal,
  JournalRecoveryRequiredError,
  type JournalRecoveryState,
} from "@claudexor/journal";
import type { ControlJournalValidation } from "@claudexor/schema";
import type { JournalProjectionDescriptor, JournalProjectionSlot } from "./journal-projection.js";
import { recoveryAt, recoveryFrom, safeMessage } from "./journal-recovery-files.js";

export interface ProjectionRegistration<T = unknown> {
  descriptor: JournalProjectionDescriptor<T>;
  slot: ProjectionSlot<T>;
}

export function prepareProjectionSlots(
  registrations: Iterable<ProjectionRegistration>,
  journal: DurableJournal,
): {
  status: ControlJournalValidation["projectionStatus"];
  recovery: Extract<JournalRecoveryState, { status: "recovery_required" }> | null;
} {
  const status: ControlJournalValidation["projectionStatus"] = [];
  for (const registration of registrations) {
    try {
      const projection = registration.descriptor.create(journal);
      registration.descriptor.validate(projection);
      registration.slot.bindPrepared(projection);
      status.push({ name: registration.descriptor.name, status: "valid", detail: null });
    } catch (error) {
      status.push({
        name: registration.descriptor.name,
        status: "invalid",
        detail: safeMessage(error),
      });
      return {
        status,
        recovery: recoveryFrom(error, `projection '${registration.descriptor.name}' failed`),
      };
    }
  }
  return { status, recovery: null };
}

export class ProjectionSlot<T> implements JournalProjectionSlot<T> {
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

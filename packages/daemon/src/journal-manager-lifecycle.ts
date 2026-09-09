import type { DurableJournal } from "@claudexor/journal";

export type JournalManagerFault =
  | "afterQuarantineRename"
  | "afterQuarantineReceipt"
  | "beforeArchiveRename"
  | "beforeProjectionActivation";

export type JournalManagerLifecycle =
  "idle" | "prepared" | "active" | "recovery_required" | "closed";

export interface JournalManagerOptions {
  partition?: string;
  now?: () => Date;
  faults?: Partial<Record<JournalManagerFault, () => void>>;
  /** Called after projection recovery; the exact journal object owns this generation. */
  requestMaintenance?: (journal: DurableJournal) => void;
}

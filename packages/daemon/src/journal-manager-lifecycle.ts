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
}

import type { ControlOperationDescriptor } from "@claudexor/schema";

export type OperationDraft = Omit<
  ControlOperationDescriptor,
  | "id"
  | "applicability"
  | "idempotency"
  | "completion"
  | "errorSchema"
  | "summary"
  | "auth"
  | "parameters"
> &
  Partial<
    Pick<
      ControlOperationDescriptor,
      "applicability" | "idempotency" | "completion" | "summary" | "parameters"
    >
  >;

import type { JobRecord } from "./server.js";

export interface DelegationAdmissionAuthority {
  assertCanAdmitChild(parentRunId: string): void;
  noteChildAccepted(parentRunId: string, admissionId: string): void;
  cancelAcceptedChild(parentRunId: string, admissionId: string): void;
  beginParentClose(parentRunId: string): void;
}

export function delegatedParentOf(request: unknown): string | null {
  if (!request || typeof request !== "object" || Array.isArray(request)) return null;
  const value = (request as Record<string, unknown>)["delegatedFromRunId"];
  return typeof value === "string" && value ? value : null;
}

export function isDelegatedChildRecord(record: JobRecord): boolean {
  return delegatedParentOf(record.params) !== null;
}

/** Pure lineage half of daemon-atomic Delegate admission. */
export function admitDelegatedRequest(
  request: unknown,
  operation: string | undefined,
  records: readonly JobRecord[],
  authority?: Pick<DelegationAdmissionAuthority, "assertCanAdmitChild">,
): unknown {
  const delegatedFrom = delegatedParentOf(request);
  if (!delegatedFrom) return request;
  const params = request as Record<string, unknown>;
  if (operation !== "delegated-run" || params["parentRunId"] !== delegatedFrom) {
    throw Object.assign(new Error("delegation lineage is reserved for the scoped belt"), {
      code: "delegation_lineage_forbidden",
      status: 403,
    });
  }
  if (params["delegate"] === true) {
    throw Object.assign(new Error("delegated children cannot enable Delegate"), {
      code: "delegation_depth_forbidden",
      status: 403,
    });
  }
  const parent = records.find((record) => record.runId === delegatedFrom);
  const parentParams =
    parent?.params && typeof parent.params === "object" && !Array.isArray(parent.params)
      ? (parent.params as Record<string, unknown>)
      : null;
  if (!parent || parent.state !== "running" || parentParams?.["delegate"] !== true) {
    throw Object.assign(new Error(`no running Delegate parent run ${delegatedFrom}`), {
      code: "delegation_parent_invalid",
      status: 403,
    });
  }
  if (!authority) {
    throw Object.assign(new Error(`no Delegate budget authority for parent ${delegatedFrom}`), {
      code: "delegation_budget_parent_unavailable",
      status: 409,
    });
  }
  authority.assertCanAdmitChild(delegatedFrom);
  return request;
}

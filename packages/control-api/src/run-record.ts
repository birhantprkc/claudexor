import { MAX_DELEGATED_CHILDREN } from "@claudexor/schema";

export interface DaemonRunRecord {
  id: string;
  state: string;
  runId?: string;
  taskId?: string;
  runDir?: string;
  error?: string;
  errorCode?: string;
  errorStatus?: number;
  errorRetryable?: boolean;
  errorRequiredActions?: string[];
  errorContext?: Record<string, unknown>;
  params?: unknown;
  createdAt?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface DaemonFacadeClient {
  enqueue(
    params: unknown,
    options?: {
      idempotencyKey?: string;
      clientId?: string;
      idempotencyRequest?: unknown;
      operation?: string;
    },
  ): Promise<{ id: string; state: string; reused?: boolean }>;
  findAccepted?(
    params: unknown,
    options: {
      idempotencyKey: string;
      clientId?: string;
      operation?: string;
      idempotencyRequest?: unknown;
    },
  ): Promise<DaemonRunRecord | null>;
  status(id: string): Promise<DaemonRunRecord>;
  list(): Promise<DaemonRunRecord[]>;
  cancel(id: string): Promise<unknown>;
  fenceDelegationParent?(runId: string): Promise<unknown>;
}

export interface ControlOperatorDecisionRecord {
  action: "accept_risk" | "override_needs_human";
  findingIds: string[];
  acceptedRisks: string[];
  patchSha256: string;
  decidedAt: string;
}

export function paramsRecord(record: DaemonRunRecord): Record<string, unknown> {
  return record.params && typeof record.params === "object" && !Array.isArray(record.params)
    ? (record.params as Record<string, unknown>)
    : {};
}

/** Bounded direct Delegate children for reload projections. Exact persisted
 * lineage only; ordinary parentRunId is intentionally ignored. */
export function directDelegatedChildrenFromRecords(
  parentRunId: string,
  runs: readonly DaemonRunRecord[],
  limit = MAX_DELEGATED_CHILDREN,
): DaemonRunRecord[] {
  const boundedLimit = Math.max(0, limit);
  if (boundedLimit === 0) return [];
  const ordered = runs
    .filter(
      (run) =>
        paramsRecord(run)["delegatedFromRunId"] === parentRunId &&
        (run.runId ?? run.id) !== parentRunId,
    )
    .sort((a, b) => {
      const created = (a.createdAt ?? "\uffff").localeCompare(b.createdAt ?? "\uffff");
      const runId = (a.runId ?? a.id).localeCompare(b.runId ?? b.id);
      return created || runId || a.id.localeCompare(b.id);
    });
  const out: DaemonRunRecord[] = [];
  const seen = new Set<string>([parentRunId]);
  for (const run of ordered) {
    const runId = run.runId ?? run.id;
    if (seen.has(runId)) continue;
    seen.add(runId);
    out.push(run);
    if (out.length >= boundedLimit) break;
  }
  return out;
}

/** Persisted Delegate-only descendant graph; ordinary parentRunId is ignored. */
export function delegatedDescendantsFromRecords(
  parentRunId: string,
  runs: readonly DaemonRunRecord[],
): DaemonRunRecord[] {
  const children = new Map<string, DaemonRunRecord[]>();
  for (const run of runs) {
    const parent = paramsRecord(run)["delegatedFromRunId"];
    if (typeof parent !== "string") continue;
    const rows = children.get(parent) ?? [];
    rows.push(run);
    children.set(parent, rows);
  }
  const out: DaemonRunRecord[] = [];
  const seen = new Set<string>([parentRunId]);
  const queue = [parentRunId];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const child of children.get(parent) ?? []) {
      const childRunId = child.runId ?? child.id;
      if (seen.has(childRunId)) continue;
      seen.add(childRunId);
      out.push(child);
      queue.push(childRunId);
    }
  }
  return out;
}

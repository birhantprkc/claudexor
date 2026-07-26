import { redactSecrets } from "@claudexor/util";

export const JOB_STATES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
] as const;
export type JobState = (typeof JOB_STATES)[number];

export interface JobRecord {
  id: string;
  state: JobState;
  params: unknown;
  result?: unknown;
  error?: string;
  errorCode?: string;
  errorStatus?: number;
  errorRetryable?: boolean;
  createdAt: string;
  runId?: string;
  taskId?: string;
  runDir?: string;
  startedAt?: string;
  finishedAt?: string;
}

export function jobStateFromResult(result: unknown, aborted: boolean): JobState {
  if (aborted) return "cancelled";
  const lifecycle = resultString(result, "lifecycle");
  return lifecycle === "succeeded" ||
    lifecycle === "failed" ||
    lifecycle === "cancelled" ||
    lifecycle === "interrupted"
    ? lifecycle
    : "failed";
}

export function resultReason(result: unknown): string | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  return resultString((result as Record<string, unknown>)["facts"], "reason");
}

export function resultSummary(result: unknown): string | null {
  const summary = resultString(result, "summary");
  return summary === null ? null : redactSecrets(summary);
}

export function publicJobRecord(record: JobRecord): JobRecord {
  return {
    ...record,
    error: record.error ? redactSecrets(record.error) : undefined,
    params: redactParams(record.params),
  };
}

function resultString(result: unknown, key: string): string | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const value = (result as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

function redactParams(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactParams);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      key === "prompt" && typeof child === "string" ? redactSecrets(child) : redactParams(child),
    ]),
  );
}

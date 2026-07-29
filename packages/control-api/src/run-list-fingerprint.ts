import { statSync } from "node:fs";
import { sha256 } from "@claudexor/util";
import { safeArtifactPath } from "./artifact-paths.js";
import type { DaemonRunRecord } from "./run-record.js";
import { TERMINAL_STATES } from "./sse-shared.js";

/** Number of artifact-path probes performed by the run-list fingerprinter. */
let fingerprintProbeCount = 0;

export function runListFingerprintProbeCountForTests(): number {
  return fingerprintProbeCount;
}

export function resetRunListFingerprintProbeCountForTests(): void {
  fingerprintProbeCount = 0;
}

/** Fingerprint only the mutable delivery overlay for settled runs; all other
 * terminal artifacts are immutable. Active runs retain the complete set. */
export function summaryFingerprint(rec: DaemonRunRecord): string {
  const mtime = (rel: string): number => {
    fingerprintProbeCount++;
    if (!rec.runDir) return 0;
    const path = safeArtifactPath(rec.runDir, rel);
    if (!path) return 0;
    try {
      return statSync(path).mtimeMs;
    } catch {
      return 0;
    }
  };
  const identity = [rec.state, paramsFingerprint(rec), rec.finishedAt ?? "", rec.error ?? ""];
  if (TERMINAL_STATES.has(rec.state)) {
    return [...identity, mtime("final/delivery_state.yaml")].join("|");
  }
  return [
    ...identity,
    mtime("events.jsonl"),
    mtime("arbitration/decision.yaml"),
    mtime("final/telemetry.yaml"),
    mtime("final/run_facts.yaml"),
    mtime("final/failure.yaml"),
    mtime("final/summary.md"),
    mtime("final/answer.md"),
    mtime("final/plan.md"),
    mtime("final/explore.md"),
    mtime("final/report.md"),
    mtime("final/patch.diff"),
    mtime("final/work_product.yaml"),
    mtime("final/delivery_state.yaml"),
  ].join("|");
}

function paramsFingerprint(rec: DaemonRunRecord): string {
  try {
    return sha256(JSON.stringify(rec.params ?? null));
  } catch {
    return "unserializable-params";
  }
}

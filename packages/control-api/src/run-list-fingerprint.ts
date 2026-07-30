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
  const fileIdentity = (rel: string): string => {
    fingerprintProbeCount++;
    if (!rec.runDir) return "0";
    const path = safeArtifactPath(rec.runDir, rel);
    if (!path) return "0";
    try {
      const stat = statSync(path, { bigint: true });
      return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
    } catch {
      return "0";
    }
  };
  const identity = [rec.state, paramsFingerprint(rec), rec.finishedAt ?? "", rec.error ?? ""];
  if (TERMINAL_STATES.has(rec.state)) {
    // Delivery is the only ordinary mutable terminal overlay. Retention is the
    // other sanctioned transition: it atomically replaces the whole run tree
    // with tombstone.yaml, so that marker must invalidate a previously cached
    // ready summary without re-statting every immutable terminal artifact.
    return [
      ...identity,
      fileIdentity("final/delivery_state.yaml"),
      fileIdentity("tombstone.yaml"),
    ].join("|");
  }
  return [
    ...identity,
    fileIdentity("events.jsonl"),
    fileIdentity("arbitration/decision.yaml"),
    fileIdentity("final/telemetry.yaml"),
    fileIdentity("final/run_facts.yaml"),
    fileIdentity("final/failure.yaml"),
    fileIdentity("final/summary.md"),
    fileIdentity("final/answer.md"),
    fileIdentity("final/plan.md"),
    fileIdentity("final/explore.md"),
    fileIdentity("final/report.md"),
    fileIdentity("final/patch.diff"),
    fileIdentity("final/work_product.yaml"),
    fileIdentity("final/delivery_state.yaml"),
  ].join("|");
}

function paramsFingerprint(rec: DaemonRunRecord): string {
  try {
    return sha256(JSON.stringify(rec.params ?? null));
  } catch {
    return "unserializable-params";
  }
}

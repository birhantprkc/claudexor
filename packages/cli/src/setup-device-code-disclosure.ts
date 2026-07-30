import { existsSync } from "node:fs";
import type { ControlSetupJob } from "@claudexor/schema";
import { isDeviceCodeSetupJob } from "./setup-client-pty.js";
import { ACTIVE_SETUP_STATES } from "./setup-job-store.js";

const DISCLOSURE_POLL_MS = 300;

export interface DeviceCodeDisclosureWatcherDependencies {
  status(jobId: string): ControlSetupJob;
  update(jobId: string, patch: Partial<ControlSetupJob>): void;
  disclosurePath(jobId: string): string;
  now(): Date;
}

/**
 * Watch the journal-less one-time-code sidecar after an awaiting-user flip and
 * emit exactly one durable message update when it arrives. Re-arming is
 * idempotent, and every tick reads the live journal deadline so Extend remains
 * authoritative without rewriting the sealed runner manifest.
 */
export function createDeviceCodeDisclosureWatcher(
  dependencies: DeviceCodeDisclosureWatcherDependencies,
): (jobId: string) => void {
  const armed = new Set<string>();
  const schedule = (watch: () => void) => setTimeout(watch, DISCLOSURE_POLL_MS).unref();

  return function arm(jobId: string): void {
    const job = dependencies.status(jobId);
    if (!isDeviceCodeSetupJob(job) || armed.has(jobId)) return;
    armed.add(jobId);
    const disclosurePath = dependencies.disclosurePath(jobId);
    const watch = () => {
      let current: ControlSetupJob;
      try {
        current = dependencies.status(jobId);
      } catch {
        armed.delete(jobId);
        return; // journal closed (shutdown/restart) — the successor re-arms
      }
      if (!ACTIVE_SETUP_STATES.has(current.state) || current.phase === "cancelling") {
        armed.delete(jobId);
        return;
      }
      if (existsSync(disclosurePath)) {
        if (current.phase === "awaiting_user") {
          dependencies.update(jobId, {
            message: `One-time code ready — enter it at the ${current.harness} verification page (shown in Claudexor).`,
          });
        }
        armed.delete(jobId);
        return;
      }
      const now = dependencies.now().getTime();
      const deadline = current.deadlineAt ? Date.parse(current.deadlineAt) : now + 60_000;
      if (now < deadline) schedule(watch);
      else armed.delete(jobId);
    };
    schedule(watch);
  };
}

import { existsSync } from "node:fs";
import type { ControlSetupJob } from "@claudexor/schema";
import { ACTIVE_SETUP_STATES } from "./setup-job-store.js";
import { readRunnerDeviceCode } from "./setup-login-protocol.js";

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
    // Armed for EVERY login job now, not only the app-server device-code flow:
    // terminal-mode logins (claude/cursor, codex fallback) disclose the
    // captured `oauth_url` through the same sidecar. A job that never writes
    // one just polls out to its own deadline, like a device-code job whose
    // start never succeeds.
    if (armed.has(jobId)) return;
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
          // URL-only disclosures (browser-callback, captured oauth_url) have
          // no one-time code — the message must not promise one.
          let urlOnly = false;
          try {
            urlOnly = readRunnerDeviceCode(disclosurePath)?.userCode === "";
          } catch {
            /* unreadable sidecar: keep the generic code message */
          }
          dependencies.update(jobId, {
            message: urlOnly
              ? `Sign-in link ready — open the ${current.harness} authorization URL shown in Claudexor.`
              : `One-time code ready — enter it at the ${current.harness} verification page (shown in Claudexor).`,
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

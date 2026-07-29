import type { ControlSetupJob, ControlSetupJobTransport } from "@claudexor/schema";
import {
  SETUP_LOGIN_PROTOCOL_VERSION,
  atomicPrivateJson,
  readRunnerPermit,
  type SetupLoginManifest,
  type SetupLoginPermit,
} from "./setup-login-protocol.js";

const PERMIT_POLL_MS = 50;

export function setupLoginDeadlines(
  startedAt: Date,
  loginTimeoutMs: number,
  launcherTimeoutMs: number,
  transport: ControlSetupJobTransport,
): { loginDeadlineAt: string; permitDeadlineAt: string; permitWaitMs?: number } {
  const loginDeadlineAt = new Date(startedAt.getTime() + loginTimeoutMs).toISOString();
  return {
    loginDeadlineAt,
    permitDeadlineAt:
      transport === "client_pty"
        ? loginDeadlineAt
        : new Date(startedAt.getTime() + launcherTimeoutMs).toISOString(),
    // A client_pty runner does not exist at job creation time. Its sealed
    // absolute value remains backward-readable, while the relative window is
    // the live handshake authority after a fresh attach admission.
    ...(transport === "client_pty" ? { permitWaitMs: launcherTimeoutMs } : {}),
  };
}

export async function waitForSetupLoginPermit(
  manifest: SetupLoginManifest,
  now: () => Date,
  sleep: (ms: number) => Promise<void>,
  runnerObservedAt: string,
): Promise<SetupLoginPermit | null> {
  const runnerObservedAtMs = Date.parse(runnerObservedAt);
  if (manifest.permitWaitMs !== undefined && !Number.isFinite(runnerObservedAtMs)) {
    throw new Error("invalid setup-login runner observedAt");
  }
  const deadline =
    manifest.permitWaitMs === undefined
      ? Date.parse(manifest.permitDeadlineAt)
      : runnerObservedAtMs + manifest.permitWaitMs;
  while (now().getTime() <= deadline) {
    const permit = readRunnerPermit(manifest.permitPath);
    const issuedAt = permit ? Date.parse(permit.issuedAt) : Number.NaN;
    if (
      permit &&
      permit.jobId === manifest.jobId &&
      permit.executionId === manifest.executionId &&
      permit.commandDigest === manifest.commandDigest &&
      permit.manifestDigest === manifest.manifestDigest &&
      (manifest.permitWaitMs === undefined ||
        (issuedAt >= runnerObservedAtMs && issuedAt <= deadline))
    )
      return permit;
    await sleep(Math.min(PERMIT_POLL_MS, Math.max(1, deadline - now().getTime())));
  }
  return null;
}

export function persistSetupLoginPermit(job: ControlSetupJob, manifest: SetupLoginManifest): void {
  const issuedAt = job.execution?.permitIssuedAt;
  if (!issuedAt)
    throw new Error("cannot issue a setup-login permit before its durable journal transition");
  atomicPrivateJson(manifest.permitPath, {
    version: SETUP_LOGIN_PROTOCOL_VERSION,
    jobId: job.jobId,
    executionId: manifest.executionId,
    issuedAt,
    commandDigest: manifest.commandDigest,
    manifestDigest: manifest.manifestDigest,
  } satisfies SetupLoginPermit);
}

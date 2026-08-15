/**
 * Claudexord's startup-admission runtime, kept out of main() so the
 * entrypoint stays a thin composition root:
 *
 * - C8: the best-effort post-authority diagnostics opener with launch
 *   provenance (a diagnostics failure never controls daemon lifecycle);
 * - the quota poller armed only on normal admission (C1a);
 * - D5 stage 4 as ONE single-flight completion shared by the startup path
 *   and the C6b recovery-route reopen, which re-runs it with a LIVE
 *   re-verdict so the daemon transitions to normal without a restart.
 */
import {
  daemonDir,
  logPath,
  type DaemonServingMode,
  type JournalManager,
  type ProjectPartitions,
  type RootAuthorityGrant,
} from "@claudexor/daemon";
import { sweepRetiredConfigKeysAtStartup } from "@claudexor/config";
import { redactSecrets } from "@claudexor/util";
import { DAEMON_LAUNCH_SOURCE_ENV } from "./daemon-launch.js";
import { logLine, runStartupCrashGc } from "./daemon-lifecycle.js";
import {
  completeStartupAdmission,
  recoveryBlockedPartitions,
  type DaemonStartupAdmission,
} from "./daemon-startup.js";
import {
  openDaemonStartupDiagnosticsAfterAuthority,
  safeDaemonLaunchSource,
  type DaemonStartupDiagnostics,
} from "./startup-diagnostics.js";

export interface StartupDiagnosticsHandle {
  diagnostics: DaemonStartupDiagnostics | null;
  recordStage(stage: string, message: string): void;
  recordFailure(message: string, error: unknown): void;
  close(): void;
}

/** C8: open the private post-authority diagnostics with full launch
 * provenance (runtime identity, entry path, pid, data root, and the
 * CLAUDEXOR_DAEMON_LAUNCH_SOURCE value coerced to a safe label). */
export function openStartupDiagnostics(identity: {
  version: string;
  sha: string;
  entry: string;
}): StartupDiagnosticsHandle {
  let diagnostics: DaemonStartupDiagnostics | null = null;
  try {
    diagnostics = openDaemonStartupDiagnosticsAfterAuthority({
      runtimeVersion: identity.version,
      buildSha: identity.sha,
      entryPath: identity.entry,
      pid: process.pid,
      dataRoot: daemonDir(),
      launchSource: safeDaemonLaunchSource(process.env[DAEMON_LAUNCH_SOURCE_ENV]),
    });
    diagnostics.record({
      stage: "root_authority_won",
      message: "root authority acquired; startup diagnostics online",
    });
  } catch (error) {
    logLine(
      logPath(),
      `startup diagnostics unavailable: ${redactSecrets(
        error instanceof Error ? error.message : String(error),
      )}`,
    );
  }
  const record = (value: Parameters<DaemonStartupDiagnostics["record"]>[0]): void => {
    try {
      diagnostics?.record(value);
    } catch {
      /* diagnostics never control lifecycle */
    }
  };
  return {
    diagnostics,
    recordStage: (stage, message) => record({ stage, message }),
    recordFailure: (message, error) => record({ stage: "startup_failure", message, error }),
    close: () => diagnostics?.close(),
  };
}

/** C1a/G-QUOTA-01: quota polling belongs to the NORMAL plane — polling
 * against unactivated projections is a swallowed throw, and the recovery
 * plane must stay non-mutating. Arming polls immediately, removing the
 * one-minute stale window the swallowed stage-2 poll used to leave. */
export function createDaemonQuotaPoller(poll: () => void): { arm(): void; stop(): void } {
  let timer: NodeJS.Timeout | null = null;
  return {
    arm: () => {
      if (timer) return;
      timer = setInterval(poll, 60_000);
      timer.unref();
      poll();
    },
    stop: () => {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

/** The composition root's normal-plane duties, run exactly once from either
 * the startup path or the C6b reopen (C1a quota arming, C2 pid snapshots,
 * C5a retired-key sweep persistence, setup binding, ghost quarantine,
 * startup retention). */
export interface NormalPlaneDuties {
  requested(): boolean;
  armQuotaPolling(): void;
  beginPidSnapshots(): void;
  startSetup(): Promise<void>;
  quarantineGhosts(): void;
  scheduleRetention(): void;
}

/** D5 stage 4, single-flight: the startup path runs it with the frozen
 * stage-2 verdict; the C6b recovery-route reopen re-runs it with a live one.
 * Concurrent callers join the in-flight completion. */
export function createStartupAdmissionRuntime(input: {
  admission: DaemonStartupAdmission;
  grant: Pick<RootAuthorityGrant, "advanceFloor">;
  global: JournalManager;
  partitions: ProjectPartitions;
  diagnostics: StartupDiagnosticsHandle;
  normalPlane: NormalPlaneDuties;
}): {
  runAdmissionCompletion(blockedPartitions: () => string[]): Promise<DaemonServingMode>;
  wrapQuarantineWithReopen<T>(
    service: (partition: string, request: unknown) => Promise<T>,
  ): (partition: string, request: unknown) => Promise<T>;
} {
  // Normal-plane side effects run exactly once, from whichever path opened
  // normal admission first.
  let normalAdmissionCompleted = false;
  const onNormalAdmission = async (): Promise<void> => {
    if (normalAdmissionCompleted || input.normalPlane.requested()) return;
    normalAdmissionCompleted = true;
    input.normalPlane.armQuotaPolling();
    // Crash-GC has consumed the previous life's pids.json by now; live
    // snapshots may own the file again (C2).
    input.normalPlane.beginPidSnapshots();
    // Same-root config evolution hygiene (B9): persist the retired-key sweep
    // only on the NORMAL plane (C5a). Pre-admission parses already tolerate
    // retired keys via loadConfig's in-memory strip; unknown keys NOT on the
    // retired registry still fail loud (INV-021).
    for (const sweep of sweepRetiredConfigKeysAtStartup()) {
      logLine(
        logPath(),
        `swept retired config keys from ${sweep.path}: ${sweep.removed.join(", ")}`,
      );
    }
    await input.normalPlane.startSetup();
    input.normalPlane.quarantineGhosts();
    input.normalPlane.scheduleRetention();
  };

  let admissionCompletion: Promise<DaemonServingMode> | null = null;
  const runAdmissionCompletion = (
    blockedPartitions: () => string[],
  ): Promise<DaemonServingMode> => {
    if (input.admission.snapshot() === "normal") return Promise.resolve("normal");
    admissionCompletion ??= (async () => {
      try {
        const servingMode = await completeStartupAdmission({
          grant: input.grant,
          blockedPartitions: blockedPartitions(),
          global: {
            // A manager already reopened by a recovery-route quarantine
            // (openGeneration) is live authority; only still-prepared state
            // revalidates (the reopen runs over a mix of both).
            revalidatePreparation: () => {
              if (!input.global.ready()) input.global.revalidatePreparation();
            },
            activatePrepared: () => input.global.activatePrepared(),
            recoverAfterStartup: () => input.global.recoverAfterStartup(),
          },
          partitions: input.partitions,
          crashGc: () =>
            runStartupCrashGc({
              daemonDir: daemonDir(),
              logPath: logPath(),
              ...(input.diagnostics.diagnostics
                ? { diagnostics: input.diagnostics.diagnostics }
                : {}),
            }),
          admission: input.admission,
          log: (message) => {
            logLine(logPath(), message);
            input.diagnostics.recordStage("startup_admission", message);
          },
        });
        if (servingMode === "normal") await onNormalAdmission();
        return servingMode;
      } finally {
        admissionCompletion = null;
      }
    })();
    return admissionCompletion;
  };

  // C6b: after a successful recovery-route quarantine the daemon transitions
  // to normal WITHOUT a restart, re-verdicting the CURRENT partition state.
  const reopenAfterRecovery = async (): Promise<void> => {
    while (input.admission.snapshot() !== "normal") {
      const joined = admissionCompletion;
      if (joined) {
        await joined.catch(() => {});
        continue;
      }
      const servingMode = await runAdmissionCompletion(() =>
        recoveryBlockedPartitions({
          globalPreparation: { inspection: input.global.inspect() },
          partitionsPreparation: input.partitions.refreshPreparation(),
        }),
      );
      if (servingMode !== "normal") return; // partitions still block: stay protected
    }
  };

  return {
    runAdmissionCompletion,
    wrapQuarantineWithReopen: (service) => async (partition, request) => {
      const receipt = await service(partition, request);
      try {
        await reopenAfterRecovery();
      } catch (error) {
        // The quarantine itself SUCCEEDED; a failed reopen stays on the
        // protected recovery plane and is disclosed.
        logLine(
          logPath(),
          `recovery reopen failed; still serving recovery only: ${redactSecrets(
            error instanceof Error ? error.message : String(error),
          )}`,
        );
      }
      return receipt;
    },
  };
}

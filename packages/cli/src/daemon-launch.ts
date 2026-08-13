/** Caller-visible daemon launch evidence before root authority exists. */
import { spawn, type ChildProcess } from "node:child_process";
import { lstatSync } from "node:fs";
import { logPath } from "@claudexor/daemon";
import {
  safeProblemContext,
  safeProblemMessage,
  safeProblemRequiredActions,
} from "@claudexor/util";
import { CliError } from "./cli-error.js";

export const DAEMON_LAUNCH_SOURCE_ENV = "CLAUDEXOR_DAEMON_LAUNCH_SOURCE";

export const CLI_DAEMON_LAUNCH_SOURCES = {
  ensureDaemon: "cli_ensure_daemon",
  explicitStart: "cli_explicit_start",
} as const;

export type CliDaemonLaunchSource =
  (typeof CLI_DAEMON_LAUNCH_SOURCES)[keyof typeof CLI_DAEMON_LAUNCH_SOURCES];

export type DaemonLaunchFailure =
  | {
      kind: "spawn_error";
      message: string;
      code?: string;
    }
  | {
      kind: "preclaim_exit";
      exitCode: number | null;
      signal: NodeJS.Signals | null;
    };

export interface DetachedDaemonLaunch {
  readonly pid: number | null;
  failure(): DaemonLaunchFailure | null;
  waitForFailure(): Promise<DaemonLaunchFailure>;
  markReady(): void;
  callerError(stage: string, timeoutMs: number): CliError;
}

export interface LaunchDetachedDaemonOptions {
  entryPath: string;
  launchSource: CliDaemonLaunchSource;
  env?: NodeJS.ProcessEnv;
  nodePath?: string;
}

export function daemonLaunchEnvironment(
  source: NodeJS.ProcessEnv,
  launchSource: CliDaemonLaunchSource,
): NodeJS.ProcessEnv {
  return { ...source, [DAEMON_LAUNCH_SOURCE_ENV]: launchSource };
}

function missingEntryError(entryPath: string, reason: unknown): CliError {
  return new CliError(
    "operational",
    `cannot start the daemon: the selected entry is unavailable (${safeProblemMessage(reason)})`,
    {
      code: "daemon_entry_missing",
      retryable: false,
      requiredActions: [
        "Reinstall Claudexor or rebuild the matching runtime before retrying.",
        "Use an eligible fixed runtime; do not fall back to an older daemon for this data root.",
      ],
      context: safeProblemContext({ entryPath }),
    },
  );
}

function proveEntry(entryPath: string): void {
  try {
    const stat = lstatSync(entryPath);
    if (!stat.isFile() && !stat.isSymbolicLink()) {
      throw missingEntryError(entryPath, "entry is not a file");
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw missingEntryError(entryPath, error);
  }
}

function canonicalLogRemedy(): string {
  try {
    return `Run \`claudexor daemon logs\` for the canonical post-authority log at ${logPath()}; a pre-authority failure may have no log record.`;
  } catch {
    return "Run `claudexor daemon logs` for the canonical post-authority log; a pre-authority failure may have no log record.";
  }
}

/**
 * Spawn without an inherited canonical-log descriptor. Import, spawn and
 * pre-claim exits remain bounded caller evidence; the daemon may start its own
 * permanent diagnostic writer only after a separate root-authority decision.
 */
export function launchDetachedDaemon(options: LaunchDetachedDaemonOptions): DetachedDaemonLaunch {
  proveEntry(options.entryPath);
  let failure: DaemonLaunchFailure | null = null;
  let ready = false;
  let resolveFailure: ((value: DaemonLaunchFailure) => void) | undefined;
  const failurePromise = new Promise<DaemonLaunchFailure>((resolve) => {
    resolveFailure = resolve;
  });
  const settleFailure = (value: DaemonLaunchFailure): void => {
    if (failure || ready) return;
    failure = value;
    resolveFailure?.(value);
  };
  let child: ChildProcess | undefined;
  try {
    child = spawn(options.nodePath ?? process.execPath, [options.entryPath], {
      detached: true,
      stdio: "ignore",
      env: daemonLaunchEnvironment(options.env ?? process.env, options.launchSource),
    });
    child.once("error", (error) => {
      const code =
        typeof (error as NodeJS.ErrnoException).code === "string"
          ? (error as NodeJS.ErrnoException).code
          : undefined;
      settleFailure({ kind: "spawn_error", message: safeProblemMessage(error), code });
    });
    child.once("exit", (exitCode, signal) => {
      settleFailure({ kind: "preclaim_exit", exitCode, signal });
    });
    child.unref();
  } catch (error) {
    const code =
      typeof (error as NodeJS.ErrnoException).code === "string"
        ? (error as NodeJS.ErrnoException).code
        : undefined;
    settleFailure({ kind: "spawn_error", message: safeProblemMessage(error), code });
  }

  const callerError = (stage: string, timeoutMs: number): CliError => {
    const observed = failure;
    const message = observed
      ? observed.kind === "spawn_error"
        ? `daemon launch failed before root authority: ${observed.message}`
        : `daemon exited before it became ready (exit ${observed.exitCode ?? "null"}${observed.signal ? `, signal ${observed.signal}` : ""})`
      : `daemon did not become ready within ${Math.round(timeoutMs / 1000)}s`;
    return new CliError("operational", message, {
      code: "daemon_start_failed",
      retryable: true,
      requiredActions: safeProblemRequiredActions([
        canonicalLogRemedy(),
        "Verify that this CLI uses an eligible fixed runtime, then retry; stop an older root claimant explicitly if it still owns the root.",
      ]),
      context: safeProblemContext({
        stage,
        timeoutMs,
        entryPath: options.entryPath,
        launchSource: options.launchSource,
        failure: observed ?? { kind: "startup_timeout" },
      }),
    });
  };

  return {
    pid: child?.pid ?? null,
    failure: () => failure,
    waitForFailure: () => (failure ? Promise.resolve(failure) : failurePromise),
    markReady: () => {
      ready = true;
    },
    callerError,
  };
}

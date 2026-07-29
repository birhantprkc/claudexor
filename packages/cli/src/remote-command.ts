import { spawn } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  openSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { arch, homedir, platform } from "node:os";
import { join } from "node:path";
import { CLAUDEXOR_VERSION } from "@claudexor/util";
import {
  awaitDaemonTermination,
  daemonLeaseOwner,
  daemonDir,
  defaultSocketPath,
  socketAlive,
} from "@claudexor/daemon";
import { type ParsedArgs } from "./args.js";
import { ensureDaemon, connectDaemonIfRunning } from "./daemon-run.js";
import { controlApiFetch, CONTROL_PROTOCOL_MAJOR, handshakeControlApi } from "./live.js";
import { printJson, printUsageError } from "./cli-io.js";
import { resolveSetupLoginRunnerPath } from "./setup-job-support.js";
import { admitAndAwaitRuntimeReplacementStop } from "./runtime-replacement-stop.js";

function runtimeTarget(): string {
  return `${platform()}-${arch()}`;
}

function endpointPort(baseUrl: string): number {
  const url = new URL(baseUrl);
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "::1") {
    throw new Error("remote control API refused: endpoint is not loopback-bound");
  }
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("remote control API reported an invalid port");
  }
  return port;
}

async function bootstrap(): Promise<number> {
  const { addr } = await ensureDaemon();
  const identity = await handshakeControlApi(addr, "claudexor-macos-remote");
  printJson({
    ok: true,
    target: runtimeTarget(),
    version: CLAUDEXOR_VERSION,
    buildSha: process.env["CLAUDEXOR_BUILD_SHA"] ?? "unknown",
    protocolMajor: CONTROL_PROTOCOL_MAJOR,
    engineVersion: identity.engineVersion,
    engineBuildSha: identity.engineBuildSha,
    endpoint: { host: "127.0.0.1", port: endpointPort(addr.baseUrl), token: addr.token },
  });
  return 0;
}

async function probe(): Promise<number> {
  printJson({
    ok: true,
    target: runtimeTarget(),
    platform: platform(),
    arch: arch(),
    home: homedir(),
    version: CLAUDEXOR_VERSION,
    buildSha: process.env["CLAUDEXOR_BUILD_SHA"] ?? "unknown",
    protocolMajor: CONTROL_PROTOCOL_MAJOR,
  });
  return 0;
}

export function assertRemoteEngineIdentity(
  observed: { engineVersion: string | null; engineBuildSha: string | null },
  expectedVersion: string,
  expectedBuildSha: string,
): void {
  if (!/^\d+\.\d+\.\d+$/.test(expectedVersion) || !/^[0-9a-f]{40}$/.test(expectedBuildSha)) {
    throw new Error("remote daemon stop received an invalid expected identity");
  }
  if (observed.engineVersion !== expectedVersion || observed.engineBuildSha !== expectedBuildSha) {
    throw new Error(
      `remote daemon identity mismatch (expected ${expectedVersion}/${expectedBuildSha}, ` +
        `observed ${observed.engineVersion ?? "unknown"}/${observed.engineBuildSha ?? "unknown"})`,
    );
  }
}

async function stop(expectedVersion: string, expectedBuildSha: string): Promise<number> {
  const daemon = await connectDaemonIfRunning();
  if (!daemon) {
    if (daemonLeaseOwner(defaultSocketPath()) || (await socketAlive(defaultSocketPath()))) {
      throw new Error("remote daemon is running but its Control API identity cannot be verified");
    }
    printJson({ ok: true, stopped: true, alreadyStopped: true });
    return 0;
  }
  const identity = await handshakeControlApi(daemon.addr, "claudexor-macos-remote-stop");
  assertRemoteEngineIdentity(identity, expectedVersion, expectedBuildSha);
  const termination = await admitAndAwaitRuntimeReplacementStop(
    () => daemon.client.shutdownForRuntimeReplacement(),
    (options) => awaitDaemonTermination(defaultSocketPath(), options),
  );
  if (termination.outcome === "still_alive") {
    throw new Error(`remote daemon did not stop: ${termination.detail}`);
  }
  printJson({ ok: true, stopped: true, ...termination });
  return 0;
}

function runtimePointerTarget(value: string): string | null {
  if (value === "-") return null;
  if (!/^versions\/[A-Za-z0-9._-]+$/.test(value) || value.includes("..")) {
    throw new Error("remote runtime pointer target is invalid");
  }
  return value;
}

function readRuntimePointer(root: string): string | null {
  const current = join(root, "current");
  try {
    if (!lstatSync(current).isSymbolicLink()) {
      throw new Error("remote runtime current pointer is not a symbolic link");
    }
    return readlinkSync(current);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function replaceRuntimePointer(root: string, name: string, target: string): void {
  const destination = join(root, name);
  const temporary = join(root, `.${name}.next-${process.pid}`);
  try {
    unlinkSync(temporary);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  symlinkSync(target, temporary);
  try {
    // fs.rename maps to rename(2), which atomically replaces the symlink itself
    // on both Darwin and Linux (unlike platform-divergent `mv` directory logic).
    renameSync(temporary, destination);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      /* best effort */
    }
    throw error;
  }
}

export function switchRemoteRuntimePointer(
  mode: "activate" | "rollback",
  root: string,
  expectedRaw: string,
  nextRaw: string,
): void {
  const expected = runtimePointerTarget(expectedRaw);
  const next = runtimePointerTarget(nextRaw);
  const current = readRuntimePointer(root);
  if (current !== expected) {
    throw new Error(
      `remote runtime pointer changed concurrently (expected ${expected ?? "-"}, observed ${current ?? "-"})`,
    );
  }
  if (next) {
    const target = join(root, next);
    if (!lstatSync(target).isDirectory() || lstatSync(target).isSymbolicLink()) {
      throw new Error("remote runtime pointer target is not an immutable directory");
    }
  }
  if (mode === "activate" && expected) {
    replaceRuntimePointer(root, "last-known-good", expected);
  }
  if (next) {
    replaceRuntimePointer(root, "current", next);
  } else {
    unlinkSync(join(root, "current"));
  }
}

export async function remoteCommand(args: ParsedArgs, json: boolean): Promise<number> {
  const sub = args._[1] ?? "probe";
  if (!json) {
    return printUsageError(false, "claudexor remote is an internal machine interface; pass --json");
  }
  if (sub === "stop") {
    const expectedVersion = args._[2];
    const expectedBuildSha = args._[3];
    if (
      args._.length !== 4 ||
      typeof expectedVersion !== "string" ||
      typeof expectedBuildSha !== "string"
    ) {
      return printUsageError(
        json,
        "usage: claudexor remote stop <expectedVersion> <expectedBuildSha> --json",
      );
    }
    return stop(expectedVersion, expectedBuildSha);
  }
  if (sub === "activate" || sub === "rollback") {
    const expected = args._[2];
    const next = args._[3];
    if (args._.length !== 4 || typeof expected !== "string" || typeof next !== "string") {
      return printUsageError(
        json,
        `usage: claudexor remote ${sub} <expectedTarget|-> <nextTarget|-> --json`,
      );
    }
    switchRemoteRuntimePointer(sub, join(homedir(), ".claudexor", "remote"), expected, next);
    printJson({ ok: true, current: next === "-" ? null : next });
    return 0;
  }
  if (args._.length > 2 || (sub !== "probe" && sub !== "bootstrap")) {
    return printUsageError(
      json,
      "usage: claudexor remote probe|bootstrap|stop|activate|rollback --json",
    );
  }
  return sub === "bootstrap" ? bootstrap() : probe();
}

function waitForChild(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (signal) {
        process.stderr.write(`claudexor setup attach: runner exited on ${signal}\n`);
        resolve(1);
      } else {
        resolve(code ?? 1);
      }
    });
  });
}

export function claimSetupAttachment(directory: string): void {
  const path = join(directory, "client-pty-attached");
  let descriptor: number;
  try {
    descriptor = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch {
    throw new Error("setup job already has a client_pty attachment");
  }
  closeSync(descriptor);
}

export async function setupCommand(args: ParsedArgs, json: boolean): Promise<number> {
  const sub = args._[1];
  const jobId = args._[2];
  if (
    sub !== "attach" ||
    typeof jobId !== "string" ||
    !/^setup-[A-Za-z0-9-]+$/.test(jobId) ||
    args._.length !== 3
  ) {
    return printUsageError(json, "usage: claudexor setup attach <jobId>");
  }
  if (json) {
    return printUsageError(
      true,
      "claudexor setup attach owns an interactive PTY and cannot use --json",
    );
  }
  const daemon = await connectDaemonIfRunning();
  if (!daemon) throw new Error("setup daemon is not running");
  const response = await controlApiFetch(daemon.addr, `/setup/jobs/${encodeURIComponent(jobId)}`);
  const body = (await response.json()) as {
    state?: string;
    phase?: string;
    transport?: string;
  };
  if (!response.ok) throw new Error(`setup job lookup failed (HTTP ${response.status})`);
  if (body.transport !== "client_pty") {
    throw new Error("setup job is not authorized for client_pty attachment");
  }
  if (
    !["queued", "running", "waiting_for_input"].includes(body.state ?? "") ||
    !["launching", "awaiting_user"].includes(body.phase ?? "")
  ) {
    throw new Error(`setup job is not attachable (${body.state ?? "unknown"})`);
  }
  const artifactDirectory = join(daemonDir(), "setup-artifacts", jobId);
  const manifest = join(artifactDirectory, "runner-manifest.json");
  if (!existsSync(manifest)) throw new Error("sealed setup manifest is unavailable");
  const runner = resolveSetupLoginRunnerPath();
  if (!existsSync(runner)) throw new Error("setup login runner is unavailable");
  // A sealed login job authorizes exactly one terminal runner. O_EXCL is the
  // cross-process fence; the marker intentionally survives a crashed client so
  // users cancel/recreate instead of accidentally launching the vendor login
  // twice against one daemon-owned job.
  claimSetupAttachment(artifactDirectory);
  return waitForChild(
    spawn(process.execPath, [runner, manifest], {
      cwd: artifactDirectory,
      stdio: "inherit",
      env: process.env,
    }),
  );
}

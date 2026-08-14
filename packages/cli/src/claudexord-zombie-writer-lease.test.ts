import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  compareProcessIdentity,
  defaultProcessIdentityService,
  defaultProcessObservationReader,
  type KnownProcessIdentity,
  type ProcessObservation,
} from "@claudexor/core";
import {
  inspectDaemonWriterLease,
  socketAlive,
  writerLeasePath,
  writerLeaseTombstonePath,
  type DaemonLeaseOwner,
  type DaemonWriterLeaseStatus,
} from "@claudexor/daemon";
import { expect, it } from "vitest";
import { CONTROL_PROTOCOL_MAJOR, controlApiFetch, handshakeControlApi } from "./live.js";

const HOLDER_SCRIPT = String.raw`
const { spawn } = require("node:child_process");
const { existsSync, readFileSync, writeSync } = require("node:fs");
const releasePath = process.env.CX159_RELEASE_PATH;
const emergencyMs = Number(process.env.CX159_EMERGENCY_MS || 45000);
const victim = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
});
if (!victim.pid) throw new Error("victim pid unavailable");
writeSync(1, JSON.stringify({ pid: victim.pid }) + "\n");
const cell = new Int32Array(new SharedArrayBuffer(4));
const deadline = Date.now() + emergencyMs;
let mode = null;
while (mode === null && Date.now() < deadline) {
  if (existsSync(releasePath)) mode = readFileSync(releasePath, "utf8").trim() || "abort";
  if (mode === null) Atomics.wait(cell, 0, 0, 25);
}
if (mode !== "normal") victim.kill("SIGKILL");
victim.once("error", (error) => {
  writeSync(2, String(error && error.message ? error.message : error) + "\n");
  process.exit(2);
});
victim.once("close", () => process.exit(0));
`;

const DEAD_SOCKET_BINDER_SCRIPT = String.raw`
const { writeSync } = require("node:fs");
const { createServer } = require("node:net");
const server = createServer();
server.once("error", (error) => {
  writeSync(2, String(error && error.message ? error.message : error) + "\n");
  process.exit(2);
});
server.listen(process.env.CX159_SOCKET_PATH, () => writeSync(1, "ready\n"));
setInterval(() => {}, 1000);
`;

interface ChildClose {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface ControlPointer {
  host: string;
  port: number;
  tokenPath: string;
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

function childCloseResult(child: ChildProcess): ChildClose | null {
  if (child.exitCode === null && child.signalCode === null) return null;
  return { code: child.exitCode, signal: child.signalCode };
}

function waitForChildClose(child: ChildProcess, timeoutMs: number): Promise<ChildClose> {
  const closed = childCloseResult(child);
  if (closed) return Promise.resolve(closed);
  return new Promise((resolveClose, rejectClose) => {
    const timeout = setTimeout(() => {
      cleanup();
      rejectClose(new Error(`child ${child.pid ?? "unknown"} did not close within ${timeoutMs}ms`));
    }, timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.off("close", onClose);
      child.off("error", onError);
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      resolveClose({ code, signal });
    };
    const onError = (error: Error): void => {
      cleanup();
      rejectClose(error);
    };
    child.once("close", onClose);
    child.once("error", onError);
    const raced = childCloseResult(child);
    if (raced) {
      cleanup();
      resolveClose(raced);
    }
  });
}

function waitForLine(child: ChildProcess, timeoutMs: number): Promise<string> {
  if (!child.stdout) return Promise.reject(new Error("child stdout is not piped"));
  const stdout = child.stdout;
  return new Promise((resolveLine, rejectLine) => {
    let buffered = "";
    stdout.setEncoding("utf8");
    const timeout = setTimeout(() => {
      cleanup();
      rejectLine(new Error(`child ${child.pid ?? "unknown"} produced no line`));
    }, timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timeout);
      stdout.off("data", onData);
      child.off("close", onClose);
      child.off("error", onError);
    };
    const onData = (chunk: string): void => {
      buffered += chunk;
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      const line = buffered.slice(0, newline);
      cleanup();
      resolveLine(line);
    };
    const onClose = (): void => {
      cleanup();
      rejectLine(new Error(`child ${child.pid ?? "unknown"} closed before reporting ready`));
    };
    const onError = (error: Error): void => {
      cleanup();
      rejectLine(error);
    };
    stdout.on("data", onData);
    child.once("close", onClose);
    child.once("error", onError);
  });
}

function captureBoundedStderr(child: ChildProcess, maxBytes = 16 * 1024): () => string {
  let captured = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    captured += chunk;
    if (Buffer.byteLength(captured) > maxBytes) captured = captured.slice(-maxBytes);
  });
  return () => captured;
}

async function waitForValue<T>(
  read: () => T | Promise<T>,
  accept: (value: T) => boolean,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!accept(value) && Date.now() < deadline) {
    await delay(25);
    value = await read();
  }
  if (!accept(value)) throw new Error(`${label} did not converge within ${timeoutMs}ms`);
  return value;
}

async function stopExactChild(child: ChildProcess): Promise<void> {
  if (childCloseResult(child)) return;
  child.kill("SIGTERM");
  try {
    await waitForChildClose(child, 3_000);
  } catch {
    if (!childCloseResult(child)) child.kill("SIGKILL");
    await waitForChildClose(child, 3_000);
  }
}

function parseControlPointer(path: string): ControlPointer | null {
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<ControlPointer>;
    if (
      typeof value.host !== "string" ||
      !value.host ||
      !Number.isInteger(value.port) ||
      Number(value.port) < 1 ||
      typeof value.tokenPath !== "string" ||
      !value.tokenPath
    ) {
      return null;
    }
    return { host: value.host, port: Number(value.port), tokenPath: value.tokenPath };
  } catch {
    return null;
  }
}

function sameZombieObservation(
  observation: ProcessObservation,
  identity: KnownProcessIdentity,
): boolean {
  return (
    observation.linuxState === "Z" &&
    compareProcessIdentity(identity, observation.identity) === "same"
  );
}

it.runIf(process.platform === "linux")(
  "replaces a real zombie writer and publishes an authenticated Control descriptor",
  async () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const daemonEntry = join(repoRoot, "packages", "cli", "dist", "claudexord.js");
    if (!existsSync(daemonEntry) || !lstatSync(daemonEntry).isFile()) {
      throw new Error(`built daemon precondition is missing: ${daemonEntry}`);
    }

    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "cx159-")));
    const home = join(root, "home");
    const configDir = join(root, "config");
    const socketPath = join(root, "d.sock");
    const releasePath = join(root, "release-holder");
    const daemonDir = join(configDir, "daemon");
    const pointerPath = join(daemonDir, "control-api.json");
    const tokenPath = join(daemonDir, "token");
    const buildSha = "1".repeat(40);
    mkdirSync(home, { mode: 0o700 });
    mkdirSync(configDir, { mode: 0o700 });

    let holder: ChildProcess | null = null;
    let binder: ChildProcess | null = null;
    let replacement: ChildProcess | null = null;
    let holderStderr = (): string => "";
    let binderStderr = (): string => "";
    let replacementStderr = (): string => "";
    let victimPid: number | null = null;
    let victimIdentity: KnownProcessIdentity | null = null;
    let failure: unknown = null;

    try {
      holder = spawn(process.execPath, ["-e", HOLDER_SCRIPT], {
        cwd: root,
        env: {
          ...process.env,
          CX159_RELEASE_PATH: releasePath,
          CX159_EMERGENCY_MS: "45000",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      holderStderr = captureBoundedStderr(holder);
      const holderReport = JSON.parse(await waitForLine(holder, 3_000)) as { pid?: unknown };
      if (!Number.isSafeInteger(holderReport.pid) || Number(holderReport.pid) < 2) {
        throw new Error("holder reported an invalid victim pid");
      }
      victimPid = Number(holderReport.pid);
      const liveIdentity = defaultProcessIdentityService.read(victimPid);
      if (liveIdentity.status !== "known") {
        throw new Error(`victim birth identity is ${liveIdentity.status}`);
      }
      victimIdentity = liveIdentity;

      process.kill(victimPid, "SIGKILL");
      const zombie = await waitForValue(
        () => defaultProcessObservationReader.observe(victimPid!),
        (observation) => sameZombieObservation(observation, victimIdentity!),
        5_000,
        "real Linux zombie",
      );
      expect(zombie.identity).toEqual(victimIdentity);
      expect(() => process.kill(victimPid!, 0)).not.toThrow();

      const staleOwner: DaemonLeaseOwner = {
        pid: victimPid,
        token: "issue-159-zombie-owner",
        identity: victimIdentity,
      };
      const staleOwnerBytes = `${JSON.stringify(staleOwner)}\n`;
      const leasePath = writerLeasePath(socketPath);
      mkdirSync(leasePath, { mode: 0o700 });
      writeFileSync(join(leasePath, "owner.json"), staleOwnerBytes, {
        mode: 0o600,
        flag: "wx",
      });
      const tombstonePath = writerLeaseTombstonePath(leasePath, staleOwner);

      binder = spawn(process.execPath, ["-e", DEAD_SOCKET_BINDER_SCRIPT], {
        cwd: root,
        env: { ...process.env, CX159_SOCKET_PATH: socketPath },
        stdio: ["ignore", "pipe", "pipe"],
      });
      binderStderr = captureBoundedStderr(binder);
      expect(await waitForLine(binder, 3_000)).toBe("ready");
      binder.kill("SIGKILL");
      const binderExit = await waitForChildClose(binder, 3_000);
      expect(binderExit.signal).toBe("SIGKILL");
      expect(lstatSync(socketPath).isSocket()).toBe(true);
      expect(await socketAlive(socketPath)).toBe(false);

      const daemonEnv: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        PATH: [dirname(process.execPath), process.env.PATH ?? ""].filter(Boolean).join(":"),
        CLAUDEXOR_CONFIG_DIR: configDir,
        CLAUDEXOR_DAEMON_SOCK: socketPath,
        CLAUDEXOR_CONTROL_PORT: "0",
        CLAUDEXOR_BUILD_SHA: buildSha,
      };
      delete daemonEnv.CLAUDEXOR_NO_CONTROL_API;
      replacement = spawn(process.execPath, [daemonEntry], {
        cwd: repoRoot,
        env: daemonEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });
      replacementStderr = captureBoundedStderr(replacement);
      const replacementPid = replacement.pid;
      if (!replacementPid) throw new Error("replacement daemon pid is unavailable");

      const pointer = await waitForValue(
        () => parseControlPointer(pointerPath),
        (value): value is ControlPointer => value !== null,
        25_000,
        "fresh control-api.json",
      );
      if (!pointer) throw new Error("fresh control-api.json vanished after readiness");
      expect(pointer.tokenPath).toBe(tokenPath);
      expect(realpathSync(pointer.tokenPath)).toBe(tokenPath);
      const token = readFileSync(tokenPath, "utf8").trim();
      if (!token) throw new Error("fresh daemon token is empty");
      const addr = { baseUrl: `http://${pointer.host}:${pointer.port}`, token };

      const health = await controlApiFetch(addr, "/healthz", {
        signal: AbortSignal.timeout(2_000),
      });
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ ok: true });
      const engine = await handshakeControlApi(addr, "issue-159-linux-acceptance");
      expect(engine.engineBuildSha).toBe(buildSha);
      expect(engine.engineVersion).not.toBeNull();
      const handshakeResponse = await controlApiFetch(addr, "/v2/handshake", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          protocolMajor: CONTROL_PROTOCOL_MAJOR,
          client: "issue-159-linux-acceptance-envelope",
        }),
      });
      expect(handshakeResponse.status).toBe(200);
      const handshake = (await handshakeResponse.json()) as {
        engine?: { sha?: unknown; entry?: unknown };
      };
      expect(handshake.engine?.sha).toBe(buildSha);
      expect(resolve(String(handshake.engine?.entry ?? ""))).toBe(realpathSync(daemonEntry));

      const replacementLease = inspectDaemonWriterLease(socketPath);
      if (replacementLease.status !== "owned") {
        throw new Error(`replacement writer lease is ${replacementLease.status}`);
      }
      expect(replacementLease.capability.status).toBe("capable");
      expect(replacementLease.owner.pid).toBe(replacementPid);
      expect(replacementLease.owner.token).not.toBe(staleOwner.token);
      expect(readFileSync(join(tombstonePath, "owner.json"), "utf8")).toBe(staleOwnerBytes);
      expect(readFileSync(join(replacementLease.path, "owner.json"), "utf8")).not.toBe(
        staleOwnerBytes,
      );
      expect(
        sameZombieObservation(defaultProcessObservationReader.observe(victimPid), victimIdentity),
      ).toBe(true);

      replacement.kill("SIGTERM");
      const replacementExit = await waitForChildClose(replacement, 12_000);
      expect(replacementExit).toEqual({ code: 0, signal: null });
      const released = await waitForValue<DaemonWriterLeaseStatus>(
        () => inspectDaemonWriterLease(socketPath),
        (status) => status.status === "absent",
        3_000,
        "replacement writer-lease release",
      );
      expect(released.status).toBe("absent");

      writeFileSync(releasePath, "normal\n", { mode: 0o600 });
      const holderExit = await waitForChildClose(holder, 5_000);
      expect(holderExit).toEqual({ code: 0, signal: null });
      const finalIdentity = await waitForValue(
        () => defaultProcessIdentityService.read(victimPid!),
        (identity) => compareProcessIdentity(victimIdentity!, identity) !== "same",
        3_000,
        "zombie reap",
      );
      expect(compareProcessIdentity(victimIdentity, finalIdentity)).not.toBe("same");
    } catch (error) {
      failure = error;
    } finally {
      const cleanupErrors: string[] = [];
      for (const child of [replacement, binder]) {
        if (!child) continue;
        try {
          await stopExactChild(child);
        } catch (error) {
          cleanupErrors.push(error instanceof Error ? error.message : String(error));
        }
      }
      if (holder && !childCloseResult(holder)) {
        try {
          let releaseMode = "abort";
          if (victimPid && victimIdentity) {
            const current = defaultProcessObservationReader.observe(victimPid);
            if (sameZombieObservation(current, victimIdentity)) releaseMode = "normal";
          }
          writeFileSync(releasePath, `${releaseMode}\n`, { mode: 0o600 });
          await waitForChildClose(holder, 5_000);
        } catch (error) {
          cleanupErrors.push(error instanceof Error ? error.message : String(error));
        }
      }
      if (![holder, binder, replacement].some((child) => child && !childCloseResult(child))) {
        rmSync(root, { recursive: true, force: true });
      }
      if (cleanupErrors.length > 0 && failure === null) {
        failure = new Error(`cleanup failed: ${cleanupErrors.join("; ")}`);
      }
    }

    if (failure !== null) {
      const detail = failure instanceof Error ? failure.message : String(failure);
      throw new Error(
        [
          detail,
          `holder stderr:\n${holderStderr()}`,
          `socket binder stderr:\n${binderStderr()}`,
          `replacement stderr:\n${replacementStderr()}`,
        ].join("\n"),
        { cause: failure },
      );
    }
  },
  60_000,
);

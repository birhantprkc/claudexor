import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { journalPartitionDirectory } from "@claudexor/journal";
import { afterEach, describe, expect, it } from "vitest";

/**
 * C6 (sol SCOPE-04 + grok G-REC-01), proven against the BUILT daemon entry:
 * (a) a recovery-required startup verdict binds the control API even under
 * CLAUDEXOR_NO_CONTROL_API=1 — the recovery surface IS the point of the
 * recovery plane; (b) a successful recovery-route quarantine re-runs the
 * admission completion IN PROCESS, so product routes open without a restart.
 */

const daemonEntry = resolve(import.meta.dirname, "../dist/claudexord.js");
const cleanups: Array<() => void | Promise<void>> = [];

// Dispose in REVERSE registration order so a spawned daemon is killed and
// REAPED before its root is removed: a SIGTERMed daemon still writes during
// shutdown, and a recursive rm racing those writes fails ENOTEMPTY on Linux.
afterEach(async () => {
  for (const dispose of cleanups.splice(0).reverse()) await dispose();
});

function corruptGlobalRoot(): string {
  // A SHORT real root (belt-entry convention): the daemon binds a Unix socket
  // under it, and the darwin per-user tmpdir would blow the 104-char limit.
  const root = realpathSync(mkdtempSync(join(realpathSync("/tmp"), "cx-reopen-")));
  cleanups.push(() =>
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  );
  const config = join(root, "config");
  const partitionDir = journalPartitionDirectory(join(config, "daemon", "journal"), "global");
  mkdirSync(partitionDir, { recursive: true });
  for (const dir of [config, join(config, "daemon"), join(config, "daemon", "journal")]) {
    chmodSync(dir, 0o700);
  }
  chmodSync(partitionDir, 0o700);
  writeFileSync(join(partitionDir, "journal.bin"), "GARBAGE-NOT-A-JOURNAL-FRAME", { mode: 0o600 });
  return config;
}

/** Mixed-root fixture (S2-CR1): a HEALTHY global journal with `count`
 * registered projects, built by a real seed daemon so the registry and the
 * project partitions carry genuine bytes. The caller corrupts partitions. */
async function seedRegisteredProjects(
  count: number,
): Promise<{ config: string; projectIds: string[] }> {
  const root = realpathSync(mkdtempSync(join(realpathSync("/tmp"), "cx-mixed-")));
  cleanups.push(() =>
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  );
  const config = join(root, "config");
  mkdirSync(config, { recursive: true });
  chmodSync(config, 0o700);
  const daemon = spawnDaemon(config);
  const addr = await waitFor(
    () => (daemon.exitCode !== null ? null : controlAddress(config)),
    "the seed daemon control API pointer",
  );
  try {
    await waitForServingMode(addr, "normal");
  } catch (error) {
    let log = "";
    try {
      log = readFileSync(join(config, "daemon", "claudexord.log"), "utf8").slice(-1500);
    } catch {}
    throw new Error(
      `seed daemon never reached normal: ${error instanceof Error ? error.message : String(error)}; exitCode=${daemon.exitCode}; stderr=${daemon.stderrText().slice(-1000)}; log=${log}`,
    );
  }
  const projectIds: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const projectRoot = join(root, `project-${index}`);
    mkdirSync(projectRoot, { recursive: true });
    const response = await fetch(`${addr.base}/v2/projects`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${addr.token}`,
        "x-claudexor-protocol-major": "3",
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
      },
      body: JSON.stringify({ root: projectRoot }),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    projectIds.push(((await response.json()) as { id: string }).id);
  }
  daemon.kill("SIGTERM");
  await waitFor(() => (daemon.exitCode === null ? null : true), "the seed daemon to exit");
  // Drop the seed daemon's control pointer so the daemon under test cannot be
  // probed through a stale address before it publishes its own.
  rmSync(join(config, "daemon", "control-api.json"), { force: true });
  return { config, projectIds };
}

function corruptProjectPartition(config: string, projectId: string): void {
  const partitionDir = journalPartitionDirectory(
    join(config, "daemon", "journal"),
    `project:${projectId}`,
  );
  writeFileSync(join(partitionDir, "journal.bin"), "GARBAGE-NOT-A-JOURNAL-FRAME", {
    mode: 0o600,
  });
}

async function waitForServingMode(
  addr: { base: string; token: string },
  expected: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let servingMode = "";
  while (Date.now() < deadline) {
    servingMode = String((await handshake(addr)).servingMode ?? "");
    if (servingMode === expected) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  expect(servingMode, `handshake never reported ${expected} serving`).toBe(expected);
}

async function inspectPartition(
  addr: { base: string; token: string },
  partition: string,
): Promise<{ fingerprint: string; status: string }> {
  const response = await fetch(
    `${addr.base}/v2/recovery/partitions/${encodeURIComponent(partition)}`,
    {
      headers: {
        authorization: `Bearer ${addr.token}`,
        "x-claudexor-protocol-major": "3",
      },
    },
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as { fingerprint: string; status: string };
}

async function quarantinePartition(
  addr: { base: string; token: string },
  partition: string,
  expectedFingerprint: string,
): Promise<void> {
  const response = await fetch(
    `${addr.base}/v2/recovery/partitions/${encodeURIComponent(partition)}/quarantine`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${addr.token}`,
        "x-claudexor-protocol-major": "3",
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
      },
      body: JSON.stringify({
        expectedFingerprint,
        confirmation: "quarantine_and_start_fresh",
      }),
    },
  );
  expect(response.status, await response.clone().text()).toBe(200);
}

function spawnDaemon(
  config: string,
  extraEnv: Record<string, string> = {},
): ChildProcess & { stderrText: () => string } {
  const child = spawn(process.execPath, [daemonEntry], {
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      HOME: process.env.HOME ?? "/tmp",
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      CLAUDEXOR_CONFIG_DIR: config,
      ...extraEnv,
    },
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  cleanups.push(async () => {
    if (child.exitCode !== null) return;
    child.kill("SIGKILL");
    await waitFor(
      () => (child.exitCode === null && child.signalCode === null ? null : true),
      "the daemon to be reaped",
    );
  });
  return Object.assign(child, { stderrText: () => stderr });
}

async function waitFor<T>(probe: () => T | null, what: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

function controlAddress(config: string): { base: string; token: string } | null {
  const pointer = join(config, "daemon", "control-api.json");
  const tokenPath = join(config, "daemon", "token");
  if (!existsSync(pointer) || !existsSync(tokenPath)) return null;
  try {
    const addr = JSON.parse(readFileSync(pointer, "utf8")) as { host: string; port: number };
    return {
      base: `http://${addr.host}:${addr.port}`,
      token: readFileSync(tokenPath, "utf8").trim(),
    };
  } catch {
    return null;
  }
}

async function handshake(addr: { base: string; token: string }): Promise<Record<string, unknown>> {
  const response = await fetch(`${addr.base}/v2/handshake`, {
    method: "POST",
    headers: { authorization: `Bearer ${addr.token}`, "content-type": "application/json" },
    body: JSON.stringify({ protocolMajor: 3, client: "reopen-test" }),
  });
  expect(response.ok).toBe(true);
  return (await response.json()) as Record<string, unknown>;
}

describe("recovery plane availability and in-process reopen (C6)", () => {
  it("binds the control API on a recovery-required verdict even under CLAUDEXOR_NO_CONTROL_API=1", async () => {
    const config = corruptGlobalRoot();
    const daemon = spawnDaemon(config, { CLAUDEXOR_NO_CONTROL_API: "1" });
    const addr = await waitFor(
      () => (daemon.exitCode !== null ? null : controlAddress(config)),
      "the recovery-plane control API pointer",
    ).catch((error: unknown) => {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; daemon stderr: ${daemon.stderrText().slice(-500)}`,
      );
    });
    const hello = await handshake(addr);
    expect(hello.servingMode).toBe("recovery_only");
    // The override is disclosed in the daemon log.
    const log = readFileSync(join(config, "daemon", "claudexord.log"), "utf8");
    expect(log).toContain("CLAUDEXOR_NO_CONTROL_API=1");
    daemon.kill("SIGTERM");
  }, 40_000);

  it("opens product routes in process after a recovery-route quarantine (no restart)", async () => {
    const config = corruptGlobalRoot();
    const daemon = spawnDaemon(config);
    const daemonPid = await waitFor(() => daemon.pid ?? null, "daemon pid");
    const addr = await waitFor(
      () => (daemon.exitCode !== null ? null : controlAddress(config)),
      "the control API pointer",
    ).catch((error: unknown) => {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; daemon stderr: ${daemon.stderrText().slice(-500)}`,
      );
    });
    expect((await handshake(addr)).servingMode).toBe("recovery_only");
    const authed = {
      authorization: `Bearer ${addr.token}`,
      "x-claudexor-protocol-major": "3",
    };
    // Product routes are typed-closed on the recovery plane.
    const closed = await fetch(`${addr.base}/v2/threads`, { headers: authed });
    expect(closed.status).toBe(503);
    expect(((await closed.json()) as { code?: string }).code).toBe("daemon_recovery_only");

    // Operator recovery: inspect the corrupt partition, then quarantine it.
    const inspected = await fetch(`${addr.base}/v2/recovery/partitions/global`, {
      headers: authed,
    });
    expect(inspected.status).toBe(200);
    const inspection = (await inspected.json()) as { fingerprint: string; status: string };
    expect(inspection.status).toBe("recovery_required");
    const quarantined = await fetch(`${addr.base}/v2/recovery/partitions/global/quarantine`, {
      method: "POST",
      headers: {
        ...authed,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
      },
      body: JSON.stringify({
        expectedFingerprint: inspection.fingerprint,
        confirmation: "quarantine_and_start_fresh",
      }),
    });
    expect(quarantined.status, await quarantined.clone().text()).toBe(200);

    // The SAME process must transition to normal serving: handshake reports
    // normal and product routes answer, without any restart.
    const deadline = Date.now() + 20_000;
    let servingMode = "";
    while (Date.now() < deadline) {
      servingMode = String((await handshake(addr)).servingMode ?? "");
      if (servingMode === "normal") break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(servingMode, "handshake never reported normal serving after the quarantine").toBe(
      "normal",
    );
    const open = await fetch(`${addr.base}/v2/threads`, { headers: authed });
    expect(open.status, await open.clone().text()).toBe(200);
    expect(daemon.pid).toBe(daemonPid);
    expect(daemon.exitCode).toBeNull();
    // The quarantined bytes were preserved, never deleted.
    expect(existsSync(join(config, "daemon", "journal-quarantine"))).toBe(true);
    daemon.kill("SIGTERM");
  }, 60_000);

  it("quarantining a corrupt PROJECT partition never poisons the healthy global sibling (S2-CR1)", async () => {
    const { config, projectIds } = await seedRegisteredProjects(1);
    const partition = `project:${projectIds[0]}`;
    corruptProjectPartition(config, projectIds[0]!);
    const daemon = spawnDaemon(config);
    const daemonPid = await waitFor(() => daemon.pid ?? null, "daemon pid");
    const addr = await waitFor(
      () => (daemon.exitCode !== null ? null : controlAddress(config)),
      "the control API pointer",
    ).catch((error: unknown) => {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; daemon stderr: ${daemon.stderrText().slice(-500)}`,
      );
    });
    expect((await handshake(addr)).servingMode).toBe("recovery_only");
    expect((await inspectPartition(addr, "global")).status).toBe("ready");
    const projectInspection = await inspectPartition(addr, partition);
    expect(projectInspection.status).toBe("recovery_required");

    await quarantinePartition(addr, partition, projectInspection.fingerprint);

    // The healthy global sibling was NEVER flipped to recovery_required by
    // the project quarantine's recovery-operations infrastructure write.
    expect((await inspectPartition(addr, "global")).status).toBe("ready");
    // The SAME process reaches normal serving without a restart.
    await waitForServingMode(addr, "normal");
    expect((await inspectPartition(addr, "global")).status).toBe("ready");
    expect(daemon.pid).toBe(daemonPid);
    expect(daemon.exitCode).toBeNull();
    daemon.kill("SIGTERM");
  }, 90_000);

  it("reopens in process after quarantining TWO broken project partitions in sequence (S2-CR1)", async () => {
    const { config, projectIds } = await seedRegisteredProjects(2);
    const [firstPartition, secondPartition] = projectIds.map((id) => `project:${id}`) as [
      string,
      string,
    ];
    corruptProjectPartition(config, projectIds[0]!);
    corruptProjectPartition(config, projectIds[1]!);
    const daemon = spawnDaemon(config);
    const daemonPid = await waitFor(() => daemon.pid ?? null, "daemon pid");
    const addr = await waitFor(
      () => (daemon.exitCode !== null ? null : controlAddress(config)),
      "the control API pointer",
    ).catch((error: unknown) => {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; daemon stderr: ${daemon.stderrText().slice(-500)}`,
      );
    });
    expect((await handshake(addr)).servingMode).toBe("recovery_only");
    const firstInspection = await inspectPartition(addr, firstPartition);
    expect(firstInspection.status).toBe("recovery_required");
    await quarantinePartition(addr, firstPartition, firstInspection.fingerprint);

    // Still protected: the live re-verdict lists EXACTLY the second broken
    // partition — the first reopened in place and global stays healthy.
    expect((await handshake(addr)).servingMode).toBe("recovery_only");
    expect((await inspectPartition(addr, firstPartition)).status).toBe("ready");
    expect((await inspectPartition(addr, "global")).status).toBe("ready");
    // The re-verdict log line lands asynchronously after the quarantine
    // response, so poll for it instead of racing a single read.
    const lastVerdict = await waitFor(() => {
      const log = readFileSync(join(config, "daemon", "claudexord.log"), "utf8");
      const verdicts = [
        ...log.matchAll(/serving recovery only [^(]*\(recovery required: ([^)]+)\)/g),
      ];
      const last = verdicts.at(-1)?.[1] ?? null;
      return last === secondPartition ? last : null;
    }, `the post-quarantine re-verdict listing exactly ${secondPartition}`);
    expect(lastVerdict).toBe(secondPartition);

    const secondInspection = await inspectPartition(addr, secondPartition);
    expect(secondInspection.status).toBe("recovery_required");
    await quarantinePartition(addr, secondPartition, secondInspection.fingerprint);

    await waitForServingMode(addr, "normal");
    expect((await inspectPartition(addr, "global")).status).toBe("ready");
    expect(daemon.pid).toBe(daemonPid);
    expect(daemon.exitCode).toBeNull();
    daemon.kill("SIGTERM");
  }, 120_000);
});

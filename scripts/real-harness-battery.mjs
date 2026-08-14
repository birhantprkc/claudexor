#!/usr/bin/env node
/**
 * Real-harness synthetic battery for Claudexor.
 *
 * This is intentionally NOT a unit test. It runs real codex/claude/cursor
 * harnesses against disposable git repositories and asserts engine-owned
 * artifacts (decision/work_product/telemetry/review files), so it covers the
 * quality surfaces the deterministic fake smoke cannot.
 *
 * Safety:
 * - never targets the Claudexor repo as a mutation target;
 * - defaults to a temp CLAUDEXOR_CONFIG_DIR for daemon/settings state;
 * - may use the exact default config only through an explicit, guarded VM lane;
 * - keeps HOME native so real harness sessions/Keychain remain available;
 * - never prints secret values.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import {
  assertNoPreexistingDaemon,
  assertRegularFileUnchanged,
  describeFileSnapshot,
  durableAttemptRouteEvidence,
  evaluateRequiredNativeRoutes,
  isBatteryRepoRoot,
  isCrossFamilyConvergenceRefusal,
  relevantRunAttemptKeys,
  resolveRealHarnessBatteryLayout,
  runtimeReplacementIdentityFromHandshake,
  sameDaemonLease,
  snapshotRegularFile,
  validateBatteryRunArtifacts,
  validateBatteryTaskIdentity,
} from "./lib/real-harness-battery-state.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "packages", "cli", "dist", "cli.js");
const nodeBin = process.execPath;
const home = homedir();
delete process.env.CLAUDEXOR_BATTERY_BUILD_VERIFIED;
const forcedBuildStartedAt = new Date().toISOString();
const forcedBuildCommand = [join(root, "node_modules", ".bin", "turbo"), "run", "build", "--force"];
const forcedBuildResult = spawnSync(forcedBuildCommand[0], forcedBuildCommand.slice(1), {
  cwd: root,
  env: process.env,
  stdio: "inherit",
});
const forcedBuildReceipt = {
  command: "turbo run build --force",
  startedAt: forcedBuildStartedAt,
  finishedAt: new Date().toISOString(),
  exitCode: typeof forcedBuildResult.status === "number" ? forcedBuildResult.status : 1,
  candidateSha: null,
  candidateTree: null,
};
if (forcedBuildReceipt.exitCode !== 0) {
  throw new Error(
    `forced workspace build failed before the real-harness battery started (exit ${forcedBuildReceipt.exitCode}${forcedBuildResult.error ? `; ${forcedBuildResult.error.message}` : ""})`,
  );
}

// Import every compiled workspace dependency only AFTER the entrypoint-owned,
// uncached build completed. A stale dist module can therefore never enter this
// process before the build proof it is supposed to exercise.
const [artifactStoreModule, daemonModule, schemaModule, utilModule, runtimeStopModule] =
  await Promise.all([
    import("../packages/artifact-store/dist/index.js"),
    import("../packages/daemon/dist/index.js"),
    import("../packages/schema/dist/index.js"),
    import("../packages/util/dist/index.js"),
    import("../packages/cli/dist/runtime-replacement-stop.js"),
  ]);
const { ArtifactStore } = artifactStoreModule;
const {
  awaitDaemonTermination,
  DaemonClient,
  daemonLeaseOwner,
  defaultSocketPath,
  processIsAlive,
  readToken,
  socketAlive,
} = daemonModule;
const {
  ControlRunDetail,
  FrozenTaskContractArtifact,
  HarnessEvent,
  RunDeliveryState,
  RunEvent,
  RunTelemetry,
} = schemaModule;
const { CLAUDEXOR_VERSION, redactSecrets } = utilModule;
const { admitAndAwaitRuntimeReplacementStop } = runtimeStopModule;

const runId = new Date().toISOString().replace(/[:.]/g, "-");
const defaultRoot = join(home, ".claudexor", "dogfood", `battery-${runId}`);
const layout = resolveRealHarnessBatteryLayout({
  home,
  sourceRoot: root,
  defaultBatteryRoot: defaultRoot,
  batteryDir: process.env.CLAUDEXOR_BATTERY_DIR,
  requestedConfigDir: process.env.CLAUDEXOR_BATTERY_CONFIG_DIR,
  ambientConfigDir: process.env.CLAUDEXOR_CONFIG_DIR,
});
const { batteryRoot, configDir } = layout;
const resultsDir = join(batteryRoot, "results");
const reposDir = join(batteryRoot, "repos");
const logsDir = join(batteryRoot, "logs");
const maxUsd = process.env.CLAUDEXOR_BATTERY_MAX_USD ?? "1.50";
const timeoutMs = Number(process.env.CLAUDEXOR_BATTERY_TIMEOUT_MS ?? 20 * 60_000);
const requestedHarnesses = (process.env.CLAUDEXOR_BATTERY_HARNESSES ?? "codex,claude,cursor")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const marker = process.env.CLAUDEXOR_BATTERY_IMAGE_MARKER ?? "CLAUDEXOR-7521";
// Optional phase filter (e.g. "10,11,12"): an operator iterating on one
// surface should not re-burn the whole battery. Default: every phase.
const phaseFilter = (process.env.CLAUDEXOR_BATTERY_PHASES ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => `phase${s.replace(/^phase/, "")}`);
const phaseEnabled = (id) => phaseFilter.length === 0 || phaseFilter.includes(id);

if (layout.mode === "scratch") mkdirSync(configDir, { recursive: true, mode: 0o700 });
mkdirSync(resultsDir, { recursive: true, mode: 0o700 });
mkdirSync(reposDir, { recursive: true, mode: 0o700 });
mkdirSync(logsDir, { recursive: true, mode: 0o700 });

const protectedConfigPath = join(configDir, "config.yaml");
const protectedConfigBefore =
  layout.mode === "existing_default" ? snapshotRegularFile(protectedConfigPath) : null;

const env = {
  ...process.env,
  PATH: [
    join(home, ".claudexor", "node", "bin"),
    join(home, ".local", "bin"),
    process.env.PATH ?? "",
  ]
    .filter(Boolean)
    .join(":"),
  CLAUDEXOR_DAEMON_ENTRY: join(root, "packages", "cli", "dist", "claudexord.js"),
  CLAUDEXOR_DOCTOR_TTL_MS: "0",
};
if (layout.exportConfigDir) env.CLAUDEXOR_CONFIG_DIR = configDir;
else delete env.CLAUDEXOR_CONFIG_DIR;
if (existsSync(join(home, ".local", "bin", "cursor-agent"))) {
  env.CLAUDEXOR_CURSOR_BIN = join(home, ".local", "bin", "cursor-agent");
}
if (existsSync(join(home, ".claudexor", "node", "bin", "codex"))) {
  env.CLAUDEXOR_CODEX_BIN = join(home, ".claudexor", "node", "bin", "codex");
}
if (existsSync(join(home, ".claudexor", "node", "bin", "claude"))) {
  env.CLAUDEXOR_CLAUDE_BIN = join(home, ".claudexor", "node", "bin", "claude");
}
// The in-process Control API phase must resolve the same isolated daemon and
// harness binaries as child CLI invocations.
if (!layout.exportConfigDir) delete process.env.CLAUDEXOR_CONFIG_DIR;
Object.assign(process.env, env);

const results = [];
const evidence = {
  batteryRoot,
  configDir,
  configMode: layout.mode,
  configBefore: protectedConfigBefore ? describeFileSnapshot(protectedConfigBefore) : null,
  configAfter: null,
  configUnchanged: layout.mode === "scratch" ? null : false,
  forcedBuildVerified: true,
  forcedBuild: forcedBuildReceipt,
  cli,
  node: nodeBin,
  version: null,
  candidate: { sha: null, tree: null },
  daemon: { start: null, handshake: null, entrySha256: null, stop: null },
  requestedHarnesses,
  okHarnesses: [],
  harnessReports: {},
};
const runtimeState = {
  daemonOwned: false,
  daemonClient: null,
  daemonIdentity: null,
  daemonLease: null,
  baselineJobIds: new Set(),
};

function rel(path) {
  return path.startsWith(root) ? path.slice(root.length + 1) : path;
}

function logPath(name) {
  return join(logsDir, `${name.replace(/[^a-z0-9_.-]+/gi, "_")}.log`);
}

function record(status, phase, name, detail = {}, extras = {}) {
  const item = { status, phase, name, detail: redactDetail(detail), ...redactDetail(extras) };
  results.push(item);
  const tag =
    status === "pass" ? "PASS" : status === "skip" ? "SKIP" : status === "env" ? "ENV" : "FAIL";
  const summary = typeof item.detail === "string" ? item.detail : JSON.stringify(item.detail);
  process.stdout.write(
    `${tag.padEnd(5)} ${phase.padEnd(10)} ${name.padEnd(44)} ${summary.slice(0, 180)}\n`,
  );
  return item;
}

function pass(phase, name, detail = {}, extras = {}) {
  return record("pass", phase, name, detail, extras);
}
function fail(phase, name, detail = {}, extras = {}) {
  return record("fail", phase, name, detail, extras);
}
function skip(phase, name, detail = {}, extras = {}) {
  return record("skip", phase, name, detail, extras);
}
function envfail(phase, name, detail = {}, extras = {}) {
  return record("env", phase, name, detail, extras);
}

function isTransientEnvOutput(out) {
  const text = [out.stdout, out.stderr, out.error, JSON.stringify(out.json ?? {})]
    .join("\n")
    .toLowerCase();
  return (
    text.includes("stream disconnected") ||
    text.includes("failed to lookup address information") ||
    text.includes("nodename nor servname") ||
    text.includes("enotfound") ||
    text.includes("eai_again") ||
    text.includes("econnreset") ||
    text.includes("etimedout")
  );
}

function redactDetail(value) {
  if (typeof value === "string") return redactSecrets(value);
  try {
    return JSON.parse(redactSecrets(JSON.stringify(value)));
  } catch {
    return redactSecrets(String(value));
  }
}

function run(cmd, args, opts = {}) {
  const cwd = opts.cwd ?? root;
  const res = spawnSync(cmd, args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    timeout: opts.timeoutMs ?? timeoutMs,
  });
  return {
    code: typeof res.status === "number" ? res.status : 1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    error: res.error ? String(res.error) : "",
  };
}

function runGit(args, cwd) {
  const res = run("git", args, { cwd, timeoutMs: 120_000 });
  if (res.code !== 0)
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${res.stderr || res.stdout}`);
  return res.stdout.trim();
}

function runCli(args, opts = {}) {
  const name = opts.name ?? args.join(" ");
  const cwd = opts.cwd ?? root;
  let out = run(nodeBin, [cli, ...args], { cwd, timeoutMs: opts.timeoutMs ?? timeoutMs });
  let retriedForEnv = false;
  if (out.code !== 0 && isTransientEnvOutput({ ...out, json: null }) && opts.envRetry !== false) {
    retriedForEnv = true;
    out = run(nodeBin, [cli, ...args], { cwd, timeoutMs: opts.timeoutMs ?? timeoutMs });
  }
  const lp = logPath(name);
  writeFileSync(
    lp,
    [
      `$ claudexor ${args.join(" ")}`,
      `cwd=${cwd}`,
      `exit=${out.code}`,
      "",
      redactSecrets(out.stdout),
      redactSecrets(out.stderr),
      redactSecrets(out.error),
    ].join("\n"),
  );
  let json = null;
  if (opts.json !== false && out.stdout.trim().startsWith("{")) {
    try {
      json = JSON.parse(out.stdout);
    } catch {
      /* recorded by caller if needed */
    }
  }
  return {
    ...out,
    json,
    log: lp,
    cwd,
    retriedForEnv,
    envFailure: out.code !== 0 && isTransientEnvOutput({ ...out, json }),
  };
}

function runCliJson(args, opts = {}) {
  return runCli([...args, "--json"], { ...opts, json: true });
}

function runCliText(args, opts = {}) {
  return runCli(args, { ...opts, json: false });
}

async function startBatteryDaemon() {
  const socketPath = defaultSocketPath();
  const expectedEntry = join(root, "packages", "cli", "dist", "claudexord.js");
  evidence.daemon.entrySha256 = createHash("sha256")
    .update(readFileSync(expectedEntry))
    .digest("hex");
  const preflight = runCliJson(["daemon", "status"], {
    name: "daemon-preflight",
    envRetry: false,
  });
  const preflightLease = daemonLeaseOwner(socketPath);
  const preflightSocketAlive = await socketAlive(socketPath);
  assertNoPreexistingDaemon({
    statusCode: preflight.code,
    socketIsAlive: preflightSocketAlive,
    leaseIsAlive: Boolean(preflightLease && processIsAlive(preflightLease.pid)),
  });

  const started = runCliJson(["daemon", "start"], {
    name: "daemon-start",
    envRetry: false,
  });
  const startedPid = started.json?.pid;
  const lease = daemonLeaseOwner(socketPath);
  if (Number.isSafeInteger(startedPid) && startedPid > 0 && lease?.pid === startedPid) {
    const token = readToken();
    if (token) {
      // Capture cleanup authority as soon as the detached child proves writer
      // ownership. A later readiness/handshake failure must not leak it.
      runtimeState.daemonOwned = true;
      runtimeState.daemonLease = lease;
      runtimeState.daemonClient = new DaemonClient(socketPath, token);
      evidence.daemon.start = {
        pid: startedPid,
        ready: started.json?.ready === true,
        alreadyRunning: started.json?.alreadyRunning === true,
        processIdentity: lease.identity?.status ?? null,
      };
    }
  }
  if (
    started.code !== 0 ||
    started.json?.ready !== true ||
    started.json?.alreadyRunning === true ||
    !Number.isSafeInteger(startedPid) ||
    startedPid <= 0
  ) {
    throw new Error(`battery could not prove a fresh daemon start; inspect ${started.log}`);
  }
  if (!runtimeState.daemonOwned || !lease || lease.pid !== startedPid) {
    throw new Error("fresh daemon pid does not own the writer lease; refusing cleanup authority");
  }

  const [{ ensureDaemon }, { controlApiFetch, CONTROL_PROTOCOL_MAJOR }] = await Promise.all([
    import("../packages/cli/dist/daemon-run.js"),
    import("../packages/cli/dist/live.js"),
  ]);
  const { addr } = await ensureDaemon();
  const response = await controlApiFetch(addr, "/v2/handshake", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ protocolMajor: CONTROL_PROTOCOL_MAJOR, client: "battery" }),
  });
  if (!response.ok) throw new Error(`battery daemon handshake failed (HTTP ${response.status})`);
  const handshake = await response.json();
  // Capture the identity before candidate validation. A mismatching but valid
  // fresh daemon must still be stopped through the identity-bound RPC.
  runtimeState.daemonIdentity = runtimeReplacementIdentityFromHandshake(handshake);
  if (
    handshake?.engine?.version !== CLAUDEXOR_VERSION ||
    handshake?.engine?.sha !== evidence.candidate.sha ||
    resolve(handshake?.engine?.entry ?? "") !== expectedEntry
  ) {
    throw new Error("battery daemon handshake does not match the exact source candidate");
  }
  evidence.daemon.handshake = {
    version: handshake.engine.version,
    sha: handshake.engine.sha,
    entry: handshake.engine.entry,
    entrySha256: evidence.daemon.entrySha256,
  };
  runtimeState.baselineJobIds = new Set(
    (await runtimeState.daemonClient.list()).map((job) => job.id),
  );
  pass("phase0", "fresh exact-candidate daemon", evidence.daemon.handshake);
}

async function stopBatteryDaemon() {
  if (!runtimeState.daemonOwned) return;
  const socketPath = defaultSocketPath();
  const expectedOwner = runtimeState.daemonLease;
  const client = runtimeState.daemonClient;
  const currentOwner = daemonLeaseOwner(socketPath);
  if (!client || !sameDaemonLease(expectedOwner, currentOwner)) {
    evidence.daemon.stop = {
      stopped: false,
      reason: "captured daemon owner is no longer current; successor left untouched",
    };
    fail("cleanup", "battery-owned daemon stopped", evidence.daemon.stop);
    return;
  }
  try {
    const target = {
      version: runtimeState.daemonIdentity?.version ?? CLAUDEXOR_VERSION,
      buildSha: runtimeState.daemonIdentity?.buildSha ?? evidence.candidate.sha,
      leaseOwner: { pid: expectedOwner.pid, token: expectedOwner.token },
    };
    const termination = await admitAndAwaitRuntimeReplacementStop(
      () => client.shutdownForRuntimeReplacement(target),
      (options) => awaitDaemonTermination(socketPath, options),
      expectedOwner,
    );
    const leaseReleased = daemonLeaseOwner(socketPath) === null;
    const valid = termination.outcome !== "still_alive" && leaseReleased;
    evidence.daemon.stop = {
      stopped: valid,
      outcome: termination.outcome,
      detail: termination.detail,
      leaseReleased,
    };
    (valid ? pass : fail)("cleanup", "battery-owned daemon stopped", evidence.daemon.stop);
    if (valid) runtimeState.daemonOwned = false;
  } catch (error) {
    evidence.daemon.stop = {
      stopped: false,
      reason: error instanceof Error ? error.message : String(error),
    };
    fail("cleanup", "battery-owned daemon stopped", evidence.daemon.stop);
  }
}

function verifyProtectedConfig() {
  if (!protectedConfigBefore) return;
  try {
    const after = assertRegularFileUnchanged(protectedConfigPath, protectedConfigBefore);
    evidence.configAfter = describeFileSnapshot(after);
    evidence.configUnchanged = true;
    pass("cleanup", "default config remained byte-identical", evidence.configAfter);
  } catch (error) {
    evidence.configAfter = (() => {
      try {
        return describeFileSnapshot(snapshotRegularFile(protectedConfigPath));
      } catch {
        return null;
      }
    })();
    evidence.configUnchanged = false;
    fail("cleanup", "default config remained byte-identical", {
      error: error instanceof Error ? error.message : String(error),
      before: evidence.configBefore,
      after: evidence.configAfter,
    });
  }
}

function inspectRun(runId, cwd) {
  const out = runCliJson(["inspect", runId], { cwd, name: `inspect ${runId}` });
  return out.json;
}

async function verifyNativeSessionRoutes() {
  if (layout.mode !== "existing_default") return;
  const requiredHarnesses = requestedHarnesses.filter((h) => h === "codex" || h === "claude");
  const observed = [];
  let jobs;
  try {
    jobs = await runtimeState.daemonClient.list();
  } catch (error) {
    fail("acceptance", "complete battery run inventory", {
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  const postBaselineJobs = jobs.filter((job) => !runtimeState.baselineJobIds.has(job.id));
  const batteryJobs = [];
  const concurrentJobs = [];
  const inventoryErrors = [];
  const store = new ArtifactStore(root);
  for (const job of postBaselineJobs) {
    const rawTask =
      typeof job.runDir === "string"
        ? store.readYaml(join(job.runDir, "context", "task.yaml"))
        : null;
    const taskResult = validateBatteryTaskIdentity({
      job,
      task: rawTask,
      taskSchema: FrozenTaskContractArtifact,
    });
    if (!taskResult.valid) {
      inventoryErrors.push({
        jobId: job.id,
        runId: job.runId ?? null,
        reason: taskResult.reason,
      });
      continue;
    }
    if (isBatteryRepoRoot(reposDir, taskResult.task.repo.root)) {
      batteryJobs.push({ job, task: taskResult.task });
    } else
      concurrentJobs.push({
        jobId: job.id,
        runId: job.runId ?? null,
        state: job.state ?? null,
      });
  }
  const seenRunDirs = new Set();
  for (const { job, task } of batteryJobs) {
    if (typeof job.runDir !== "string") continue;
    if (seenRunDirs.has(job.runDir)) continue;
    seenRunDirs.add(job.runDir);
    const telemetryPath = join(job.runDir, "final", "telemetry.yaml");
    let eventText;
    try {
      eventText = readFileSync(join(job.runDir, "events.jsonl"), "utf8");
    } catch {
      inventoryErrors.push({
        jobId: job.id,
        runId: job.runId ?? null,
        reason: "run_events_missing_or_malformed",
      });
      continue;
    }
    const artifactResult = validateBatteryRunArtifacts({
      job,
      task,
      eventText,
      telemetry: store.readYaml(telemetryPath),
      telemetryPresent: existsSync(telemetryPath),
      runEventSchema: RunEvent,
      harnessEventSchema: HarnessEvent,
      telemetrySchema: RunTelemetry,
    });
    if (!artifactResult.valid) {
      inventoryErrors.push({
        jobId: job.id,
        runId: job.runId ?? null,
        reason: artifactResult.reason,
      });
      continue;
    }
    const runEvents = artifactResult.events;
    const telemetryAttempts = artifactResult.telemetry?.attempts ?? [];
    const attemptKeys = relevantRunAttemptKeys(runEvents, requiredHarnesses);
    for (const attempt of telemetryAttempts) {
      if (
        requiredHarnesses.includes(attempt.harness_id) &&
        !attemptKeys.some(
          (key) => key.harnessId === attempt.harness_id && key.attemptId === attempt.attempt_id,
        )
      ) {
        attemptKeys.push({ harnessId: attempt.harness_id, attemptId: attempt.attempt_id });
      }
    }
    // Expected preflight refusals have neither a started attempt nor telemetry.
    if (attemptKeys.length === 0) continue;
    for (const key of attemptKeys) {
      const base = {
        jobId: job.id,
        runId: job.runId ?? null,
        attemptId: key.attemptId,
        harnessId: key.harnessId,
      };
      if (
        typeof key.attemptId !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(key.attemptId)
      ) {
        observed.push({ ...base, kind: "invalid_attempt_id", authMode: null, authSource: null });
        continue;
      }
      const matchingTelemetry = telemetryAttempts.filter(
        (attempt) => attempt.harness_id === key.harnessId && attempt.attempt_id === key.attemptId,
      );
      if (matchingTelemetry.length !== 1) {
        inventoryErrors.push({
          ...base,
          reason:
            matchingTelemetry.length === 0
              ? "attempt_telemetry_missing"
              : "attempt_telemetry_duplicate",
        });
        continue;
      }
      const attempt = matchingTelemetry[0];
      const sourceAnchor = {
        authMode: attempt.auth_mode ?? null,
        authSource: attempt.auth_source ?? null,
      };
      observed.push({ ...base, kind: "telemetry", ...sourceAnchor });
      const events = runEvents
        .filter(
          (event) =>
            event?.type === "harness.event" &&
            event.payload?.harness_id === key.harnessId &&
            event.payload?.attempt_id === key.attemptId,
        )
        .map((event) => event.payload);
      const durable = durableAttemptRouteEvidence(events, sourceAnchor);
      for (const route of durable.observed) observed.push({ ...base, ...route });
      if (!durable.sawStarted) {
        observed.push({ ...base, kind: "started_route_missing", authMode: null, authSource: null });
      }
    }
  }
  const routeResult = evaluateRequiredNativeRoutes(requiredHarnesses, observed);
  const valid = routeResult.valid && inventoryErrors.length === 0;
  (valid ? pass : fail)("acceptance", "Codex and Claude routes stayed vendor-native", {
    batteryJobs: batteryJobs.length,
    observed,
    inventoryErrors,
    missing: routeResult.missing,
    nonNative: routeResult.nonNative,
  });
  (concurrentJobs.length === 0 ? pass : fail)(
    "acceptance",
    "battery submission window stayed exclusive",
    { concurrentJobs },
  );
}

async function controlRunDetail(runId) {
  try {
    const [{ ensureDaemon }, { controlApiFetch }] = await Promise.all([
      import("../packages/cli/dist/daemon-run.js"),
      import("../packages/cli/dist/live.js"),
    ]);
    const { addr } = await ensureDaemon();
    const response = await controlApiFetch(addr, `/runs/${encodeURIComponent(runId)}`);
    const body = JSON.parse(await response.text());
    if (!response.ok) throw new Error(`GET /runs/${runId} failed (HTTP ${response.status})`);
    return { detail: ControlRunDetail.parse(body), error: null };
  } catch (error) {
    return {
      detail: null,
      error: redactSecrets(error instanceof Error ? error.message : String(error)),
    };
  }
}

function artifactExists(runDir, relPath) {
  return existsSync(join(runDir, relPath));
}

function councilFlags(memberCount) {
  return ["--council", ...(memberCount === undefined ? [] : ["--n", String(memberCount)])];
}

function nonEmpty(path) {
  try {
    return statSync(path).size > 0;
  } catch {
    return false;
  }
}

function cleanName(name) {
  return name
    .replace(/[^a-z0-9_.-]+/gi, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

function initRepo(repo) {
  mkdirSync(repo, { recursive: true });
  runGit(["init", "-b", "main"], repo);
  runGit(
    [
      "-c",
      "user.email=battery@claudexor.dev",
      "-c",
      "user.name=Claudexor Battery",
      "commit",
      "--allow-empty",
      "-m",
      "init",
    ],
    repo,
  );
}

function makeMathRepo(name, opts = {}) {
  const repo = join(reposDir, cleanName(name));
  rmSync(repo, { recursive: true, force: true });
  initRepo(repo);
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, "test"), { recursive: true });
  const addBug = opts.addBug !== false;
  const multiplyBug = opts.multiplyBug === true;
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify(
      {
        name: `claudexor-battery-${cleanName(name)}`,
        version: "0.0.0",
        type: "module",
        scripts: { test: "node --test" },
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(
    join(repo, "src", "math.js"),
    [
      `export function add(a, b) { return a ${addBug ? "-" : "+"} b; }`,
      multiplyBug
        ? `export function multiply(a, b) { throw new Error("TODO multiply"); }`
        : `export function multiply(a, b) { return a * b; }`,
      "",
    ].join("\n"),
  );
  const tests = [
    `import test from "node:test";`,
    `import assert from "node:assert/strict";`,
    `import { add, multiply } from "../src/math.js";`,
    ``,
    `test("add adds", () => { assert.equal(add(2, 3), 5); });`,
  ];
  if (opts.testMultiply)
    tests.push(`test("multiply multiplies", () => { assert.equal(multiply(3, 4), 12); });`);
  writeFileSync(join(repo, "test", "math.test.js"), tests.join("\n") + "\n");
  writeFileSync(
    join(repo, "README.md"),
    `# Battery ${name}\n\nSynthetic dogfood repo for Claudexor.\n`,
  );
  mkdirSync(join(repo, "docs"), { recursive: true });
  writeFileSync(
    join(repo, "docs", "ARCHITECTURE.md"),
    "# Architecture\n\nSmall ESM math module.\n",
  );
  runGit(["add", "-A"], repo);
  runGit(
    [
      "-c",
      "user.email=battery@claudexor.dev",
      "-c",
      "user.name=Claudexor Battery",
      "commit",
      "-m",
      "fixture",
    ],
    repo,
  );
  return repo;
}

function makeEmptyCreateRepo(name) {
  const repo = join(reposDir, cleanName(name));
  rmSync(repo, { recursive: true, force: true });
  initRepo(repo);
  writeFileSync(join(repo, "README.md"), "# Empty create target\n");
  runGit(["add", "-A"], repo);
  runGit(
    [
      "-c",
      "user.email=battery@claudexor.dev",
      "-c",
      "user.name=Claudexor Battery",
      "commit",
      "-m",
      "empty target",
    ],
    repo,
  );
  return repo;
}

function makeProtectedRepo(name) {
  const repo = makeMathRepo(name, { addBug: false });
  mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
  writeFileSync(
    join(repo, ".github", "workflows", "release.yml"),
    "name: noop\non: workflow_dispatch\njobs:\n  noop:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n",
  );
  runGit(["add", "-A"], repo);
  runGit(
    [
      "-c",
      "user.email=battery@claudexor.dev",
      "-c",
      "user.name=Claudexor Battery",
      "commit",
      "-m",
      "protected fixture",
    ],
    repo,
  );
  return repo;
}

function testCmd() {
  return JSON.stringify(["node", "--test"]);
}

function baseRunArgs(prompt, harnesses, extra = []) {
  return [
    "agent",
    prompt,
    "--harness",
    Array.isArray(harnesses) ? harnesses.join(",") : harnesses,
    "--effort",
    "low",
    "--max-usd",
    maxUsd,
    ...extra,
  ];
}

function assertRunStatus(phase, name, out, wanted = ["succeeded"]) {
  if (out.envFailure)
    return envfail(phase, name, {
      reason: "transient network/environment failure after retry",
      exit: out.code,
      log: rel(out.log),
      error: out.json?.error ?? out.json?.summary ?? "",
    });
  if (!out.json)
    return fail(phase, name, { error: "non-json output", exit: out.code, log: rel(out.log) });
  const status = out.json.status;
  if (!wanted.includes(status))
    return fail(phase, name, {
      status,
      exit: out.code,
      error: out.json.error ?? out.json.summary ?? "",
      log: rel(out.log),
      runId: out.json.runId,
    });
  return pass(phase, name, {
    status,
    runId: out.json.runId,
    runDir: out.json.runDir ?? out.json.runDir,
  });
}

function assertPrimaryOutput(phase, name, out, kind) {
  const r = assertRunStatus(phase, name, out, ["succeeded"]);
  if (r.status === "fail" || !out.json?.runId) return out.json;
  const detail = inspectRun(out.json.runId, out.cwd ?? root);
  const primary = detail?.primaryOutput;
  const expectedKind = kind.replace(/\.md$/, "");
  const runDir = detail?.runDir;
  const artifactPath =
    typeof runDir === "string" && typeof primary?.path === "string"
      ? join(runDir, primary.path)
      : null;
  const evidence = {
    runId: out.json.runId,
    lifecycle: detail?.lifecycle ?? null,
    outputReadyState: detail?.outputReadyState ?? null,
    expectedKind,
    actualKind: primary?.kind ?? null,
    path: primary?.path ?? null,
    artifactNonEmpty: artifactPath !== null && nonEmpty(artifactPath),
  };
  const valid =
    evidence.lifecycle === "succeeded" &&
    evidence.outputReadyState === "ready" &&
    evidence.actualKind === expectedKind &&
    evidence.artifactNonEmpty;
  (valid ? pass : fail)(phase, `${name} primary output`, evidence);
  return detail;
}

function assertCouncilArtifacts(phase, name, council, runDir) {
  const members = Array.isArray(council?.members) ? council.members : [];
  const draftedMembers = members.filter(
    (member) => member?.status === "drafted" || member?.status === "merged",
  );
  const draftFiles = draftedMembers.map((member) =>
    runDir ? artifactExists(runDir, `council/draft-${member.harnessId}.md`) : false,
  );
  const evidence = {
    requested: council?.requested,
    drafted: council?.drafted,
    mergedBy: council?.mergedBy,
    members: members.map((member) => ({
      harnessId: member?.harnessId,
      status: member?.status,
      error: member?.error ?? null,
    })),
    membership: Boolean(runDir && artifactExists(runDir, "council/membership.yaml")),
    draftFiles,
  };
  const valid =
    council?.requested === 2 &&
    council?.drafted === 2 &&
    council?.degraded === false &&
    members.length === 2 &&
    new Set(members.map((member) => member?.harnessId)).size === 2 &&
    draftedMembers.length === 2 &&
    typeof council?.mergedBy === "string" &&
    council.mergedBy.length > 0 &&
    members.some(
      (member) => member?.harnessId === council.mergedBy && member?.status === "merged",
    ) &&
    evidence.membership &&
    draftFiles.every(Boolean);
  return valid ? pass(phase, name, evidence) : fail(phase, name, evidence);
}

function recordRunEvidence(phase, name, out, cwd) {
  if (out.envFailure) {
    envfail(phase, name, {
      reason: "transient network/environment failure after retry",
      exit: out.code,
      log: rel(out.log),
      error: out.json?.error ?? out.json?.summary ?? "",
    });
    return null;
  }
  if (!out.json?.runId) return null;
  const detail = inspectRun(out.json.runId, cwd);
  const wp = detail?.work_product ?? detail?.workProduct ?? null;
  const decision = detail?.decision ?? null;
  const telemetry = detail?.telemetry ?? null;
  const patchPath = detail?.runDir ? join(detail.runDir, "final", "patch.diff") : "";
  return {
    detail,
    wp,
    decision,
    telemetry,
    patchPath,
    patchNonEmpty: patchPath ? nonEmpty(patchPath) : false,
  };
}

function gatePassed(detail) {
  return detail?.runFacts?.gates?.state === "passed";
}

function runApplyable(ev) {
  return (
    ev?.detail?.runFacts?.apply?.eligibility?.eligible === true &&
    ev?.decision?.apply_recommendation === "apply"
  );
}

function runAdoptedAndVerified(ev) {
  const outcome = ev?.detail?.runFacts?.outcome;
  return (
    outcome?.lifecycle === "succeeded" &&
    outcome?.checks === "passed" &&
    outcome?.review === "approved" &&
    ev?.wp?.meta?.adopted === true &&
    ev?.wp?.meta?.apply_state === "applied"
  );
}

function runNeedsDecision(ev) {
  const outcome = ev?.detail?.runFacts?.outcome;
  return (
    outcome?.lifecycle === "succeeded" &&
    (outcome.review === "blocked" || outcome.checks === "failed")
  );
}

function patchLooksReal(ev) {
  const diffstat = ev?.wp?.meta?.diffstat;
  return ev?.patchNonEmpty && (diffstat?.files ?? 0) > 0;
}

// Tiny PNG encoder with a 5x7 bitmap font for the marker image.
function crc32(buf) {
  const table = (crc32.table ??= Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  }));
  let c = 0xffffffff;
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const FONT = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  X: ["10001", "01010", "00100", "00100", "00100", "01010", "10001"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  1: ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  2: ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  5: ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  7: ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
};

function writeMarkerPng(path, text) {
  const scale = 8;
  const marginX = 28;
  const marginY = 58;
  const width = Math.max(520, marginX * 2 + text.length * 6 * scale);
  const height = Math.max(180, marginY * 2 + 7 * scale);
  const rgba = Buffer.alloc(width * height * 4, 255);
  const set = (x, y, r, g, b) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 4;
    rgba[i] = r;
    rgba[i + 1] = g;
    rgba[i + 2] = b;
    rgba[i + 3] = 255;
  };
  for (let x = 0; x < width; x++) {
    set(x, 0, 220, 0, 0);
    set(x, height - 1, 220, 0, 0);
  }
  for (let y = 0; y < height; y++) {
    set(0, y, 220, 0, 0);
    set(width - 1, y, 220, 0, 0);
  }
  let ox = marginX;
  const oy = marginY;
  for (const ch of text) {
    const glyph = FONT[ch] ?? FONT["-"];
    for (let gy = 0; gy < glyph.length; gy++) {
      for (let gx = 0; gx < glyph[gy].length; gx++) {
        if (glyph[gy][gx] !== "1") continue;
        for (let sy = 0; sy < scale; sy++)
          for (let sx = 0; sx < scale; sx++)
            set(ox + gx * scale + sx, oy + gy * scale + sy, 0, 0, 0);
      }
    }
    ox += 6 * scale;
  }
  if (ox + marginX > width) throw new Error(`marker PNG too narrow for ${text}`);
  const rawRows = [];
  for (let y = 0; y < height; y++) {
    rawRows.push(Buffer.from([0]));
    rawRows.push(rgba.subarray(y * width * 4, (y + 1) * width * 4));
  }
  const chunk = (type, data) => {
    const t = Buffer.from(type);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  writeFileSync(
    path,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", zlib.deflateSync(Buffer.concat(rawRows))),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

function harnessOk(h) {
  return evidence.okHarnesses.includes(h);
}

function harnessIntent(h, intent) {
  const report = evidence.harnessReports[h] ?? {};
  return (report.enabledIntents ?? report.enabled_intents ?? []).includes(intent);
}

function available(list) {
  return list.filter(harnessOk);
}

function needHarness(phase, h, label = h) {
  if (!harnessOk(h)) {
    skip(phase, label, { reason: "doctor not ok / not available" });
    return false;
  }
  return true;
}

async function runReadonlyPhase() {
  const phase = "phase1";
  for (const retired of ["audit", "explore"]) {
    const out = runCliJson([retired, "retired verb probe"], {
      cwd: repos.readonly,
      name: `${phase}-${retired}-retired`,
      envRetry: false,
    });
    if (out.code === 2 && /retired|deep-scan/i.test(out.stdout + out.stderr)) {
      pass(phase, `${retired} retired verb fails loud`, { exit: out.code });
    } else {
      fail(phase, `${retired} retired verb fails loud`, {
        exit: out.code,
        stdout: out.stdout.slice(0, 200),
        stderr: out.stderr.slice(0, 200),
      });
    }
  }
  for (const h of requestedHarnesses) {
    if (!needHarness(phase, h, `${h} read-only`)) continue;
    assertPrimaryOutput(
      phase,
      `${h} ask 2+2`,
      runCliJson(
        ["ask", "Answer exactly: 4", "--harness", h, "--effort", "low", "--max-usd", maxUsd],
        { cwd: repos.readonly, name: `${phase}-${h}-ask` },
      ),
      "answer.md",
    );
    assertPrimaryOutput(
      phase,
      `${h} repository deep scan`,
      runCliJson(
        [
          "ask",
          "Briefly map this repository: files, tests, and the math bug. Do not edit files.",
          "--deep-scan",
          "--harness",
          h,
          "--effort",
          "low",
          "--max-usd",
          maxUsd,
        ],
        { cwd: repos.readonly, name: `${phase}-${h}-deep-scan-map` },
      ),
      "report.md",
    );
    assertPrimaryOutput(
      phase,
      `${h} plan`,
      runCliJson(
        [
          "plan",
          "Plan adding a multiply feature to this tiny repo. Keep it concise.",
          "--harness",
          h,
          "--effort",
          "low",
          "--max-usd",
          maxUsd,
        ],
        { cwd: repos.readonly, name: `${phase}-${h}-plan` },
      ),
      "plan.md",
    );
    assertPrimaryOutput(
      phase,
      `${h} focused deep scan`,
      runCliJson(
        [
          "ask",
          "Find where add is implemented and tested. Keep it concise.",
          "--deep-scan",
          "--harness",
          h,
          "--n",
          "1",
          "--effort",
          "low",
          "--max-usd",
          maxUsd,
        ],
        { cwd: repos.readonly, name: `${phase}-${h}-deep-scan-focused` },
      ),
      "report.md",
    );
  }
  const multi = available(requestedHarnesses);
  if (multi.length >= 2) {
    const plan = runCliJson(
      [
        "plan",
        "Plan adding multiply; reconcile disagreements between planners.",
        "--harness",
        multi.join(","),
        ...councilFlags(2),
        "--effort",
        "low",
        "--max-usd",
        maxUsd,
      ],
      { cwd: repos.readonly, name: `${phase}-multi-plan` },
    );
    const detail = assertPrimaryOutput(phase, "multi plan", plan, "plan.md");
    if (detail?.runDir && plan.json?.runId) {
      const projected = await controlRunDetail(plan.json.runId);
      if (projected.detail)
        assertCouncilArtifacts(
          phase,
          "multi plan council artifacts",
          projected.detail.council,
          detail.runDir,
        );
      else
        fail(phase, "multi plan council artifacts", {
          runId: plan.json.runId,
          projectionError: projected.error,
        });
    }
    const exp = runCliJson(
      [
        "ask",
        "Find where add is implemented and tested; each explorer should take a distinct slice.",
        "--deep-scan",
        "--harness",
        multi.join(","),
        "--n",
        String(Math.min(3, multi.length)),
        "--effort",
        "low",
        "--max-usd",
        maxUsd,
      ],
      { cwd: repos.readonly, name: `${phase}-multi-deep-scan` },
    );
    const ed = assertPrimaryOutput(phase, "multi deep scan", exp, "report.md");
    if (ed?.runDir) {
      pass(phase, "multi deep scan artifacts", {
        findings: existsSync(join(ed.runDir, "findings")),
        exploreFindings: artifactExists(ed.runDir, "final/explore-findings.yaml"),
        omissions: artifactExists(ed.runDir, "final/omissions.md"),
      });
    }
  } else skip(phase, "multi read-only", { reason: "need >=2 doctor-ok harnesses" });
}

function runWritePhase() {
  const phase = "phase2";
  for (const h of requestedHarnesses) {
    if (!needHarness(phase, h, `${h} run`)) continue;
    const repo = makeMathRepo(`${phase}-${h}`, { addBug: true });
    const out = runCliJson(
      baseRunArgs("Fix src/math.js add(a,b) so node --test passes. Do not change tests.", h, [
        "--test",
        testCmd(),
      ]),
      { cwd: repo, name: `${phase}-${h}-run` },
    );
    const ev = recordRunEvidence(phase, `${h} run evidence`, out, repo);
    if (!ev) continue;
    const succeededWithChecks =
      out.json?.status === "succeeded" &&
      ev.decision?.facts?.lifecycle === "succeeded" &&
      ev.decision?.facts?.checks === "passed";
    if (patchLooksReal(ev) && gatePassed(ev.detail) && succeededWithChecks)
      pass(phase, `${h} run patch+gate`, {
        runId: out.json.runId,
        status: out.json.status,
        review: ev.decision?.facts?.review ?? "unknown",
        basis: ev.decision?.verification_basis ?? "none",
      });
    else
      fail(phase, `${h} run patch+gate`, {
        runId: out.json?.runId,
        status: out.json?.status,
        patch: ev.patchNonEmpty,
        gatePassed: gatePassed(ev.detail),
        decision: ev.decision,
      });
    state.verifiedRuns.push({ harness: h, repo, out, ev });
  }
}

function runMultiWritePhase() {
  const phase = "phase3";
  const multi = available(requestedHarnesses);
  if (multi.length < 2) {
    skip(phase, "multi write features", { reason: "need >=2 doctor-ok harnesses" });
    return;
  }
  {
    const repo = makeMathRepo(`${phase}-race`, { addBug: true });
    const out = runCliJson(
      [
        "best-of",
        "Fix add(a,b) in src/math.js so tests pass. Do not change tests.",
        "--harness",
        multi.join(","),
        "--n",
        String(Math.min(3, multi.length)),
        "--test",
        testCmd(),
        "--effort",
        "low",
        "--max-usd",
        maxUsd,
      ],
      { cwd: repo, name: `${phase}-race` },
    );
    const ev = recordRunEvidence(phase, "multi race evidence", out, repo);
    if (out.envFailure) return;
    if (
      runApplyable(ev) &&
      ev.decision.verification_basis === "both" &&
      patchLooksReal(ev) &&
      gatePassed(ev.detail)
    )
      pass(phase, "multi race decision", {
        runId: out.json.runId,
        status: out.json.status,
        winner: ev.decision.winner,
        basis: ev.decision.verification_basis,
        facts: ev.decision.facts,
      });
    else
      fail(phase, "multi race decision", {
        status: out.json?.status,
        error: out.json?.error,
        log: rel(out.log),
      });
    state.multiRace = { repo, out, ev };
  }
  {
    const repo = makeMathRepo(`${phase}-synthesis`, { addBug: true });
    const out = runCliJson(
      [
        "best-of",
        "Fix add(a,b) in src/math.js so tests pass. Do not change tests.",
        "--harness",
        multi.join(","),
        "--n",
        "3",
        "--synthesis",
        "always",
        "--test",
        testCmd(),
        "--effort",
        "low",
        "--max-usd",
        maxUsd,
      ],
      { cwd: repo, name: `${phase}-synthesis` },
    );
    const ev = recordRunEvidence(phase, "synthesis evidence", out, repo);
    if (out.envFailure) return;
    const synth = ev?.detail?.runDir
      ? artifactExists(ev.detail.runDir, "arbitration/synthesis.yaml")
      : false;
    if (
      synth &&
      runApplyable(ev) &&
      ev.decision.verification_basis === "both" &&
      patchLooksReal(ev) &&
      gatePassed(ev.detail)
    )
      pass(phase, "synthesis artifact", {
        runId: out.json?.runId,
        status: out.json?.status,
        basis: ev.decision.verification_basis,
      });
    else
      fail(phase, "synthesis artifact", {
        runId: out.json?.runId,
        status: out.json?.status,
        decision: ev?.decision,
        error: out.json?.error,
        log: rel(out.log),
      });
  }
  {
    const repo = makeMathRepo(`${phase}-convergence`, { addBug: true });
    const out = runCliJson(
      [
        "agent",
        "Fix add(a,b) in src/math.js so tests pass. Do not change tests.",
        "--harness",
        multi.join(","),
        "--until-clean",
        "--test",
        testCmd(),
        "--effort",
        "low",
        "--max-usd",
        maxUsd,
      ],
      { cwd: repo, name: `${phase}-convergence`, timeoutMs: 30 * 60_000 },
    );
    const ev = recordRunEvidence(phase, "convergence evidence", out, repo);
    if (out.envFailure) return;
    if (
      ev?.wp?.meta?.lifecycle === "succeeded" &&
      ev.wp.meta.outcome_facts?.checks === "passed" &&
      ev.wp.meta.review_verified === true &&
      out.json?.status === "succeeded" &&
      runApplyable(ev) &&
      ev.decision?.verification_basis === "both" &&
      gatePassed(ev.detail)
    )
      pass(phase, "convergence work_product", {
        runId: out.json?.runId,
        status: ev.wp.meta.lifecycle,
        attempts: ev.detail?.telemetry?.attempts?.length ?? 0,
        reviewVerified: ev.wp.meta.review_verified,
      });
    else
      fail(phase, "convergence work_product", {
        status: out.json?.status,
        error: out.json?.error,
        log: rel(out.log),
      });
  }
  const singleFamilyReviewer = multi.find((h) => harnessIntent(h, "review"));
  if (singleFamilyReviewer) runDegradationControl(phase, singleFamilyReviewer);
  else fail(phase, "single-family degradation control", { reason: "no doctor-ok reviewer" });
}

function runDegradationControl(phase, onlyHarness) {
  // An explicit same-family panel proves the degradation contract without
  // rewriting user-global harness settings. This keeps the existing-session
  // VM lane read-only with respect to config.yaml.
  const reviewerPanel = ["--reviewer-panel", onlyHarness];
  const repo = makeMathRepo(`${phase}-single-family-control`, { addBug: true });
  const out = runCliJson(
    [
      "best-of",
      "Fix add(a,b) in src/math.js so tests pass. Do not change tests.",
      "--harness",
      onlyHarness,
      "--n",
      "1",
      ...reviewerPanel,
      "--test",
      testCmd(),
      "--effort",
      "low",
      "--max-usd",
      maxUsd,
    ],
    { cwd: repo, name: `${phase}-single-family-control` },
  );
  const ev = recordRunEvidence(phase, "single-family control", out, repo);
  if (ev?.decision) {
    const basis = ev.decision.verification_basis ?? "unknown";
    const rec = basis === "none" ? pass : fail;
    rec(phase, "single-family verification_basis=none", {
      runId: out.json?.runId,
      status: out.json?.status,
      facts: ev.decision.facts,
      basis,
    });
    const apply = runCliJson(["apply", out.json.runId, "--dry-run"], {
      cwd: repo,
      name: `${phase}-single-family-apply-refusal`,
    });
    if (
      ev.detail?.runFacts?.apply?.eligibility?.eligible === false &&
      ev.detail?.runFacts?.apply?.eligibility?.state === "not_verified" &&
      apply.code !== 0 &&
      apply.json?.runId === out.json.runId &&
      apply.json?.dryRun === true &&
      apply.json?.code === "invalid_request"
    )
      pass(phase, "single-family apply refused", { runId: out.json.runId });
    else
      fail(phase, "single-family apply refused", {
        exit: apply.code,
        stdout: apply.stdout,
        stderr: apply.stderr,
        log: rel(apply.log),
      });
  } else {
    fail(phase, "single-family control decision", {
      status: out.json?.status,
      error: out.json?.error,
      log: rel(out.log),
    });
  }
  const convRepo = makeMathRepo(`${phase}-single-family-convergence`, { addBug: true });
  const conv = runCliJson(
    [
      "agent",
      "Fix add(a,b) in src/math.js so tests pass. Do not change tests.",
      "--harness",
      onlyHarness,
      "--until-clean",
      ...reviewerPanel,
      "--test",
      testCmd(),
      "--effort",
      "low",
      "--max-usd",
      maxUsd,
    ],
    { cwd: convRepo, name: `${phase}-single-family-convergence` },
  );
  if (isCrossFamilyConvergenceRefusal(conv))
    pass(phase, "single-family convergence refused", {
      status: conv.json?.status,
      error: conv.json?.error ?? conv.json?.summary,
    });
  else
    fail(phase, "single-family convergence refused", {
      exit: conv.code,
      json: conv.json,
      log: rel(conv.log),
    });
}

function chooseVerifiedRun() {
  return (
    state.verifiedRuns.find((r) => r.out.json?.status === "succeeded" && runApplyable(r.ev)) ??
    (state.multiRace?.out?.json?.status === "succeeded" && runApplyable(state.multiRace?.ev)
      ? state.multiRace
      : null)
  );
}

function runLifecyclePhase() {
  const phase = "phase4";
  const multi = available(requestedHarnesses);
  if (multi.length < 2) {
    skip(phase, "apply/decision lifecycle", { reason: "need >=2 doctor-ok harnesses" });
    return;
  }
  const verified = chooseVerifiedRun();
  if (verified?.out?.json?.runId) {
    const dry = runCliJson(["apply", verified.out.json.runId, "--dry-run"], {
      cwd: verified.repo,
      name: `${phase}-apply-dry-run`,
    });
    if (dry.code === 0) pass(phase, "apply --dry-run", { runId: verified.out.json.runId });
    else fail(phase, "apply --dry-run", { exit: dry.code, json: dry.json, log: rel(dry.log) });
  } else
    skip(phase, "apply --dry-run", { reason: "no verified applyable run from earlier phases" });

  for (const mode of ["branch", "commit"]) {
    const repo = makeMathRepo(`${phase}-apply-${mode}`, { addBug: true });
    const out = runCliJson(
      [
        "best-of",
        "Fix add(a,b) in src/math.js so tests pass. Do not change tests.",
        "--harness",
        multi.join(","),
        "--n",
        String(Math.min(3, multi.length)),
        "--test",
        testCmd(),
        "--effort",
        "low",
        "--max-usd",
        maxUsd,
      ],
      { cwd: repo, name: `${phase}-${mode}-source` },
    );
    const ev = recordRunEvidence(phase, `apply ${mode} source`, out, repo);
    if (out.json?.status === "succeeded" && runApplyable(ev)) {
      const applied = runCliJson(["apply", out.json.runId, "--mode", mode], {
        cwd: repo,
        name: `${phase}-apply-${mode}`,
      });
      if (applied.code === 0 && applied.json?.applied)
        pass(phase, `apply --mode ${mode}`, applied.json);
      else
        fail(phase, `apply --mode ${mode}`, {
          exit: applied.code,
          json: applied.json,
          log: rel(applied.log),
        });
    } else
      skip(phase, `apply --mode ${mode}`, {
        reason: "source run not applyable",
        status: out.json?.status,
        decision: ev?.decision,
      });
  }

  runBlockedDecisionScenario(phase, multi);
  runRevertScenario(phase, multi);
}

function runBlockedDecisionScenario(phase, multi) {
  const repo = makeProtectedRepo(`${phase}-blocked-risk`);
  const prompt =
    "Make a harmless wording-only change to .github/workflows/release.yml by changing the echo text to 'battery ok'. Do not touch other files.";
  const out = runCliJson(
    [
      "agent",
      prompt,
      "--harness",
      multi.join(","),
      "--test",
      "true",
      "--effort",
      "low",
      "--max-usd",
      maxUsd,
    ],
    { cwd: repo, name: `${phase}-blocked-risk` },
  );
  const ev = recordRunEvidence(phase, "blocked risk evidence", out, repo);
  if (runNeedsDecision(ev) && ev?.patchNonEmpty) {
    pass(phase, "blocked high-risk run", {
      runId: out.json.runId,
      facts: ev.decision?.facts,
    });
    const dec = runCliJson(["decision", out.json.runId, "--accept-risk"], {
      cwd: repo,
      name: `${phase}-accept-risk`,
    });
    if (dec.code === 0 && dec.json?.accepted) pass(phase, "decision --accept-risk", dec.json);
    else
      fail(phase, "decision --accept-risk", { exit: dec.code, json: dec.json, log: rel(dec.log) });
    const op = ev.detail?.runDir
      ? existsSync(join(ev.detail.runDir, "arbitration", "operator_decision.yaml"))
      : false;
    if (op) pass(phase, "operator_decision.yaml", { runId: out.json.runId });
    else fail(phase, "operator_decision.yaml", { runId: out.json.runId });
  } else {
    skip(phase, "blocked high-risk decision", {
      reason: "scenario did not produce blocked patch",
      status: out.json?.status,
      decision: ev?.decision,
      log: rel(out.log),
    });
  }

  const rerunRepo = makeProtectedRepo(`${phase}-blocked-rerun`);
  const rerunSrc = runCliJson(
    [
      "agent",
      prompt,
      "--harness",
      multi.join(","),
      "--test",
      "true",
      "--effort",
      "low",
      "--max-usd",
      maxUsd,
    ],
    { cwd: rerunRepo, name: `${phase}-blocked-rerun-source` },
  );
  const rerunEv = recordRunEvidence(phase, "blocked rerun evidence", rerunSrc, rerunRepo);
  if (runNeedsDecision(rerunEv)) {
    const rerun = runCliJson(
      [
        "decision",
        rerunSrc.json.runId,
        "--rerun",
        "--feedback",
        "Use a smaller harmless wording change only.",
      ],
      { cwd: rerunRepo, name: `${phase}-rerun-feedback` },
    );
    if (rerun.code === 0 && rerun.json?.newRunId)
      pass(phase, "decision --rerun", { newRunId: rerun.json.newRunId });
    else
      fail(phase, "decision --rerun", { exit: rerun.code, json: rerun.json, log: rel(rerun.log) });
  } else
    skip(phase, "decision --rerun", {
      reason: "source did not block",
      status: rerunSrc.json?.status,
    });
}

function runRevertScenario(phase, multi) {
  const repo = makeMathRepo(`${phase}-revert`, { addBug: true });
  const mathPath = join(repo, "src", "math.js");
  const preTurnMath = readFileSync(mathPath, "utf8");
  const out = runCliJson(
    [
      "agent",
      "Fix add(a,b) in src/math.js so tests pass. Do not change tests.",
      "--harness",
      multi.join(","),
      "--in-place",
      "--test",
      testCmd(),
      "--effort",
      "low",
      "--max-usd",
      maxUsd,
    ],
    { cwd: repo, name: `${phase}-in-place-revert` },
  );
  if (out.json?.runId && out.json.status === "succeeded") {
    const rev = runCliJson(["decision", out.json.runId, "--revert"], {
      cwd: repo,
      name: `${phase}-revert`,
    });
    const deliveryState = RunDeliveryState.safeParse(
      new ArtifactStore(repo).readYaml(join(out.json.runDir, "final", "delivery_state.yaml")),
    );
    if (
      rev.code === 0 &&
      rev.json?.accepted === true &&
      readFileSync(mathPath, "utf8") === preTurnMath &&
      deliveryState.success &&
      deliveryState.data.applyState === "reverted"
    )
      pass(phase, "decision --revert", {
        runId: out.json.runId,
        applyState: deliveryState.data.applyState,
      });
    else
      fail(phase, "decision --revert", {
        exit: rev.code,
        json: rev.json,
        bytesRestored: readFileSync(mathPath, "utf8") === preTurnMath,
        deliveryState: deliveryState.success ? deliveryState.data : null,
        log: rel(rev.log),
      });
  } else
    skip(phase, "decision --revert", {
      reason: "in-place source not succeeded",
      status: out.json?.status,
      error: out.json?.error,
      log: rel(out.log),
    });

  const repo2 = makeMathRepo(`${phase}-revert-diverged`, { addBug: true });
  const out2 = runCliJson(
    [
      "agent",
      "Fix add(a,b) in src/math.js so tests pass. Do not change tests.",
      "--harness",
      multi.join(","),
      "--in-place",
      "--test",
      testCmd(),
      "--effort",
      "low",
      "--max-usd",
      maxUsd,
    ],
    { cwd: repo2, name: `${phase}-in-place-diverge-source` },
  );
  if (out2.json?.runId && out2.json.status === "succeeded") {
    const touchedPath = join(repo2, "src", "math.js");
    const postimage = readFileSync(touchedPath, "utf8");
    const userEdit = postimage.replace(
      "return a + b;",
      "return Number(a) + Number(b); // user edit after the run",
    );
    if (userEdit === postimage) {
      fail(phase, "revert divergence fixture", { reason: "run-owned postimage was absent" });
      return;
    }
    writeFileSync(touchedPath, userEdit);
    const rev = runCliJson(["decision", out2.json.runId, "--revert"], {
      cwd: repo2,
      name: `${phase}-revert-diverged`,
    });
    if (
      rev.code !== 0 &&
      rev.json?.code === "revert_refused" &&
      rev.json?.context?.reason === "postimage_diverged" &&
      readFileSync(touchedPath, "utf8") === userEdit
    )
      pass(phase, "revert divergence fence", { runId: out2.json.runId });
    else
      fail(phase, "revert divergence fence", { exit: rev.code, json: rev.json, log: rel(rev.log) });
  } else
    skip(phase, "revert divergence fence", {
      reason: "in-place source not succeeded",
      status: out2.json?.status,
    });
}

function runCreatePhase() {
  const phase = "phase5";
  const multi = available(requestedHarnesses);
  for (const h of requestedHarnesses) {
    if (!needHarness(phase, h, `${h} create`)) continue;
    const repo = makeEmptyCreateRepo(`${phase}-${h}`);
    const out = runCliJson(
      [
        "create",
        "Create a tiny ESM Node project with src/hello.js exporting hello(name) and a node:test test in test/hello.test.js. Keep it minimal.",
        "--harness",
        h,
        "--test",
        testCmd(),
        "--effort",
        "low",
        "--max-usd",
        maxUsd,
      ],
      { cwd: repo, name: `${phase}-${h}-create` },
    );
    const ev = recordRunEvidence(phase, `${h} create evidence`, out, repo);
    if (out.envFailure) continue;
    if (ev?.patchNonEmpty && ev?.wp?.kind === "new_repo")
      pass(phase, `${h} create patch`, {
        runId: out.json?.runId,
        status: out.json?.status,
        kind: ev.wp.kind,
      });
    else
      fail(phase, `${h} create patch`, {
        runId: out.json?.runId,
        status: out.json?.status,
        kind: ev?.wp?.kind,
        patch: ev?.patchNonEmpty,
        error: out.json?.error,
      });
  }
  if (multi.length >= 2) {
    const repo = makeEmptyCreateRepo(`${phase}-multi`);
    const out = runCliJson(
      [
        "create",
        "Create a tiny ESM Node project with src/hello.js exporting hello(name) and a node:test test in test/hello.test.js. Keep it minimal.",
        "--harness",
        multi.join(","),
        "--n",
        String(Math.min(3, multi.length)),
        "--test",
        testCmd(),
        "--effort",
        "low",
        "--max-usd",
        maxUsd,
      ],
      { cwd: repo, name: `${phase}-multi-create` },
    );
    const ev = recordRunEvidence(phase, "multi create evidence", out, repo);
    if (out.envFailure) return;
    if (ev?.patchNonEmpty && ev?.wp?.kind === "new_repo")
      pass(phase, "multi create patch", {
        runId: out.json?.runId,
        status: out.json?.status,
        kind: ev.wp.kind,
        basis: ev.decision?.verification_basis,
      });
    else
      fail(phase, "multi create patch", {
        runId: out.json?.runId,
        status: out.json?.status,
        kind: ev?.wp?.kind,
        patch: ev?.patchNonEmpty,
        error: out.json?.error,
      });
  } else skip(phase, "multi create", { reason: "need >=2 doctor-ok harnesses" });
}

function runVisionPhase() {
  const phase = "phase6";
  const png = join(batteryRoot, "marker.png");
  writeMarkerPng(png, marker);
  const visionHarnesses = available(["codex", "claude"]);
  for (const h of visionHarnesses) {
    const out = runCliJson(
      [
        "ask",
        `Read the image. What exact marker text is shown? Answer only the marker text.`,
        "--harness",
        h,
        "--image",
        png,
        "--effort",
        "low",
        "--max-usd",
        maxUsd,
      ],
      { cwd: repos.readonly, name: `${phase}-${h}-image` },
    );
    const detail = assertPrimaryOutput(phase, `${h} image`, out, "answer.md");
    const answer = detail?.primaryOutput?.text ?? "";
    if (answer.includes(marker))
      pass(phase, `${h} image marker`, { marker, runId: out.json?.runId });
    else
      fail(phase, `${h} image marker`, {
        marker,
        answer: answer.slice(0, 200),
        runId: out.json?.runId,
      });
  }
  if (visionHarnesses.length >= 2) {
    const out = runCliJson(
      [
        "ask",
        `Read the image. What exact marker text is shown? Answer only the marker text.`,
        "--harness",
        visionHarnesses.join(","),
        "--image",
        png,
        "--effort",
        "low",
        "--max-usd",
        maxUsd,
      ],
      { cwd: repos.readonly, name: `${phase}-multi-image` },
    );
    const detail = assertPrimaryOutput(phase, "multi image", out, "answer.md");
    const answer = detail?.primaryOutput?.text ?? "";
    if (answer.includes(marker))
      pass(phase, "multi image marker", { marker, runId: out.json?.runId });
    else
      fail(phase, "multi image marker", {
        marker,
        answer: answer.slice(0, 200),
        runId: out.json?.runId,
      });
  } else skip(phase, "multi image", { reason: "need codex+claude ok" });
  if (harnessOk("cursor")) {
    const out = runCliJson(
      [
        "ask",
        "Read the image.",
        "--harness",
        "cursor",
        "--image",
        png,
        "--effort",
        "low",
        "--max-usd",
        maxUsd,
      ],
      { cwd: repos.readonly, name: `${phase}-cursor-image-negative` },
    );
    if (out.code !== 0 && out.json?.code === "attachment_pool_unsupported")
      pass(phase, "cursor image typed refusal", {
        status: out.json?.status,
        code: out.json.code,
      });
    else
      fail(phase, "cursor image typed refusal", {
        exit: out.code,
        json: out.json,
        log: rel(out.log),
      });
  } else skip(phase, "cursor image negative", { reason: "cursor not ok" });
}

function runWebPhase() {
  const phase = "phase7";
  const prompt =
    "Use live web/search evidence to fetch https://example.com and answer with the page heading/domain in one sentence.";
  const journalEvents = (runDir) => {
    if (typeof runDir !== "string") return [];
    try {
      return readFileSync(join(runDir, "events.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };
  const assertOptionalWebOutput = (name, out) => {
    const detail = assertPrimaryOutput(phase, name, out, "answer.md");
    const events = journalEvents(detail?.runDir ?? out.json?.runDir);
    const started = events.some((event) => event?.type === "harness.started");
    const observation = {
      runId: out.json?.runId ?? null,
      started,
      webStatus: detail?.telemetry?.web?.status ?? null,
      webAttempted: detail?.telemetry?.web?.attempted ?? null,
      webSatisfied: detail?.telemetry?.web?.satisfied ?? null,
    };
    (started ? pass : fail)(phase, `${name} harness started`, observation);
    pass(phase, `${name} web observation`, observation);
    return detail;
  };
  const webHarnesses = available(["codex", "claude"]);
  for (const h of webHarnesses) {
    const out = runCliJson(
      ["ask", prompt, "--harness", h, "--web", "live", "--effort", "low", "--max-usd", maxUsd],
      { cwd: repos.readonly, name: `${phase}-${h}-web` },
    );
    assertOptionalWebOutput(`${h} live-policy answer`, out);
  }
  if (webHarnesses.length >= 2) {
    const out = runCliJson(
      [
        "ask",
        prompt,
        "--harness",
        webHarnesses.join(","),
        "--web",
        "live",
        "--effort",
        "low",
        "--max-usd",
        maxUsd,
      ],
      { cwd: repos.readonly, name: `${phase}-multi-web` },
    );
    assertOptionalWebOutput("multi live-policy answer", out);
  } else skip(phase, "multi web", { reason: "need codex+claude ok" });
  if (harnessOk("cursor")) {
    const live = runCliJson(
      [
        "ask",
        prompt,
        "--harness",
        "cursor",
        "--web",
        "live",
        "--effort",
        "low",
        "--max-usd",
        maxUsd,
      ],
      { cwd: repos.readonly, name: `${phase}-cursor-web` },
    );
    assertOptionalWebOutput("cursor live-policy answer", live);

    const off = runCliJson(
      [
        "ask",
        "Answer exactly: 4",
        "--harness",
        "cursor",
        "--web",
        "off",
        "--effort",
        "low",
        "--max-usd",
        maxUsd,
      ],
      { cwd: repos.readonly, name: `${phase}-cursor-web-off` },
    );
    const offRunDir = off.json?.runDir;
    const failure =
      typeof offRunDir === "string"
        ? new ArtifactStore(root).readYaml(join(offRunDir, "final", "failure.yaml"))
        : null;
    const expectedMessage =
      "cursor cannot guarantee web is disabled (manifest web_policy=uncontrolled); rerun with --web auto, --web cached, or --web live, or select a harness that can enforce --web off";
    const offEvidence = {
      runId: off.json?.runId ?? null,
      exit: off.code,
      category: failure?.category ?? null,
      safeMessage: failure?.safeMessage ?? null,
      harnessStarted: journalEvents(offRunDir).some((event) => event?.type === "harness.started"),
    };
    if (
      off.code !== 0 &&
      offEvidence.category === "harness_unavailable" &&
      offEvidence.safeMessage === expectedMessage &&
      offEvidence.harnessStarted === false
    ) {
      pass(phase, "cursor off typed refusal", offEvidence);
    } else {
      fail(phase, "cursor off typed refusal", { ...offEvidence, log: rel(off.log) });
    }
  } else skip(phase, "cursor web", { reason: "cursor not ok" });
}

async function runPlanPhase() {
  const phase = "phase8";
  const multi = available(requestedHarnesses);
  if (multi.length < 2) {
    skip(phase, "plan lifecycle", { reason: "need >=2 doctor-ok harnesses" });
    return;
  }
  const repo = makeMathRepo(`${phase}-plan`, {
    addBug: true,
    multiplyBug: true,
    testMultiply: true,
  });
  const prompt =
    "Add a multiply feature and fix math so all node:test tests pass. Use the existing tiny public API. There are no product choices to ask the owner; record an empty Open Questions set.";
  try {
    const [{ ensureDaemon, enqueueAndAwait }, { controlApiFetch }] = await Promise.all([
      import("../packages/cli/dist/daemon-run.js"),
      import("../packages/cli/dist/live.js"),
    ]);
    const { client, addr } = await ensureDaemon();
    const requestJson = async (path, init = {}) => {
      const response = await controlApiFetch(addr, path, init);
      const text = await response.text();
      const body = text ? JSON.parse(text) : {};
      if (!response.ok) {
        throw new Error(
          `${init.method ?? "GET"} ${path} failed (HTTP ${response.status}): ${JSON.stringify(body)}`,
        );
      }
      return body;
    };
    const thread = await requestJson("/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Real-harness Plan to Implement proof",
        scope: { kind: "project", root: repo },
        mode: "plan",
        workspace: "in_place",
        authPreference: "auto",
        primaryHarness: multi[0],
        eligibleHarnesses: multi,
        access: "workspace_write",
      }),
    });
    const shared = {
      threadId: thread.id,
      scope: { kind: "project", root: repo },
      execution: { isolation: "live" },
      harnesses: multi,
      primaryHarness: multi[0],
      effort: "low",
      paidBudget: { kind: "finite", maxUsd: Number(maxUsd) },
      maxSeconds: 30 * 60,
    };
    const planOutcome = await enqueueAndAwait(
      client,
      addr,
      {
        ...shared,
        prompt,
        mode: "plan",
        council: true,
        n: 2,
      },
      { waitForTerminal: true },
    );
    const planMd = join(planOutcome.runDir, "final", "plan.md");
    if (planOutcome.status !== "succeeded" || !nonEmpty(planMd)) {
      fail(phase, "plan produced", {
        threadId: thread.id,
        runId: planOutcome.runId,
        status: planOutcome.status,
        error: planOutcome.error,
        plan: nonEmpty(planMd),
      });
      return;
    }
    const frozenPlan = readFileSync(planMd);
    const planHash = createHash("sha256").update(frozenPlan).digest("hex");
    pass(phase, "plan produced", {
      threadId: thread.id,
      runId: planOutcome.runId,
      sha256: planHash,
    });
    const planDetail = ControlRunDetail.parse(
      await requestJson(`/runs/${encodeURIComponent(planOutcome.runId)}`),
    );
    assertCouncilArtifacts(phase, "plan council artifacts", planDetail.council, planOutcome.runDir);

    // This is the product's actual Implement action: a second turn in the SAME
    // thread names the exact plan run. The server freezes plan.md, mints
    // planRef, forces agent mode, and materializes context/PLAN.md.
    const implementOutcome = await enqueueAndAwait(
      client,
      addr,
      {
        ...shared,
        prompt: "Implement this plan.",
        mode: "agent",
        planRunId: planOutcome.runId,
        n: Math.min(3, multi.length),
        tests: [{ program: "node", args: ["--test"] }],
      },
      { waitForTerminal: true },
    );
    const runOut = {
      code: implementOutcome.status === "succeeded" ? 0 : 1,
      json: {
        runId: implementOutcome.runId,
        runDir: implementOutcome.runDir,
        status: implementOutcome.status,
        error: implementOutcome.error,
      },
      cwd: repo,
      envFailure: false,
      log: logPath(`${phase}-implement-control-api`),
    };
    writeFileSync(
      runOut.log,
      redactSecrets(
        JSON.stringify(
          {
            threadId: thread.id,
            planRunId: planOutcome.runId,
            implementRunId: implementOutcome.runId,
            status: implementOutcome.status,
            error: implementOutcome.error ?? null,
          },
          null,
          2,
        ),
      ),
    );
    const ev = recordRunEvidence(phase, "implement evidence", runOut, repo);
    if (
      implementOutcome.status === "succeeded" &&
      ev?.patchNonEmpty &&
      gatePassed(ev.detail) &&
      runAdoptedAndVerified(ev) &&
      ev.decision?.verification_basis === "both"
    ) {
      pass(phase, "implement patch+gate", {
        runId: implementOutcome.runId,
        status: implementOutcome.status,
        basis: ev.decision.verification_basis,
      });
    } else {
      fail(phase, "implement patch+gate", {
        runId: implementOutcome.runId,
        status: implementOutcome.status,
        patch: ev?.patchNonEmpty ?? false,
        gatePassed: gatePassed(ev?.detail),
        decision: ev?.decision ?? null,
        error: implementOutcome.error,
      });
    }

    const threadDetail = await requestJson(`/threads/${encodeURIComponent(thread.id)}`);
    const implementTurn = (threadDetail.turns ?? []).find(
      (turn) => turn.runId === implementOutcome.runId,
    );
    const materializedPath = join(implementOutcome.runDir, "context", "PLAN.md");
    const materialized = existsSync(materializedPath) ? readFileSync(materializedPath) : null;
    const eventsPath = join(implementOutcome.runDir, "events.jsonl");
    const planEvent = existsSync(eventsPath)
      ? readFileSync(eventsPath, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            try {
              return JSON.parse(line);
            } catch {
              return null;
            }
          })
          .find(
            (event) =>
              event?.type === "plan.brief.materialized" &&
              event?.payload?.plan_run_id === planOutcome.runId &&
              event?.payload?.sha256 === planHash &&
              event?.payload?.path === "context/PLAN.md",
          )
      : null;
    const lineage = threadDetail.thread?.runIds ?? [];
    const proof = {
      threadId: thread.id,
      planRunId: planOutcome.runId,
      implementRunId: implementOutcome.runId,
      bothRunsInThread:
        lineage.includes(planOutcome.runId) && lineage.includes(implementOutcome.runId),
      turnPlanRunId: implementTurn?.planRunId ?? null,
      turnPlanHash: implementTurn?.planHash ?? null,
      readinessOverridden: implementTurn?.planReadinessOverridden ?? null,
      planArtifactUnchanged: readFileSync(planMd).equals(frozenPlan),
      materializedByteExact: materialized?.equals(frozenPlan) ?? false,
      materializedEvent: Boolean(planEvent),
    };
    const proofValid =
      proof.bothRunsInThread &&
      proof.turnPlanRunId === planOutcome.runId &&
      proof.turnPlanHash === planHash &&
      proof.readinessOverridden === false &&
      proof.planArtifactUnchanged &&
      proof.materializedByteExact &&
      proof.materializedEvent;
    (proofValid ? pass : fail)(phase, "same-thread planRunId Implement freeze", proof);
  } catch (error) {
    fail(phase, "plan lifecycle control API", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function runDelegationPhase() {
  // D32: `orchestrate` is gone; `agent --delegate` injects the scoped Claudexor
  // belt into a claude/codex sandbox so the harness can spawn bounded isolated
  // sub-runs. Positive: a delegate agent run on an mcp_injection harness still
  // produces a work product (the belt injection doesn't break the run).
  // A non-injecting Cursor lane continues as ordinary Agent, but records the
  // stable typed reason instead of silently pretending Delegate was effective.
  const phase = "phase9";
  const candidates = available(requestedHarnesses).filter((h) => h === "claude" || h === "codex");
  for (const h of candidates) {
    const repo = makeMathRepo(`${phase}-${h}-delegate`, { addBug: true });
    const accessArgs = [];
    let fullAccessGranted = false;
    try {
      if (h === "codex") {
        const trust = runCliJson(["trust", "--allow-full-access"], {
          cwd: repo,
          name: `${phase}-${h}-delegate-trust`,
        });
        if (trust.code !== 0) {
          fail(phase, `${h} Delegate disposable full-access grant`, {
            exit: trust.code,
            log: rel(trust.log),
          });
          continue;
        }
        fullAccessGranted = true;
        accessArgs.push("--access", "full");
      }
      const out = runCliJson(
        [
          "agent",
          "First use exactly one claudexor_ask belt tool to locate where add is defined in the original project. Do not ask the child to inspect your private candidate workspace or run tests. Then fix add locally; the configured gate will verify it.",
          "--delegate",
          "--harness",
          h,
          ...accessArgs,
          "--test",
          testCmd(),
          "--effort",
          "low",
          "--max-usd",
          maxUsd,
        ],
        { cwd: repo, name: `${phase}-${h}-delegate` },
      );
      const projected = out.json?.runId
        ? await controlRunDetail(out.json.runId)
        : { detail: null, error: "run id missing" };
      const delegation = projected.detail?.summary?.delegation;
      const children = projected.detail?.children ?? [];
      const child = children.find(
        (item) =>
          item.delegatedFromRunId === out.json?.runId &&
          item.mode === "ask" &&
          item.state === "succeeded",
      );
      if (
        out.code === 0 &&
        out.json?.status === "succeeded" &&
        delegation?.requested === true &&
        delegation?.effective === true &&
        delegation?.used === true &&
        projected.detail?.runFacts?.outcome?.checks === "passed" &&
        projected.detail?.summary?.result?.kind === "patch" &&
        children.length === 1 &&
        child
      )
        pass(phase, `${h} agent --delegate`, {
          runId: out.json.runId,
          childRunId: child.runId,
          delegation,
        });
      else
        fail(phase, `${h} agent --delegate`, {
          exit: out.code,
          status: out.json?.status,
          delegation,
          projectionError: projected.error,
          children: children.map((item) => ({
            runId: item.runId,
            state: item.state,
            mode: item.mode,
            delegatedFromRunId: item.delegatedFromRunId,
          })),
          log: rel(out.log),
        });
    } finally {
      if (fullAccessGranted) {
        const revoke = runCliJson(["trust", "--revoke-full-access"], {
          cwd: repo,
          name: `${phase}-${h}-delegate-trust-revoke`,
        });
        (revoke.code === 0 ? pass : fail)(phase, `${h} Delegate full-access grant revoked`, {
          exit: revoke.code,
          log: rel(revoke.log),
        });
      }
    }
  }
  if (candidates.length === 0)
    skip(phase, "agent --delegate", { reason: "need a doctor-ok claude/codex harness" });
  if (harnessOk("cursor")) {
    const repo = makeMathRepo(`${phase}-cursor-delegate`, { addBug: true });
    const out = runCliJson(
      [
        "agent",
        "Fix add() and verify with node --test in this repo.",
        "--delegate",
        "--harness",
        "cursor",
        "--test",
        testCmd(),
        "--effort",
        "low",
        "--max-usd",
        maxUsd,
      ],
      { cwd: repo, name: `${phase}-cursor-delegate-negative` },
    );
    const detail = out.json?.runId ? inspectRun(out.json.runId, repo) : null;
    const delegation = detail?.telemetry?.delegation;
    if (
      out.json?.runId &&
      delegation?.requested === true &&
      delegation?.effective === false &&
      delegation?.reason === "manifest_unsupported"
    )
      pass(phase, "cursor --delegate typed degradation", {
        runId: out.json.runId,
        reason: delegation.reason,
      });
    else
      fail(phase, "cursor --delegate typed degradation", {
        exit: out.code,
        json: out.json,
        delegation,
        log: rel(out.log),
      });
    if (
      out.code === 0 &&
      out.json?.status === "succeeded" &&
      detail?.runFacts?.outcome?.checks === "passed" &&
      detail?.work_product?.meta?.result_kind === "patch"
    )
      pass(phase, "cursor ordinary Agent after Delegate degradation", {
        runId: out.json.runId,
      });
    else
      fail(phase, "cursor ordinary Agent after Delegate degradation", {
        exit: out.code,
        status: out.json?.status,
        failure: out.json?.failure ?? null,
        log: rel(out.log),
      });
  }
}

/**
 * Delegated MUTATING run under the OS boundary (the CODEX_HOME canonicalize
 * regression, 2026-08-10). A run with `execution.delegated: true` and a
 * write-capable access is the ONE shape that gets the engine's kernel-enforced
 * confinement (macOS Seatbelt) — and codex canonicalizes its CODEX_HOME through
 * the confined runtime root at startup. Before the metadata traversal
 * carve-out in confinement.ts, that shape crashed 100% of the time within
 * seconds (`failed to canonicalize CODEX_HOME ... Operation not permitted`,
 * `route.transient.exhausted: process_crash`), while readonly/ask children —
 * including everything the belt phase above starts — sailed through, which is
 * exactly how the regression shipped unnoticed. This phase is the smoke that
 * makes it visible.
 */
async function runDelegatedConfinementPhase() {
  const phase = "phase13";
  if (!harnessOk("codex")) {
    skip(phase, "delegated mutating codex confined", { reason: "codex not doctor-ok" });
    return;
  }
  const repo = makeMathRepo(`${phase}-codex-delegated`, { addBug: true });
  try {
    const { ensureDaemon, enqueueAndAwait } = await import("../packages/cli/dist/daemon-run.js");
    const { client, addr } = await ensureDaemon();
    // The external-orchestrator shape, verbatim: one-shot POST /runs, live
    // isolation, delegated, workspace_write, codex.
    const outcome = await enqueueAndAwait(
      client,
      addr,
      {
        prompt: "Fix add() in src/math.js so the node:test suite passes. Do not ask questions.",
        mode: "agent",
        scope: { kind: "project", root: repo },
        execution: { isolation: "live", delegated: true },
        harnesses: ["codex"],
        primaryHarness: "codex",
        access: "workspace_write",
        effort: "low",
        paidBudget: { kind: "finite", maxUsd: Number(maxUsd) },
        maxSeconds: 15 * 60,
        tests: [{ program: "node", args: ["--test"] }],
      },
      { waitForTerminal: true },
    );
    const projected = outcome.runId
      ? await controlRunDetail(outcome.runId)
      : { detail: null, error: "run id missing" };
    const confinements = (projected.detail?.candidates ?? [])
      .map((candidate) => candidate.confinement)
      .filter(Boolean);
    // On macOS the boundary must be PROVEN (mechanism + verified denied path);
    // elsewhere the attempt must state the reason there was none. Either way,
    // silence is a failure — a delegated mutating run may not terminalize
    // without applied evidence.
    const evidenceOk =
      confinements.length > 0 &&
      (process.platform === "darwin"
        ? confinements.every((c) => c.proven === true && c.verifiedDeniedPath)
        : confinements.every((c) => c.proven === true || c.unavailableReason));
    if (outcome.status === "succeeded" && evidenceOk) {
      pass(phase, "delegated mutating codex confined", {
        runId: outcome.runId,
        confinements,
      });
    } else {
      fail(phase, "delegated mutating codex confined", {
        runId: outcome.runId ?? null,
        status: outcome.status,
        error: outcome.error ?? null,
        confinements,
        projectionError: projected.error ?? null,
      });
    }
  } catch (error) {
    fail(phase, "delegated mutating codex confined", {
      error: redactSecrets(error instanceof Error ? error.message : String(error)),
    });
  }
}

/** Drive a stdio JSON-RPC server (mcp/acp serve) for one battery phase. */
function stdioServer(args, cwd) {
  const child = spawn(nodeBin, [cli, ...args], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  const messages = [];
  let stderr = "";
  child.stderr.on("data", (c) => {
    stderr += String(c);
  });
  const rl = createInterface({ input: child.stdout });
  rl.on("line", (l) => {
    if (l.trim()) {
      try {
        messages.push(JSON.parse(l));
      } catch {
        /* non-JSON noise is a finding surfaced by timeouts */
      }
    }
  });
  const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
  const waitFor = async (pred, timeout) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      const hit = messages.find(pred);
      if (hit) return hit;
      if (Date.now() > deadline) return null;
      await new Promise((r) => setTimeout(r, 150));
    }
  };
  const close = async () => {
    child.stdin.end();
    await new Promise((r) => setTimeout(r, 200));
    child.kill();
  };
  return { send, waitFor, messages, close, stderrText: () => stderr };
}

/** MCP serve smoke against a REAL doctor-ok harness. */
async function runMcpServePhase() {
  const phase = "phase10";
  const [h] = available(requestedHarnesses);
  if (!h) {
    skip(phase, "mcp serve smoke", { reason: "no doctor-ok harness" });
    return;
  }
  const repo = makeMathRepo(`${phase}-mcp`, { addBug: true });
  const srv = stdioServer(["mcp", "serve"], repo);
  try {
    srv.send({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "battery", version: "1.0" },
      },
    });
    const init = await srv.waitFor((m) => m.id === 0, 20_000);
    if (init?.result?.protocolVersion === "2025-06-18")
      pass(phase, "mcp initialize", { serverVersion: init.result?.serverInfo?.version });
    else {
      fail(phase, "mcp initialize", { init, stderr: srv.stderrText().slice(-300) });
      return;
    }
    srv.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    srv.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools = await srv.waitFor((m) => m.id === 1, 15_000);
    const names = (tools?.result?.tools ?? []).map((t) => t.name);
    const requiredNames = ["claudexor_ask", "claudexor_best_of"];
    const missingNames = requiredNames.filter((name) => !names.includes(name));
    if (missingNames.length === 0) pass(phase, "mcp tools/list", { count: names.length });
    else {
      fail(phase, "mcp tools/list", { names, missingNames });
      return;
    }
    srv.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "claudexor_ask",
        arguments: {
          prompt: "Answer exactly: 4. What is 2+2?",
          repoPath: repo,
          harness: h,
          effort: "low",
          paidBudget: { kind: "finite", maxUsd: Number(maxUsd) },
        },
      },
    });
    // Host-timeout canary: ping must answer while the ask runs.
    srv.send({ jsonrpc: "2.0", id: 3, method: "ping" });
    const ping = await srv.waitFor((m) => m.id === 3, 15_000);
    if (ping) pass(phase, "mcp ping during call", {});
    else fail(phase, "mcp ping during call", { stderr: srv.stderrText().slice(-300) });
    const startedAt = Date.now();
    const call = await srv.waitFor((m) => m.id === 2, timeoutMs);
    const structured = call?.result?.structuredContent;
    const durableHandle =
      call &&
      !call.result?.isError &&
      typeof structured?.runId === "string" &&
      structured.runId.length > 0 &&
      ["queued", "running", "succeeded"].includes(structured.status);
    let terminal = structured?.status === "succeeded" ? structured : null;
    for (let poll = 0; durableHandle && !terminal && Date.now() - startedAt < timeoutMs; poll++) {
      const id = 100 + poll;
      srv.send({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "claudexor_run_result", arguments: { runId: structured.runId } },
      });
      const result = await srv.waitFor((message) => message.id === id, 15_000);
      const candidate = result?.result?.structuredContent;
      if (["succeeded", "failed", "cancelled", "interrupted"].includes(candidate?.status)) {
        terminal = candidate;
        break;
      }
      await new Promise((resolvePoll) => setTimeout(resolvePoll, 500));
    }
    let cleanup = null;
    if (durableHandle && !terminal) {
      srv.send({
        jsonrpc: "2.0",
        id: 9_000,
        method: "tools/call",
        params: { name: "claudexor_run_cancel", arguments: { runId: structured.runId } },
      });
      cleanup = await srv.waitFor((message) => message.id === 9_000, 15_000);
    }
    if (durableHandle && terminal?.status === "succeeded") {
      pass(phase, "mcp ask result", {
        harness: h,
        ms: Date.now() - startedAt,
        runId: structured.runId,
        initialStatus: structured.status,
        terminalStatus: terminal.status,
      });
    } else {
      const text = String(call?.result?.content?.[0]?.text ?? "");
      fail(phase, "mcp ask result", {
        isError: call?.result?.isError,
        structured,
        terminal,
        cleanup: cleanup?.result?.structuredContent ?? null,
        head: text.slice(0, 200),
        stderr: srv.stderrText().slice(-300),
      });
    }
  } finally {
    await srv.close();
  }
}

/** ACP serve smoke against a REAL doctor-ok harness. */
async function runAcpServePhase() {
  const phase = "phase11";
  const [h] = available(requestedHarnesses);
  if (!h) {
    skip(phase, "acp serve smoke", { reason: "no doctor-ok harness" });
    return;
  }
  const repo = makeMathRepo(`${phase}-acp`, { addBug: true });
  const srv = stdioServer(["acp", "serve"], repo);
  try {
    srv.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
    const init = await srv.waitFor((m) => m.id === 1, 20_000);
    if (init?.result?.protocolVersion === 1 && Array.isArray(init.result?.authMethods))
      pass(phase, "acp initialize", { authMethods: init.result.authMethods.length });
    else {
      fail(phase, "acp initialize", { init });
      return;
    }
    srv.send({
      jsonrpc: "2.0",
      id: 2,
      method: "session/new",
      params: { cwd: repo, mcpServers: [] },
    });
    const sess = await srv.waitFor((m) => m.id === 2, 15_000);
    if (!sess?.result?.sessionId) {
      fail(phase, "acp session/new", { sess });
      return;
    }
    pass(phase, "acp session/new", {});
    srv.send({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: {
        sessionId: sess.result.sessionId,
        prompt: [{ type: "text", text: "Answer exactly: 4. What is 2+2?" }],
        _meta: {
          claudexor: {
            mode: "ask",
            harness: h,
            effort: "low",
            paidBudget: { kind: "finite", maxUsd: Number(maxUsd) },
          },
        },
      },
    });
    const done = await srv.waitFor((m) => m.id === 3, timeoutMs);
    const chunk = srv.messages.find(
      (m) =>
        m.method === "session/update" &&
        m.params?.update?.sessionUpdate === "agent_message_chunk" &&
        typeof m.params?.update?.content?.text === "string" &&
        m.params.update.content.text.trim().length > 0,
    );
    const receipt = done?.result?._meta?.claudexor;
    const projected =
      typeof receipt?.runId === "string" && receipt.runId.length > 0
        ? await controlRunDetail(receipt.runId)
        : { detail: null, error: "run id missing" };
    const controlsApplied =
      projected.detail?.summary?.mode === "ask" &&
      JSON.stringify(projected.detail?.summary?.harnesses) === JSON.stringify([h]) &&
      JSON.stringify(projected.detail?.summary?.paidBudget) ===
        JSON.stringify({ kind: "finite", maxUsd: Number(maxUsd) });
    if (
      done?.result?.stopReason === "end_turn" &&
      chunk &&
      typeof receipt?.runId === "string" &&
      receipt.runId.length > 0 &&
      receipt.status === "succeeded" &&
      controlsApplied
    )
      pass(phase, "acp prompt round-trip", { harness: h, runId: receipt.runId });
    else
      fail(phase, "acp prompt round-trip", {
        stopReason: done?.result?.stopReason,
        sawChunk: Boolean(chunk),
        receipt,
        controlsApplied,
        projectionError: projected.error,
        error: done?.error ?? null,
      });
  } finally {
    await srv.close();
  }
}

/** plugin lifecycle in a SCRATCH HOME (never the real one). */
function runPluginLifecyclePhase() {
  const phase = "phase12";
  const scratchHome = join(batteryRoot, "plugin-home");
  mkdirSync(scratchHome, { recursive: true });
  const scratchEnv = { ...env, HOME: scratchHome };
  const runPlugin = (args, name) => {
    const out = spawnSync(nodeBin, [cli, "plugin", ...args, "--json"], {
      env: scratchEnv,
      cwd: batteryRoot,
      encoding: "utf8",
      timeout: 120_000,
    });
    const stdout = out.stdout ?? "";
    let json = null;
    try {
      json = JSON.parse(stdout.slice(stdout.indexOf("{")));
    } catch {
      /* non-JSON output is the failure the caller reports */
    }
    writeFileSync(logPath(`${phase}-${name}`), redactSecrets(stdout + (out.stderr ?? "")));
    return { code: out.status, json };
  };
  const install = runPlugin(["install", "all"], "install");
  if (install.code === 0 && install.json?.ok)
    pass(phase, "plugin install all (scratch HOME)", {
      hosts: (install.json.results ?? []).map((r) => `${r.host}:${r.state}`),
    });
  else {
    fail(phase, "plugin install all (scratch HOME)", { exit: install.code, ok: install.json?.ok });
    return;
  }
  const doctor = runPlugin(["doctor", "all"], "doctor");
  if (doctor.code === 0 && doctor.json?.ok) pass(phase, "plugin doctor all", {});
  else fail(phase, "plugin doctor all", { exit: doctor.code, ok: doctor.json?.ok });
  const uninstall = runPlugin(["uninstall", "all"], "uninstall");
  if (uninstall.code === 0 && uninstall.json?.ok) pass(phase, "plugin uninstall all", {});
  else fail(phase, "plugin uninstall all", { exit: uninstall.code, ok: uninstall.json?.ok });
  const cursorManifest = join(
    scratchHome,
    ".cursor",
    "plugins",
    "local",
    "claudexor",
    ".cursor-plugin",
    "plugin.json",
  );
  if (!existsSync(cursorManifest)) pass(phase, "owned artifacts removed", {});
  else fail(phase, "owned artifacts removed", { survivor: cursorManifest });
}

function phase0(harnessPhasesRequested = true) {
  const phase = "phase0";
  const version = runCliText(["--version"], { name: "version" });
  evidence.version = version.stdout.trim();
  if (version.code === 0 && evidence.version === CLAUDEXOR_VERSION) {
    pass(phase, "cli version", { version: evidence.version });
  } else {
    fail(phase, "cli version", {
      exit: version.code,
      expected: CLAUDEXOR_VERSION,
      observed: evidence.version,
      log: rel(version.log),
    });
  }
  const doctor = runCliJson(["doctor"], { name: "doctor" });
  if (doctor.code !== 0 || !doctor.json?.harnesses) {
    fail(phase, "doctor", {
      exit: doctor.code,
      stdout: doctor.stdout,
      stderr: doctor.stderr,
      log: rel(doctor.log),
    });
    return false;
  }
  const byId = new Map(doctor.json.harnesses.map((h) => [h.id, h]));
  for (const h of requestedHarnesses) {
    const s = byId.get(h);
    if (s) evidence.harnessReports[h] = s;
    if (s?.status === "ok") {
      evidence.okHarnesses.push(h);
      pass(phase, `${h} doctor-ok`, { intents: s.enabledIntents ?? s.enabled_intents ?? [] });
    } else if (harnessPhasesRequested) {
      fail(phase, `${h} doctor-ok`, { status: s?.status ?? "missing", reasons: s?.reasons ?? [] });
    } else {
      // Only harness-INDEPENDENT phases were requested (e.g. PHASES=12):
      // a missing real harness is context, not a battery failure.
      skip(phase, `${h} doctor-ok`, { status: s?.status ?? "missing" });
    }
  }
  evidence.okHarnesses = [...new Set(evidence.okHarnesses)];
  const auth = runCliJson(["auth", "status"], { name: "auth-status" });
  if (auth.code === 0)
    pass(phase, "auth status", { harnesses: (auth.json?.harnesses ?? []).length });
  else fail(phase, "auth status", { exit: auth.code, log: rel(auth.log) });
  if (harnessPhasesRequested) {
    const models = runCliJson(["models", "--harness", requestedHarnesses.join(",")], {
      name: "models",
    });
    if (models.code === 0)
      pass(phase, "models", {
        harnesses: (models.json?.harnesses ?? []).map((h) => `${h.harnessId}:${h.source}`),
      });
    else fail(phase, "models", { exit: models.code, log: rel(models.log) });
  }
  return evidence.okHarnesses.length > 0;
}

const repos = {
  readonly: makeMathRepo("readonly", { addBug: true, multiplyBug: true, testMultiply: false }),
  // A writable clone for agent (write) phases, e.g. the delegation phase.
  write: makeMathRepo("write", { addBug: true, multiplyBug: true, testMultiply: false }),
};
const state = { verifiedRuns: [], multiRace: null };

async function main() {
  evidence.candidate.sha = runGit(["rev-parse", "HEAD"], root);
  evidence.candidate.tree = runGit(["rev-parse", "HEAD^{tree}"], root);
  evidence.forcedBuild.candidateSha = evidence.candidate.sha;
  evidence.forcedBuild.candidateTree = evidence.candidate.tree;
  process.stdout.write(
    `Claudexor real-harness battery\nroot=${batteryRoot}\nconfig=${configDir}\nconfigMode=${layout.mode}\ncandidate=${evidence.candidate.sha}\nharnesses=${requestedHarnesses.join(",")}\nmaxUsd=${maxUsd}\n\n`,
  );
  // Phase 12 (plugin lifecycle in a scratch HOME) needs NO real harness —
  // the readiness gate applies only to harness-dependent phases.
  const harnessPhasesRequested =
    phaseFilter.length === 0 || phaseFilter.some((p) => p !== "phase12");
  try {
    if (layout.mode === "existing_default" && phaseFilter.length > 0) {
      throw new Error("an existing-default acceptance run cannot use CLAUDEXOR_BATTERY_PHASES");
    }
    if (
      layout.mode === "existing_default" &&
      ["codex", "claude", "cursor"].some((harness) => !requestedHarnesses.includes(harness))
    ) {
      throw new Error(
        "existing-default acceptance requires codex, claude, and cursor in CLAUDEXOR_BATTERY_HARNESSES",
      );
    }
    if (
      layout.mode === "existing_default" &&
      runGit(["status", "--porcelain=v1", "--untracked-files=all"], root) !== ""
    ) {
      throw new Error("existing-default acceptance requires a clean exact-candidate checkout");
    }
    await startBatteryDaemon();
    const ready = phase0(harnessPhasesRequested);
    if (!ready && harnessPhasesRequested) {
      fail("phase0", "readiness gate", {
        reason: "no requested harness is doctor-ok; harness-dependent phases cannot proceed",
      });
    }
    if (ready) {
      if (phaseEnabled("phase1")) await runReadonlyPhase();
      if (phaseEnabled("phase2")) runWritePhase();
      if (phaseEnabled("phase3")) runMultiWritePhase();
      if (phaseEnabled("phase4")) runLifecyclePhase();
      if (phaseEnabled("phase5")) runCreatePhase();
      if (phaseEnabled("phase6")) runVisionPhase();
      if (phaseEnabled("phase7")) runWebPhase();
      if (phaseEnabled("phase8")) await runPlanPhase();
      if (phaseEnabled("phase9")) await runDelegationPhase();
      if (phaseEnabled("phase13")) await runDelegatedConfinementPhase();
      if (phaseEnabled("phase10")) await runMcpServePhase();
      if (phaseEnabled("phase11")) await runAcpServePhase();
    }
    if (phaseEnabled("phase12")) runPluginLifecyclePhase();
  } catch (error) {
    fail("fatal", "unhandled error", {
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
  } finally {
    try {
      if (runtimeState.daemonOwned) await verifyNativeSessionRoutes();
    } catch (error) {
      fail("acceptance", "native-route verification completed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      await stopBatteryDaemon();
    } catch (error) {
      fail("cleanup", "battery-owned daemon cleanup completed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      verifyProtectedConfig();
    }
  }
  const summary = {
    generatedAt: new Date().toISOString(),
    evidence,
    counts: {
      pass: results.filter((r) => r.status === "pass").length,
      fail: results.filter((r) => r.status === "fail").length,
      env: results.filter((r) => r.status === "env").length,
      skip: results.filter((r) => r.status === "skip").length,
    },
    results,
  };
  const jsonPath = join(resultsDir, "real-harness-battery.json");
  writeFileSync(jsonPath, JSON.stringify(summary, null, 2) + "\n");
  const md = [
    `# Real-Harness Battery ${runId}`,
    "",
    `- root: \`${batteryRoot}\``,
    `- cli: \`${cli}\``,
    `- version: \`${evidence.version ?? "unknown"}\``,
    `- candidate: \`${evidence.candidate.sha ?? "unknown"}\``,
    `- config mode: \`${layout.mode}\``,
    `- requested harnesses: ${requestedHarnesses.join(", ")}`,
    `- doctor-ok harnesses: ${evidence.okHarnesses.join(", ") || "(none)"}`,
    `- counts: PASS=${summary.counts.pass} FAIL=${summary.counts.fail} ENV=${summary.counts.env} SKIP=${summary.counts.skip}`,
    "",
    "| status | phase | name | detail |",
    "|---|---|---|---|",
    ...results.map(
      (r) =>
        `| ${r.status} | ${r.phase} | ${r.name} | \`${JSON.stringify(r.detail).replaceAll("|", "\\|").slice(0, 500)}\` |`,
    ),
    "",
  ].join("\n");
  const mdPath = join(resultsDir, "real-harness-battery.md");
  writeFileSync(mdPath, md);
  process.stdout.write(
    `\nRESULT PASS=${summary.counts.pass} FAIL=${summary.counts.fail} ENV=${summary.counts.env} SKIP=${summary.counts.skip}\nreport=${jsonPath}\nsummary=${mdPath}\n`,
  );
  const strictFailure =
    layout.mode === "existing_default" &&
    (summary.counts.env > 0 || summary.counts.skip > 0 || evidence.configUnchanged !== true);
  process.exitCode = summary.counts.fail > 0 || strictFailure ? 1 : 0;
}

main().catch((err) => {
  process.stderr.write(
    `${redactSecrets(err instanceof Error ? (err.stack ?? err.message) : String(err))}\n`,
  );
  process.exitCode = 1;
});

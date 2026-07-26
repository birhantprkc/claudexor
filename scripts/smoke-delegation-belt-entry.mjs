#!/usr/bin/env node
/**
 * Protocol smoke for the exact daemon entry shipped to users. Phase one proves
 * that `claudexord mcp serve-belt` negotiates MCP and exposes exactly the
 * scoped six-tool allowlist without creating daemon state. Phase two starts
 * that SAME packaged entry as the daemon, calls a read tool through the SAME
 * belt entry, and requires the daemon's typed `no such run` response. This
 * closes the packaging seam that a tools/list-only smoke cannot exercise.
 */
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const EXPECTED_TOOLS = [
  "claudexor_ask",
  "claudexor_best_of",
  "claudexor_plan",
  "claudexor_run",
  "claudexor_run_result",
  "claudexor_run_status",
];

function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`invalid argument: ${key ?? ""}`);
    }
    values[key.slice(2)] = value;
  }
  if (!values.node || !values.entry || !values["config-root"]) {
    throw new Error(
      "usage: smoke-delegation-belt-entry.mjs --node PATH --entry PATH --config-root PATH",
    );
  }
  return values;
}

function processEnv(configRoot) {
  return {
    HOME: process.env.HOME ?? "/tmp",
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    CLAUDEXOR_CONFIG_DIR: configRoot,
    ...(process.env.CLAUDEXOR_ROOT_MODE
      ? { CLAUDEXOR_ROOT_MODE: process.env.CLAUDEXOR_ROOT_MODE }
      : {}),
    ...(process.env.CLAUDEXOR_PLUGIN_VERSION
      ? { CLAUDEXOR_PLUGIN_VERSION: process.env.CLAUDEXOR_PLUGIN_VERSION }
      : {}),
    CLAUDEXOR_DELEGATION_PARENT_RUN_ID: "smoke-parent-run",
    CLAUDEXOR_DELEGATION_DEPTH: "0",
    CLAUDEXOR_DELEGATION_MAX_SUBRUNS: "8",
    CLAUDEXOR_DELEGATION_BUDGET: JSON.stringify({ kind: "unlimited" }),
  };
}

function spawnBelt(options, env) {
  const child = spawn(options.node, [options.entry, "mcp", "serve-belt"], {
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });
  let stderr = "";
  let protocolParseError = null;
  const messages = [];
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    try {
      messages.push(JSON.parse(line));
    } catch (error) {
      protocolParseError = error;
    }
  });
  return {
    child,
    stderr: () => stderr,
    send: (value) => child.stdin.write(`${JSON.stringify(value)}\n`),
    waitFor: async (id, timeoutMs = 10_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (protocolParseError) {
          throw new Error(
            `belt emitted non-JSON protocol output: ${
              protocolParseError instanceof Error
                ? protocolParseError.message
                : String(protocolParseError)
            }`,
          );
        }
        const message = messages.find((candidate) => candidate?.id === id);
        if (message) return message;
        if (child.exitCode !== null) {
          throw new Error(`belt exited before response ${id}; stderr: ${stderr.slice(-800)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`belt timed out waiting for response ${id}; stderr: ${stderr.slice(-800)}`);
    },
  };
}

async function initializeBelt(belt, id) {
  belt.send({
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "claudexor-belt-smoke", version: "1" },
    },
  });
  const initialized = await belt.waitFor(id);
  if (initialized?.result?.protocolVersion !== "2025-06-18") {
    throw new Error(`unexpected initialize response: ${JSON.stringify(initialized)}`);
  }
  belt.send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
}

async function closeBelt(belt) {
  belt.child.stdin.end();
  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      belt.child.kill("SIGKILL");
      reject(new Error("belt did not exit after stdin closed"));
    }, 5_000);
    belt.child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  if (exitCode !== 0) {
    throw new Error(`belt exited ${exitCode}; stderr: ${belt.stderr().slice(-800)}`);
  }
}

async function stopRecordedDaemon(daemon, stderr) {
  if (daemon.exitCode !== null) {
    throw new Error(`packaged daemon exited before smoke cleanup; stderr: ${stderr().slice(-800)}`);
  }
  daemon.kill("SIGTERM");
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      // This is still the exact recorded scratch-daemon child, never a global
      // process lookup or the user's live daemon.
      daemon.kill("SIGKILL");
      reject(
        new Error(`scratch daemon did not stop after SIGTERM; stderr: ${stderr().slice(-800)}`),
      );
    }, 10_000);
    daemon.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const configRoot = options["config-root"];
  const defaultRoot = join(process.env.HOME ?? "/tmp", ".claudexor");
  if (existsSync(configRoot)) throw new Error(`config root must start absent: ${configRoot}`);
  if (existsSync(defaultRoot)) throw new Error(`default root must start absent: ${defaultRoot}`);
  const env = processEnv(configRoot);

  // Phase 1: serving and listing the belt is side-effect-free.
  const catalogBelt = spawnBelt(options, env);
  try {
    await initializeBelt(catalogBelt, 1);
    catalogBelt.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const listed = await catalogBelt.waitFor(2);
    const names = (listed?.result?.tools ?? [])
      .map((tool) => tool?.name)
      .filter((name) => typeof name === "string")
      .sort();
    if (JSON.stringify(names) !== JSON.stringify(EXPECTED_TOOLS)) {
      throw new Error(
        `belt tool allowlist mismatch: expected ${EXPECTED_TOOLS.join(", ")}; got ${names.join(", ")}`,
      );
    }
  } finally {
    await closeBelt(catalogBelt);
  }
  if (existsSync(configRoot)) {
    throw new Error(`belt protocol startup created daemon/config state at ${configRoot}`);
  }
  if (existsSync(defaultRoot)) {
    throw new Error(`belt protocol startup created default-root state at ${defaultRoot}`);
  }

  // Phase 2: the exact packaged daemon and belt entries must communicate.
  let daemonStderr = "";
  const daemon = spawn(options.node, [options.entry], {
    stdio: ["ignore", "ignore", "pipe"],
    env,
  });
  daemon.stderr.on("data", (chunk) => {
    daemonStderr += String(chunk);
  });
  const daemonError = () => daemonStderr;
  const roundtripBelt = spawnBelt(options, env);
  try {
    await initializeBelt(roundtripBelt, 10);
    const deadline = Date.now() + 15_000;
    let requestId = 11;
    let observed = "";
    let sawTypedMissing = false;
    while (Date.now() < deadline) {
      if (daemon.exitCode !== null) {
        throw new Error(
          `packaged daemon exited before belt roundtrip; stderr: ${daemonStderr.slice(-800)}`,
        );
      }
      roundtripBelt.send({
        jsonrpc: "2.0",
        id: requestId,
        method: "tools/call",
        params: {
          name: "claudexor_run_status",
          arguments: { runId: "smoke-missing-run" },
        },
      });
      const response = await roundtripBelt.waitFor(requestId);
      observed = String(response?.result?.content?.[0]?.text ?? "");
      if (response?.result?.isError === true && /no such run/i.test(observed)) {
        sawTypedMissing = true;
        break;
      }
      requestId += 1;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!sawTypedMissing) {
      throw new Error(
        `belt did not receive the daemon's typed missing-run response; last response: ${observed.slice(-800)}`,
      );
    }
    if (/cannot reach|daemon is not running|daemon start/i.test(observed)) {
      throw new Error(`belt roundtrip degraded to a connection error: ${observed.slice(-800)}`);
    }
  } finally {
    const cleanupErrors = [];
    try {
      await closeBelt(roundtripBelt);
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await stopRecordedDaemon(daemon, daemonError);
    } catch (error) {
      cleanupErrors.push(error);
    } finally {
      rmSync(configRoot, { recursive: true, force: true });
    }
    if (cleanupErrors.length > 0) {
      const details = cleanupErrors
        .map((error) => (error instanceof Error ? error.message : String(error)))
        .join("; ");
      throw new AggregateError(cleanupErrors, `packaged belt roundtrip cleanup failed: ${details}`);
    }
  }
  if (existsSync(defaultRoot)) {
    throw new Error(`packaged roundtrip created default-root state at ${defaultRoot}`);
  }
  process.stdout.write("delegation belt protocol smoke passed\n");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

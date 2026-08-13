import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLI_DAEMON_LAUNCH_SOURCES,
  DAEMON_LAUNCH_SOURCE_ENV,
  daemonLaunchEnvironment,
  launchDetachedDaemon,
} from "./daemon-launch.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "claudexor-daemon-launch-"));
  roots.push(value);
  return value;
}

describe("bounded caller-side daemon launch adapter", () => {
  it("adds exact launch provenance without mutating or dropping the caller environment", () => {
    const base = { HOME: "/tmp/home", KEEP_ME: "yes" };
    const env = daemonLaunchEnvironment(base, CLI_DAEMON_LAUNCH_SOURCES.ensureDaemon);
    expect(env).toMatchObject({
      HOME: "/tmp/home",
      KEEP_ME: "yes",
      [DAEMON_LAUNCH_SOURCE_ENV]: "cli_ensure_daemon",
    });
    expect(base).toEqual({ HOME: "/tmp/home", KEEP_ME: "yes" });
  });

  it("makes an import/pre-claim exit caller-visible without forging the daemon-owned log", async () => {
    const dataRoot = root();
    const entry = join(dataRoot, "exit-before-claim.cjs");
    const sourceReceipt = join(dataRoot, "launch-source.txt");
    writeFileSync(
      entry,
      [
        'const fs = require("node:fs");',
        `fs.writeFileSync(${JSON.stringify(sourceReceipt)}, process.env.CLAUDEXOR_DAEMON_LAUNCH_SOURCE || "missing");`,
        "process.exitCode = 7;",
      ].join("\n"),
    );

    const launch = launchDetachedDaemon({
      entryPath: entry,
      launchSource: CLI_DAEMON_LAUNCH_SOURCES.explicitStart,
      env: { ...process.env, CLAUDEXOR_CONFIG_DIR: dataRoot },
    });
    const failure = await launch.waitForFailure();

    expect(failure).toMatchObject({ kind: "preclaim_exit", exitCode: 7 });
    expect(readFileSync(sourceReceipt, "utf8")).toBe("cli_explicit_start");
    expect(() => readFileSync(join(dataRoot, "daemon", "claudexord.log"), "utf8")).toThrow();
    const error = launch.callerError("startup_wait", 15_000);
    expect(error.code).toBe("daemon_start_failed");
    expect(error.requiredActions?.join(" ")).toContain("daemon logs");
    expect(error.requiredActions?.join(" ")).toMatch(/fixed runtime|eligible/i);
    expect(JSON.stringify(error.context)).toContain("preclaim_exit");
  });

  it("bounds and types a spawn refusal before any daemon authority exists", async () => {
    const dataRoot = root();
    const entry = join(dataRoot, "entry.cjs");
    writeFileSync(entry, "setInterval(() => {}, 1000);\n");
    const launch = launchDetachedDaemon({
      entryPath: entry,
      launchSource: CLI_DAEMON_LAUNCH_SOURCES.ensureDaemon,
      env: { ...process.env, CLAUDEXOR_CONFIG_DIR: dataRoot },
      nodePath: join(dataRoot, `missing-node-${"x".repeat(5000)}`),
    });
    const failure = await launch.waitForFailure();
    expect(failure?.kind).toBe("spawn_error");
    const error = launch.callerError("spawn", 30_000);
    expect(error.code).toBe("daemon_start_failed");
    expect(error.message.length).toBeLessThanOrEqual(2_000);
    expect(JSON.stringify(error.context).length).toBeLessThan(8_192);
  });

  it("refuses a missing entry as an actionable typed pre-spawn error", () => {
    const dataRoot = root();
    expect(() =>
      launchDetachedDaemon({
        entryPath: join(dataRoot, "missing-claudexord.js"),
        launchSource: CLI_DAEMON_LAUNCH_SOURCES.ensureDaemon,
        env: { ...process.env, CLAUDEXOR_CONFIG_DIR: dataRoot },
      }),
    ).toThrow(
      expect.objectContaining({
        code: "daemon_entry_missing",
        retryable: false,
      }),
    );
  });
});

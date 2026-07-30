import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CLAUDEXOR_VERSION } from "@claudexor/util";
import { runProbeIfRequested } from "./claudexord.js";
import {
  admitAndAwaitRuntimeReplacementStop,
  runStopIfRequested,
} from "./runtime-replacement-stop.js";

const EXPECTED_VERSION = "3.4.0";
const EXPECTED_BUILD_SHA = "b".repeat(40);
const STOP_ARGS = ["--stop", EXPECTED_VERSION, EXPECTED_BUILD_SHA];
const LEASE_OWNER = { pid: 4242, token: "lease-owner" };

describe("claudexord --probe (D-2 install probe)", () => {
  it("handles --probe and ignores a normal argv", () => {
    expect(runProbeIfRequested(["--probe"])).toBe(true);
    expect(runProbeIfRequested([])).toBe(false);
    expect(runProbeIfRequested(["--other"])).toBe(false);
  });

  it("prints one JSON line {version, buildSha} and starts nothing durable", () => {
    const dist = resolve(import.meta.dirname, "../dist/claudexord.js");
    if (!existsSync(dist)) {
      // The integration assertion needs the built daemon; `pnpm build` runs
      // before `pnpm test` in the gate. Skip the exec when run pre-build.
      return;
    }
    const sha = "abcdef0123456789abcdef0123456789abcdef01";
    const out = execFileSync("node", [dist, "--probe"], {
      encoding: "utf8",
      timeout: 20_000,
      env: { ...process.env, CLAUDEXOR_BUILD_SHA: sha },
    });
    const lines = out.trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as { version: string; buildSha: string };
    expect(parsed.version).toBe(CLAUDEXOR_VERSION);
    expect(parsed.buildSha).toBe(sha);
  });
});

describe("claudexord --stop (runtime replacement admission)", () => {
  it("projects a typed busy refusal without waiting for termination", async () => {
    const previousExitCode = process.exitCode;
    const output: string[] = [];
    let terminationChecks = 0;
    try {
      process.exitCode = undefined;
      const handled = await runStopIfRequested(STOP_ARGS, {
        socketPath: () => "/tmp/test-daemon.sock",
        readToken: () => "test-token",
        socketAlive: async () => true,
        leaseOwner: () => LEASE_OWNER,
        client: () => ({
          shutdownForRuntimeReplacement: async () => {
            throw Object.assign(new Error("work became active"), {
              code: "runtime_replacement_busy",
              status: 409,
              retryable: true,
            });
          },
        }),
        awaitTermination: async () => {
          terminationChecks += 1;
          return { outcome: "still_alive", detail: "must not be consulted" };
        },
        write: (line) => output.push(line),
      });

      expect(handled).toBe(true);
      expect(terminationChecks).toBe(0);
      expect(process.exitCode).toBe(1);
      expect(JSON.parse(output.join(""))).toEqual({
        stopped: false,
        code: "runtime_replacement_busy",
        retryable: true,
        detail: "work became active",
      });
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("uses termination proof when an accepted response is lost", async () => {
    const previousExitCode = process.exitCode;
    const output: string[] = [];
    let allowSigkill: boolean | undefined;
    try {
      process.exitCode = undefined;
      await runStopIfRequested(STOP_ARGS, {
        socketPath: () => "/tmp/test-daemon.sock",
        readToken: () => "test-token",
        socketAlive: async () => true,
        leaseOwner: () => LEASE_OWNER,
        client: () => ({
          shutdownForRuntimeReplacement: async () => {
            throw new Error("daemon connection closed");
          },
        }),
        awaitTermination: async (_path, options) => {
          allowSigkill = options.allowSigkill;
          expect(options.expectedOwner).toBe(LEASE_OWNER);
          expect(options.requireNoSuccessor).toBe(true);
          return { outcome: "exited", detail: "lease released" };
        },
        write: (line) => output.push(line),
      });

      expect(process.exitCode).toBeUndefined();
      expect(allowSigkill).toBe(false);
      expect(JSON.parse(output.join(""))).toEqual({
        stopped: true,
        outcome: "exited",
        detail: "lease released",
      });
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("fails closed without signalling when admission is ambiguous and the daemon stays alive", async () => {
    const previousExitCode = process.exitCode;
    const output: string[] = [];
    let allowSigkill: boolean | undefined;
    try {
      process.exitCode = undefined;
      await runStopIfRequested(STOP_ARGS, {
        socketPath: () => "/tmp/test-daemon.sock",
        readToken: () => "test-token",
        socketAlive: async () => true,
        leaseOwner: () => LEASE_OWNER,
        client: () => ({
          shutdownForRuntimeReplacement: async () => {
            throw new Error("unknown method: claudexor.shutdownForRuntimeReplacement");
          },
        }),
        awaitTermination: async (_path, options) => {
          allowSigkill = options.allowSigkill;
          return { outcome: "still_alive", detail: "old daemon still owns its lease" };
        },
        write: (line) => output.push(line),
      });

      expect(allowSigkill).toBe(false);
      expect(process.exitCode).toBe(1);
      expect(JSON.parse(output.join(""))).toMatchObject({
        stopped: false,
        code: "runtime_activity_unknown",
        retryable: true,
      });
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("grants signal authority only after an exact fenced admission receipt", async () => {
    const previousExitCode = process.exitCode;
    const output: string[] = [];
    let allowSigkill: boolean | undefined;
    try {
      process.exitCode = undefined;
      await runStopIfRequested(STOP_ARGS, {
        socketPath: () => "/tmp/test-daemon.sock",
        readToken: () => "test-token",
        socketAlive: async () => true,
        leaseOwner: () => LEASE_OWNER,
        client: () => ({
          shutdownForRuntimeReplacement: async (expected) => {
            expect(expected).toEqual({
              version: EXPECTED_VERSION,
              buildSha: EXPECTED_BUILD_SHA,
              leaseOwner: { pid: LEASE_OWNER.pid, token: LEASE_OWNER.token },
            });
            return { ok: true, fenced: true, targetBound: true };
          },
        }),
        awaitTermination: async (_path, options) => {
          allowSigkill = options.allowSigkill;
          return { outcome: "killed", detail: "identity-verified SIGKILL" };
        },
        write: (line) => output.push(line),
      });

      expect(allowSigkill).toBe(true);
      expect(process.exitCode).toBeUndefined();
      expect(JSON.parse(output.join(""))).toMatchObject({ stopped: true, outcome: "killed" });
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("allows a legacy fenced receipt only to passively prove natural exit", async () => {
    let allowSigkill: boolean | undefined;
    await expect(
      admitAndAwaitRuntimeReplacementStop(
        async () => ({ ok: true, fenced: true }),
        async (options) => {
          allowSigkill = options.allowSigkill;
          return { outcome: "exited", detail: "legacy daemon exited naturally" };
        },
        LEASE_OWNER,
      ),
    ).resolves.toMatchObject({ outcome: "exited" });
    expect(allowSigkill).toBe(false);
  });

  it("fails closed when a legacy fenced receipt outlives the passive deadline", async () => {
    await expect(
      admitAndAwaitRuntimeReplacementStop(
        async () => ({ ok: true, fenced: true }),
        async (options) => {
          expect(options.allowSigkill).toBe(false);
          return { outcome: "still_alive", detail: "legacy daemon remained alive" };
        },
        LEASE_OWNER,
      ),
    ).rejects.toMatchObject({ code: "runtime_activity_unknown", retryable: true });
  });

  it("fails closed when the pinned daemon exits but a successor is already live", async () => {
    await expect(
      admitAndAwaitRuntimeReplacementStop(
        async () => {
          throw new Error("admission response lost");
        },
        async (options) => {
          expect(options.expectedOwner).toBe(LEASE_OWNER);
          expect(options.requireNoSuccessor).toBe(true);
          return {
            outcome: "still_alive",
            detail: "pinned daemon exited but successor owns the lease",
          };
        },
        LEASE_OWNER,
      ),
    ).rejects.toMatchObject({ code: "runtime_activity_unknown", retryable: true });
  });

  it("refuses a live socket with missing token without requesting shutdown or termination", async () => {
    const previousExitCode = process.exitCode;
    const output: string[] = [];
    let clients = 0;
    let terminationChecks = 0;
    try {
      process.exitCode = undefined;
      await runStopIfRequested(STOP_ARGS, {
        socketPath: () => "/tmp/test-daemon.sock",
        readToken: () => null,
        socketAlive: async () => true,
        leaseOwner: () => LEASE_OWNER,
        client: () => {
          clients += 1;
          throw new Error("must not construct a client");
        },
        awaitTermination: async () => {
          terminationChecks += 1;
          return { outcome: "exited", detail: "must not be consulted" };
        },
        write: (line) => output.push(line),
      });

      expect(clients).toBe(0);
      expect(terminationChecks).toBe(0);
      expect(process.exitCode).toBe(1);
      expect(JSON.parse(output.join(""))).toMatchObject({
        stopped: false,
        code: "runtime_activity_unknown",
        retryable: true,
      });
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("keeps proven socket-and-lease absence as an idempotent already-stopped success", async () => {
    const previousExitCode = process.exitCode;
    const output: string[] = [];
    try {
      process.exitCode = undefined;
      await runStopIfRequested(STOP_ARGS, {
        socketPath: () => "/tmp/test-daemon.sock",
        readToken: () => null,
        socketAlive: async () => false,
        leaseOwner: () => null,
        client: () => {
          throw new Error("must not construct a client");
        },
        awaitTermination: async () => ({ outcome: "still_alive", detail: "unused" }),
        write: (line) => output.push(line),
      });

      expect(process.exitCode).toBeUndefined();
      expect(JSON.parse(output.join(""))).toEqual({ stopped: true, alreadyStopped: true });
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("refuses a booting daemon that owns the writer lease before its socket binds", async () => {
    const previousExitCode = process.exitCode;
    const output: string[] = [];
    let clients = 0;
    let terminationChecks = 0;
    try {
      process.exitCode = undefined;
      await runStopIfRequested(STOP_ARGS, {
        socketPath: () => "/tmp/test-daemon.sock",
        readToken: () => "test-token",
        socketAlive: async () => false,
        leaseOwner: () => LEASE_OWNER,
        client: () => {
          clients += 1;
          throw new Error("must not construct a client");
        },
        awaitTermination: async () => {
          terminationChecks += 1;
          return { outcome: "exited", detail: "must not be consulted" };
        },
        write: (line) => output.push(line),
      });

      expect(clients).toBe(0);
      expect(terminationChecks).toBe(0);
      expect(process.exitCode).toBe(1);
      expect(JSON.parse(output.join(""))).toMatchObject({
        stopped: false,
        code: "runtime_activity_unknown",
        retryable: true,
      });
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("rejects a stop invocation without exact identity before probing daemon state", async () => {
    const previousExitCode = process.exitCode;
    const output: string[] = [];
    let socketChecks = 0;
    try {
      process.exitCode = undefined;
      await runStopIfRequested(["--stop"], {
        socketPath: () => "/tmp/test-daemon.sock",
        readToken: () => "unused",
        socketAlive: async () => {
          socketChecks += 1;
          return false;
        },
        leaseOwner: () => null,
        client: () => {
          throw new Error("must not construct a client");
        },
        awaitTermination: async () => ({ outcome: "still_alive", detail: "unused" }),
        write: (line) => output.push(line),
      });

      expect(socketChecks).toBe(0);
      expect(process.exitCode).toBe(1);
      expect(JSON.parse(output.join(""))).toMatchObject({
        stopped: false,
        code: "runtime_activity_unknown",
      });
    } finally {
      process.exitCode = previousExitCode;
    }
  });
});

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CLAUDEXOR_VERSION } from "@claudexor/util";
import { runProbeIfRequested } from "./claudexord.js";
import { runStopIfRequested } from "./runtime-replacement-stop.js";

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
      const handled = await runStopIfRequested(["--stop"], {
        socketPath: () => "/tmp/test-daemon.sock",
        readToken: () => "test-token",
        socketAlive: async () => true,
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
    try {
      process.exitCode = undefined;
      await runStopIfRequested(["--stop"], {
        socketPath: () => "/tmp/test-daemon.sock",
        readToken: () => "test-token",
        socketAlive: async () => true,
        client: () => ({
          shutdownForRuntimeReplacement: async () => {
            throw new Error("daemon connection closed");
          },
        }),
        awaitTermination: async () => ({ outcome: "exited", detail: "lease released" }),
        write: (line) => output.push(line),
      });

      expect(process.exitCode).toBeUndefined();
      expect(JSON.parse(output.join(""))).toEqual({
        stopped: true,
        outcome: "exited",
        detail: "lease released",
      });
    } finally {
      process.exitCode = previousExitCode;
    }
  });
});

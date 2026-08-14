import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { type DaemonWriterLeaseStatus } from "@claudexor/daemon";
import {
  assertRemoteEngineIdentity,
  claimSetupAttachment,
  stopRemoteDaemonForRuntimeReplacement,
  switchRemoteRuntimePointer,
} from "./remote-command.js";

const STALE_LEASE = {
  status: "owned",
  path: "/tmp/claudexord.sock.writer",
  owner: { pid: 4242, token: "stale-owner" },
  capability: {
    status: "proven_stale",
    reason: "process_missing",
    observation: {
      identity: { status: "missing", pid: 4242, platform: "linux" },
      linuxState: null,
    },
  },
} satisfies DaemonWriterLeaseStatus;

describe("remote setup attach", () => {
  it("claims a sealed client PTY job exactly once with a private marker", () => {
    const directory = mkdtempSync(join(tmpdir(), "claudexor-attach-"));
    try {
      claimSetupAttachment(directory);
      expect(statSync(join(directory, "client-pty-attached")).mode & 0o777).toBe(0o600);
      expect(() => claimSetupAttachment(directory)).toThrow(/already has/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("remote runtime lifecycle", () => {
  it("requires the running daemon version and build SHA to match before stopping", () => {
    const sha = "a".repeat(40);
    expect(
      assertRemoteEngineIdentity({ engineVersion: "3.4.0", engineBuildSha: sha }, "3.4.0", sha),
    ).toEqual({ version: "3.4.0", buildSha: sha });
    expect(() =>
      assertRemoteEngineIdentity(
        { engineVersion: "3.4.0", engineBuildSha: "b".repeat(40) },
        "3.4.0",
        sha,
      ),
    ).toThrow(/identity mismatch/);
    expect(() =>
      assertRemoteEngineIdentity({ engineVersion: null, engineBuildSha: null }, "3.4.0", sha),
    ).toThrow(/identity mismatch/);
  });

  it("wires the shared no-Control policy for an unreachable proven-stale lease", async () => {
    const output: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((value: unknown) => {
      output.push(String(value));
      return true;
    });
    let inspections = 0;
    try {
      await expect(
        stopRemoteDaemonForRuntimeReplacement("3.4.0", "a".repeat(40), {
          connect: async () => null,
          socketPath: () => "/tmp/claudexord.sock",
          socketReachable: async (path) => {
            expect(path).toBe("/tmp/claudexord.sock");
            return false;
          },
          inspectLease: (path) => {
            expect(path).toBe("/tmp/claudexord.sock");
            inspections += 1;
            return STALE_LEASE;
          },
        }),
      ).resolves.toBe(0);
      expect(inspections).toBe(1);
      expect(JSON.parse(output.join(""))).toEqual({
        ok: true,
        stopped: true,
        alreadyStopped: true,
      });
    } finally {
      stdout.mockRestore();
    }
  });

  it("atomically CAS-switches immutable activation and rollback pointers", () => {
    const root = mkdtempSync(join(tmpdir(), "claudexor-runtime-pointer-"));
    try {
      mkdirSync(join(root, "versions", "3.3.0-old"), { recursive: true });
      mkdirSync(join(root, "versions", "3.4.0-new"), { recursive: true });
      symlinkSync("versions/3.3.0-old", join(root, "current"));
      switchRemoteRuntimePointer("activate", root, "versions/3.3.0-old", "versions/3.4.0-new");
      expect(readlinkSync(join(root, "current"))).toBe("versions/3.4.0-new");
      expect(readlinkSync(join(root, "last-known-good"))).toBe("versions/3.3.0-old");
      expect(lstatSync(join(root, "current")).isSymbolicLink()).toBe(true);
      expect(() =>
        switchRemoteRuntimePointer("rollback", root, "versions/not-current", "versions/3.3.0-old"),
      ).toThrow(/changed concurrently/);
      switchRemoteRuntimePointer("rollback", root, "versions/3.4.0-new", "versions/3.3.0-old");
      expect(readlinkSync(join(root, "current"))).toBe("versions/3.3.0-old");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats an already-absent pointer transition as an idempotent no-op", () => {
    const root = mkdtempSync(join(tmpdir(), "claudexor-runtime-pointer-empty-"));
    try {
      expect(() => switchRemoteRuntimePointer("rollback", root, "-", "-")).not.toThrow();
      expect(() => lstatSync(join(root, "current"))).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

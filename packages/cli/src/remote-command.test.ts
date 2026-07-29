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
import { describe, expect, it } from "vitest";
import {
  assertRemoteEngineIdentity,
  claimSetupAttachment,
  switchRemoteRuntimePointer,
} from "./remote-command.js";

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
    expect(() =>
      assertRemoteEngineIdentity({ engineVersion: "3.4.0", engineBuildSha: sha }, "3.4.0", sha),
    ).not.toThrow();
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

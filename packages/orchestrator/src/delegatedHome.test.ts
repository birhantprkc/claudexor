import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ConfinementHost } from "@claudexor/core";
import { DelegatedEvidenceIncompleteError, DelegatedHomeUnavailableError } from "@claudexor/core";
import { WorkspaceEnvelope } from "@claudexor/schema";
import { WorkspaceManager } from "@claudexor/workspace";
import { ensureDir } from "@claudexor/util";
import {
  appliedAttemptFacts,
  assertDelegatedEvidence,
  confinementNotice,
  externallyConfinedLane,
  scopedHarnessHome,
} from "./delegatedHome.js";

/** A host that offers no OS boundary at all — Windows today, Linux without bwrap. */
const BARE_HOST: ConfinementHost = {
  platform: "win32",
  exists: existsSync,
  run: () => ({ status: 0 }),
};

/** An envelope whose scoped home really exists on disk, in-place or isolated. */
function envelopeAt(base: string, repoRoot: string, inPlace: boolean): WorkspaceEnvelope {
  const homeDir = join(base, "home");
  ensureDir(homeDir);
  return WorkspaceEnvelope.parse({
    id: "env-1",
    task_id: "task-1",
    attempt_id: "a01",
    repo_root: repoRoot,
    base_ref: "HEAD",
    base_sha: null,
    worktree_path: inPlace ? repoRoot : join(base, "tree"),
    branch_name: inPlace ? "inplace" : "claudexor/task-1/a01",
    home_dir: homeDir,
    harness_config_dirs: {
      codex_home: join(homeDir, ".codex"),
      claude_config: join(homeDir, ".claude"),
    },
    policy_profile: "workspace_write",
    dirty_policy: "snapshot",
    created_at: new Date().toISOString(),
  });
}

describe("scopedHarnessHome", () => {
  const base = mkdtempSync(join(tmpdir(), "claudexor-delegated-home-"));
  const repoRoot = join(base, "repo");
  ensureDir(repoRoot);
  const wsm = new WorkspaceManager(repoRoot, { runtimeRoot: join(base, "runtime") });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it("leaves an ordinary in-place attempt on the operator's native environment", () => {
    const home = scopedHarnessHome(wsm, envelopeAt(base, repoRoot, true), true, false);
    // The deliberate pre-existing design: no scoped HOME, so a native vendor
    // session stored under the real $HOME stays resumable.
    expect(home).toEqual({
      isolated: false,
      homeDir: null,
      confinement: null,
      // Null, not a reason: this attempt never ASKED for a boundary. "Not in
      // scope" and "asked and there was none" are different records.
      confinementUnavailableReason: null,
    });
    expect(home.env).toBeUndefined();
  });

  it("scopes an isolated attempt exactly as before", () => {
    const envelope = envelopeAt(base, repoRoot, false);
    const home = scopedHarnessHome(wsm, envelope, false, false);
    expect(home.isolated).toBe(true);
    expect(home.homeDir).toBe(envelope.home_dir);
    expect(home.env).toEqual(wsm.envFor(envelope));
  });

  it("scopes a DELEGATED in-place attempt, overriding HOME and every harness config dir", () => {
    const envelope = envelopeAt(base, repoRoot, true);
    const home = scopedHarnessHome(wsm, envelope, true, true);
    expect(home.isolated).toBe(true);
    expect(home.homeDir).toBe(envelope.home_dir);
    // The operator's real home is never what a delegated harness starts under.
    expect(home.env?.["HOME"]).toBe(envelope.home_dir);
    expect(home.env?.["CODEX_HOME"]).toBe(join(envelope.home_dir, ".codex"));
    expect(home.env?.["CLAUDE_CONFIG_DIR"]).toBe(join(envelope.home_dir, ".claude"));
    expect(home.env?.["XDG_CONFIG_HOME"]).toBe(join(envelope.home_dir, ".config"));
  });

  it("refuses a delegated attempt whose scoped home is absent instead of degrading", () => {
    const envelope = envelopeAt(base, repoRoot, true);
    rmSync(envelope.home_dir, { recursive: true, force: true });
    expect(() => scopedHarnessHome(wsm, envelope, true, true)).toThrowError(
      DelegatedHomeUnavailableError,
    );
    // A NON-delegated run is unaffected by the same missing directory.
    expect(scopedHarnessHome(wsm, envelope, true, false).isolated).toBe(false);
  });
});

describe("delegated confinement", () => {
  const base = mkdtempSync(join(tmpdir(), "claudexor-delegated-conf-"));
  const operatorHome = join(base, "operator");
  const runtimeRoot = join(operatorHome, ".claudexor");
  const repoRoot = join(operatorHome, "project");
  const roots = {
    operatorHome,
    runtimeRoot,
    nativeStateRoot: join(runtimeRoot, "native"),
  };
  for (const dir of [join(runtimeRoot, "daemon"), roots.nativeStateRoot, repoRoot]) ensureDir(dir);
  writeFileSync(join(runtimeRoot, "daemon", "token"), "bearer");
  const wsm = new WorkspaceManager(repoRoot, { runtimeRoot: join(base, "runtime") });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  const darwin = process.platform === "darwin";

  it.runIf(darwin)("gives a delegated MUTATING attempt a proven OS boundary", () => {
    const envelope = envelopeAt(base, repoRoot, true);
    const home = scopedHarnessHome(wsm, envelope, true, true, "workspace_write", roots);
    expect(home.confinement?.mechanism).toBe("seatbelt");
    // Applied, not promised: the policy was executed against a path it denies.
    expect(home.confinement?.verified_denied_path).toContain(".claudexor");
    expect(
      spawnSync(
        "/usr/bin/sandbox-exec",
        ["-p", home.confinement!.profile, "/bin/cat", join(runtimeRoot, "daemon", "token")],
        { encoding: "utf8" },
      ).status,
    ).not.toBe(0);
  });

  it("leaves a delegated READ-ONLY attempt on the harness's own enforcement", () => {
    const envelope = envelopeAt(base, repoRoot, true);
    expect(scopedHarnessHome(wsm, envelope, true, true, "readonly", roots).confinement).toBeNull();
  });

  it("leaves an ordinary mutating attempt unconfined", () => {
    const envelope = envelopeAt(base, repoRoot, false);
    expect(
      scopedHarnessHome(wsm, envelope, false, false, "workspace_write", roots).confinement,
    ).toBeNull();
  });

  it("RUNS a delegated MUTATING attempt on a host with no boundary, and states the absence", () => {
    // The owner's rule, and the thing that made a delegated mutating run
    // impossible on Linux and Windows: this must not throw.
    const envelope = envelopeAt(base, repoRoot, true);
    const home = scopedHarnessHome(wsm, envelope, true, true, "workspace_write", roots, BARE_HOST);
    expect(home.isolated).toBe(true);
    expect(home.confinement).toBeNull();
    expect(home.confinementUnavailableReason).toMatch(/no OS-enforced filesystem boundary/);
  });

  it("tells the CHILD when it is running without a boundary, and stays quiet when it is not", () => {
    const envelope = envelopeAt(base, repoRoot, true);
    const bare = scopedHarnessHome(wsm, envelope, true, true, "workspace_write", roots, BARE_HOST);
    const disclosure = confinementNotice(bare);
    expect(disclosure).toMatch(/NO OS-ENFORCED BOUNDARY/);
    expect(disclosure).toContain(bare.confinementUnavailableReason);
    // Nothing is said to a child that was never asked to be confined, and
    // nothing is said to one that IS confined.
    expect(confinementNotice(scopedHarnessHome(wsm, envelope, true, false))).toBeNull();
    expect(
      confinementNotice({
        isolated: true,
        homeDir: "/scoped",
        confinement: {
          mechanism: "seatbelt",
          profile: "x",
          profile_digest: "sha256:x",
          verified_denied_path: "/x",
        },
        confinementUnavailableReason: null,
      }),
    ).toBeNull();
  });
});

describe("applied attempt evidence", () => {
  const complete = {
    harness_home_isolated: true,
    harness_home_dir: "/scoped",
    access_applied: "external_sandbox_full" as const,
    credential_profile_applied: null,
    confinement_mechanism: "seatbelt",
    confinement_profile_digest: "sha256:abc",
    confinement_verified_denied_path: "/runtime",
    confinement_unavailable_reason: null,
  };
  /** The other complete shape: honestly unconfined, with the reason stated. */
  const unconfined = {
    ...complete,
    access_applied: "workspace_write" as const,
    confinement_mechanism: null,
    confinement_profile_digest: null,
    confinement_verified_denied_path: null,
    confinement_unavailable_reason: "no OS-enforced filesystem boundary is implemented for win32",
  };

  it("writes an all-null block for an attempt that died before its home was decided", () => {
    expect(appliedAttemptFacts(undefined, "workspace_write", null)).toEqual({
      harness_home_isolated: false,
      harness_home_dir: null,
      access_applied: "workspace_write",
      credential_profile_applied: null,
      confinement_mechanism: null,
      confinement_profile_digest: null,
      confinement_verified_denied_path: null,
      confinement_unavailable_reason: null,
    });
  });

  it("carries the stated absence onto the record an attempt writes", () => {
    expect(
      appliedAttemptFacts(
        {
          isolated: true,
          homeDir: "/scoped",
          confinement: null,
          confinementUnavailableReason: "bubblewrap is not installed here",
        },
        "workspace_write",
        null,
      ).confinement_unavailable_reason,
    ).toBe("bubblewrap is not installed here");
  });

  it("refuses a delegated mutating terminal whose attempt evidence is MISSING", () => {
    expect(() =>
      assertDelegatedEvidence(true, "workspace_write", [{ attemptId: "a01" }]),
    ).toThrowError(DelegatedEvidenceIncompleteError);
    // Silence is not the same as an answer: an attempt that says nothing about
    // its boundary is unauditable, even though "no boundary" is allowed.
    expect(() =>
      assertDelegatedEvidence(true, "workspace_write", [
        { attemptId: "a01", applied: { ...unconfined, confinement_unavailable_reason: null } },
      ]),
    ).toThrowError(/neither a proven confinement nor a reason/);
  });

  it("refuses a mechanism NAME that carries no proof, and one that claims both", () => {
    // A reader treats a mechanism without its verified path as no boundary; a
    // terminal must not pass it off as evidence either.
    expect(() =>
      assertDelegatedEvidence(true, "workspace_write", [
        { attemptId: "a01", applied: { ...complete, confinement_verified_denied_path: null } },
      ]),
    ).toThrowError(DelegatedEvidenceIncompleteError);
    expect(() =>
      assertDelegatedEvidence(true, "workspace_write", [
        { attemptId: "a01", applied: { ...complete, confinement_unavailable_reason: "none" } },
      ]),
    ).toThrowError(DelegatedEvidenceIncompleteError);
  });

  it("TERMINALIZES an honestly unconfined delegated mutating run", () => {
    // The Linux/Windows case. Evidence that says "no boundary here, and here is
    // why" is complete evidence; refusing on it is what made the run impossible.
    expect(() =>
      assertDelegatedEvidence(true, "workspace_write", [{ attemptId: "a01", applied: unconfined }]),
    ).not.toThrow();
  });

  it("passes a complete delegated terminal, and never gates the runs it does not own", () => {
    expect(() =>
      assertDelegatedEvidence(true, "workspace_write", [{ attemptId: "a01", applied: complete }]),
    ).not.toThrow();
    // Non-delegated and read-only delegated runs are unaffected.
    expect(() =>
      assertDelegatedEvidence(false, "workspace_write", [{ attemptId: "a01" }]),
    ).not.toThrow();
    expect(() => assertDelegatedEvidence(true, "readonly", [{ attemptId: "a01" }])).not.toThrow();
  });
});

describe("externallyConfinedLane", () => {
  /** A host whose mechanism denies the daemon tree and keeps the carve-outs. */
  const boundaryHost: ConfinementHost = {
    platform: "darwin",
    exists: () => true,
    run: (bin, args) =>
      bin === "/bin/ls"
        ? { status: 0 }
        : { status: args[args.length - 1].includes("daemon") ? 1 : 0 },
  };

  it("stands the harness sandbox down only where a boundary will really replace it", () => {
    expect(externallyConfinedLane(true, boundaryHost)).toBe(true);
    // The Linux/Windows case: asking codex to drop its own workspace-write
    // sandbox buys nothing here, so the run keeps whatever the harness brings.
    expect(externallyConfinedLane(true, BARE_HOST)).toBe(false);
    expect(externallyConfinedLane(false, boundaryHost)).toBe(false);
  });
});

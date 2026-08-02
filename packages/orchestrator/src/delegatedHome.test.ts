import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DelegatedHomeUnavailableError } from "@claudexor/core";
import { WorkspaceEnvelope } from "@claudexor/schema";
import { WorkspaceManager } from "@claudexor/workspace";
import { ensureDir } from "@claudexor/util";
import { scopedHarnessHome } from "./delegatedHome.js";

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
    expect(home).toEqual({ isolated: false, homeDir: null });
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

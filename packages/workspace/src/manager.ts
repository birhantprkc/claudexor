import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { AccessProfile, DirtyPolicy, WorkspaceEnvelope } from "@claudexor/schema";
import { WorkspaceEnvelope as WorkspaceEnvelopeSchema } from "@claudexor/schema";
import {
  CLAUDEXOR_ARTIFACT_DIR,
  claudexorArtifactRunDirectory,
  runCaptureRaw,
  WorkspaceError,
} from "@claudexor/core";
import {
  containsSecretLikeToken,
  ensureDir,
  newId,
  nowIso,
  projectRuntimeDir,
} from "@claudexor/util";
import { ensureLaneHomeEnv, type LaneHomeEnv } from "./lanes.js";
import {
  excludePlainDiffPathPrefix,
  plainDiffBinarySecretLike,
  relativizePlainDiffHeaders,
} from "./plain-diff.js";
import {
  CLAUDE_BRIDGE_BASENAME,
  bridgeCreatedMarkerMatches,
  ensureClaudeBridge,
  isGeneratedClaudeBridge,
  writeBridgeCreatedMarker,
} from "./claude-bridge.js";
import {
  branchDelete,
  captureWorkingTreeTransient,
  isolatedCloneAdd,
  isGitRepo,
  revParse,
  snapshotTree,
  statusPorcelain,
  stashCreate,
  worktreePrune,
  worktreeRemove,
} from "./git.js";

export interface CreateEnvelopeOptions {
  taskId: string;
  attemptId: string;
  baseRef?: string;
  accessProfile?: AccessProfile;
  dirtyPolicy?: DirtyPolicy;
  /**
   * Run against the live `repoRoot` directly instead of an isolated git worktree.
   * Used for external stateful environments that may not be git repositories
   * and whose runtime STATE, not a patch, is the deliverable.
   * `dispose()` never deletes the live tree in this mode; a best-effort baseline
   * snapshot backs `diff()` and reviewers also read the live tree directly.
   */
  inPlace?: boolean;
}

interface ArtifactOwnershipMarker {
  version: 1;
  envelope_id: string;
  relative_path: string;
  root_created: boolean;
}

/**
 * Manages WorkspaceEnvelopes: an isolated Git checkout plus scoped HOME and
 * per-harness config dirs, and dirty-tree handling. Claudexor owns these
 * envelopes (it does not rely on a harness's native --worktree).
 */
/** `ps` start time for a pid, or null when unavailable. Pid+start-time
 * equality is the recycling-proof liveness identity for envelope owners
 * (command names/titles mutate; the kernel start time never does). */
export function processStartTime(pid: number): string | null {
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

export class WorkspaceManager {
  private readonly runtimeRoot: string;

  /**
   * Envelope ids whose worktree bridge THIS manager's prep actually created
   * (`ensureClaudeBridge` returned `created: true`) during THIS run. The
   * diff-exclusion of the generated `CLAUDE.md` bridge is gated on this recorded
   * fact — not on content alone (A-3 residual): byte-equality cannot tell "we
   * wrote this bridge this run" from "a candidate rewrote a PRE-EXISTING
   * committed CLAUDE.md to exactly CLAUDE_BRIDGE_CONTENT", and excluding the
   * latter would silently drop the candidate's real edit. This state is
   * intentionally in-memory and per-manager: if a daemon upgrade recreates the
   * manager mid-run the fact is lost, and its ABSENCE fails toward CAPTURE
   * (exclude only on positive proof), matching the safe-direction doctrine.
   */
  private readonly bridgeCreatedEnvelopes = new Set<string>();

  constructor(
    private readonly repoRoot: string,
    options: { runtimeRoot?: string } = {},
  ) {
    this.runtimeRoot = options.runtimeRoot ?? projectRuntimeDir(repoRoot);
  }

  private workspacesDir(): string {
    return join(this.runtimeRoot, "workspaces");
  }

  /**
   * The scoped envelope base for a task/attempt. The sole on-disk root we
   * delete on dispose — so the ids MUST be path-safe segments and the resolved
   * base MUST stay inside the workspaces dir (a crafted `../` id could
   * otherwise turn dispose() into an arbitrary recursive delete).
   */
  private envelopeBase(taskId: string, attemptId: string): string {
    const idPattern = /^[A-Za-z0-9._-]+$/;
    for (const [label, id] of [
      ["taskId", taskId],
      ["attemptId", attemptId],
    ] as const) {
      if (!idPattern.test(id) || id === "." || id === "..") {
        throw new WorkspaceError(`${label} '${id}' is not a safe path segment`);
      }
    }
    const base = join(this.workspacesDir(), taskId, attemptId);
    if (!base.startsWith(this.workspacesDir() + sep)) {
      throw new WorkspaceError(`envelope base escapes the workspaces dir: ${base}`);
    }
    return base;
  }

  private artifactMarkerPath(env: WorkspaceEnvelope): string {
    return join(this.envelopeBase(env.task_id, env.attempt_id), "artifact-created.json");
  }

  private artifactMarker(env: WorkspaceEnvelope): ArtifactOwnershipMarker | null {
    try {
      const parsed = JSON.parse(
        readFileSync(this.artifactMarkerPath(env), "utf8"),
      ) as Partial<ArtifactOwnershipMarker>;
      const relative = claudexorArtifactRunDirectory(env.id);
      if (
        parsed.version !== 1 ||
        parsed.envelope_id !== env.id ||
        parsed.relative_path !== relative ||
        typeof parsed.root_created !== "boolean"
      ) {
        return null;
      }
      return parsed as ArtifactOwnershipMarker;
    } catch {
      return null;
    }
  }

  /** Lazily reserve the one run-owned artifact subtree. A pre-existing shared
   * root is ordinary user state; only this marker-bound child is excluded,
   * collected, and cleaned. */
  ensureArtifactDirectory(env: WorkspaceEnvelope): string {
    const relative = claudexorArtifactRunDirectory(env.id);
    const root = join(env.worktree_path, CLAUDEXOR_ARTIFACT_DIR);
    const path = join(env.worktree_path, relative);
    const marker = this.artifactMarker(env);
    if (marker) {
      this.ensureSafeArtifactRoot(root);
      if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new WorkspaceError("owned artifact path is no longer a private directory");
      }
      return path;
    }

    let rootCreated = false;
    try {
      mkdirSync(root, { mode: 0o700 });
      rootCreated = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    this.ensureSafeArtifactRoot(root);
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if (rootCreated) {
        try {
          rmdirSync(root);
        } catch {
          /* preserve a raced/non-empty root */
        }
      }
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new WorkspaceError("owned artifact path unexpectedly already exists");
      }
      throw error;
    }
    const ownership: ArtifactOwnershipMarker = {
      version: 1,
      envelope_id: env.id,
      relative_path: relative,
      root_created: rootCreated,
    };
    try {
      writeFileSync(this.artifactMarkerPath(env), `${JSON.stringify(ownership)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      rmSync(path, { recursive: true, force: true });
      if (rootCreated) {
        try {
          rmdirSync(root);
        } catch {
          /* preserve a raced/non-empty root */
        }
      }
      throw error;
    }
    return path;
  }

  ownedArtifactRelativeDirectory(env: WorkspaceEnvelope): string | null {
    return this.artifactMarker(env)?.relative_path ?? null;
  }

  private ensureSafeArtifactRoot(root: string): void {
    const stat = lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new WorkspaceError("shared artifact root is not a real directory");
    }
  }

  private removeOwnedArtifactDirectory(env: WorkspaceEnvelope): void {
    const marker = this.artifactMarker(env);
    if (!marker) return;
    const root = join(env.worktree_path, CLAUDEXOR_ARTIFACT_DIR);
    const path = join(env.worktree_path, marker.relative_path);
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      /* best-effort: never broaden cleanup beyond the marker-bound child */
    }
    if (!marker.root_created) return;
    try {
      const stat = lstatSync(root);
      if (stat.isDirectory() && !stat.isSymbolicLink() && readdirSync(root).length === 0) {
        rmdirSync(root);
      }
    } catch {
      /* preserve a missing, replaced, raced, or non-empty shared root */
    }
  }

  async create(opts: CreateEnvelopeOptions): Promise<WorkspaceEnvelope> {
    // Envelope base holds scoped dirs (HOME + per-harness config) and, for git
    // mode, the worktree as a subdir — so harness-written caches, plugins,
    // transcripts, and route-scoped API auth state live outside the work tree
    // and never land in a diff. Credentials are never copied into this
    // envelope; adapters may add only capability-declared, vendor-specific
    // child context (Claude/Cursor macOS Keychain bridge, INV-067).
    const base = this.envelopeBase(opts.taskId, opts.attemptId);
    ensureDir(base);
    const homeDir = join(base, "home");
    const codexHome = join(homeDir, ".codex");
    const claudeConfig = join(homeDir, ".claude");
    const cursorConfig = join(homeDir, ".cursor");
    const opencodeConfig = join(homeDir, ".config", "opencode");
    for (const d of [homeDir, codexHome, claudeConfig, cursorConfig, opencodeConfig]) {
      ensureDir(d);
    }
    const harnessConfigDirs = {
      codex_home: codexHome,
      claude_config: claudeConfig,
      cursor_config: cursorConfig,
      opencode_config: opencodeConfig,
    };
    // Liveness marker for crash GC: the sweeper must never dispose an envelope
    // whose creating process (daemon, CLI, MCP/ACP serve) is still alive —
    // startup GC's "nothing can own an envelope" premise only holds for
    // daemon-tracked runs. Pid + ps START TIME form a recycling-proof identity
    // (command names/titles mutate — vitest, daemons and tools retitle
    // themselves; the kernel start time never does).
    writeFileSync(
      join(base, "owner.json"),
      JSON.stringify({
        pid: process.pid,
        started: processStartTime(process.pid),
        created_at: nowIso(),
      }) + "\n",
    );

    // In-place mode: mutate the live repoRoot directly (no isolated checkout).
    // Used for thread turns (chat-first: the next turn sees this one's work) and
    // for stateful external environments where runtime state is the deliverable.
    // For a git project we record a per-turn snapshot sha so diff() captures only
    // THIS turn's net change; a non-git folder falls back to a cpSync baseline.
    if (opts.inPlace) {
      const gitRepo = await isGitRepo(this.repoRoot);
      const baseSha = gitRepo ? await snapshotTree(this.repoRoot) : null;
      if (!gitRepo) this.snapshotBaseline(base);
      return WorkspaceEnvelopeSchema.parse({
        id: newId("env"),
        task_id: opts.taskId,
        attempt_id: opts.attemptId,
        repo_root: this.repoRoot,
        base_ref: opts.baseRef ?? "HEAD",
        base_sha: baseSha,
        worktree_path: this.repoRoot,
        branch_name: "inplace",
        home_dir: homeDir,
        harness_config_dirs: harnessConfigDirs,
        policy_profile: opts.accessProfile ?? "workspace_write",
        // Record the EFFECTIVE policy, not the ignored request: in-place runs
        // always fold dirty state into the per-turn base snapshot above.
        dirty_policy: "snapshot",
        created_at: nowIso(),
      });
    }

    if (!(await isGitRepo(this.repoRoot))) {
      throw new WorkspaceError(`not a git repository: ${this.repoRoot}`);
    }
    const baseRef = opts.baseRef ?? "HEAD";
    const dirtyPolicy: DirtyPolicy = opts.dirtyPolicy ?? "refuse";
    let baseSha = await revParse(this.repoRoot, baseRef);

    const porcelain = await statusPorcelain(this.repoRoot);
    const dirty = porcelain.trim().length > 0;
    if (dirty) {
      if (dirtyPolicy === "refuse") {
        throw new WorkspaceError(
          "working tree is dirty; commit/stash or set dirty_policy: snapshot",
        );
      }
      // snapshot: a stash-create commit becomes the base SHA without touching
      // the live tree. (The include/stash aliases and the untested `copy`
      // variant were retired in the v0.15 triage.)
      const snap = await stashCreate(this.repoRoot);
      if (snap) baseSha = snap;
    }

    const path = join(base, "tree");
    const branch = `claudexor/${opts.taskId}/${opts.attemptId}`;
    await isolatedCloneAdd(this.repoRoot, path, branch, baseSha);
    writeFileSync(join(base, "private-clone-v1"), "private Git authority\n");

    // AGENTS.md bridge (INV-113): the checkout omits the untracked project-root bridge,
    // envelope — a Claude Code candidate here would otherwise lack CLAUDE.md.
    // Write an envelope-local bridge so the candidate reads the same AGENTS.md.
    // Self-fenced (acts only with a committed AGENTS.md and no CLAUDE.md),
    // best-effort, and no run event. `diff()` excludes the generated bridge so it never enters
    // the candidate patch.
    // ONLY when THIS prep actually created the bridge (recorded below) does diff()
    // exclude it; a CLAUDE.md already present is never excluded (A-3 residual).
    let bridgeCreatedHere = false;
    try {
      bridgeCreatedHere = ensureClaudeBridge(path).created;
    } catch {
      /* a missing bridge is harmless; never fail envelope creation over it */
    }

    const envelope = WorkspaceEnvelopeSchema.parse({
      id: newId("env"),
      task_id: opts.taskId,
      attempt_id: opts.attemptId,
      repo_root: this.repoRoot,
      base_ref: baseRef,
      base_sha: baseSha,
      worktree_path: path,
      branch_name: branch,
      home_dir: homeDir,
      harness_config_dirs: harnessConfigDirs,
      policy_profile: opts.accessProfile ?? "workspace_write",
      dirty_policy: dirtyPolicy,
      created_at: nowIso(),
    });
    // Record the created-this-run fact keyed by envelope id, so diff() gates the
    // bridge exclusion on POSITIVE PROOF rather than on content bytes alone.
    // Persisted beside owner.json as well (bridge-created.json): the in-memory
    // set dies with THIS manager instance (daemon restart mid-run), and losing
    // the fact CAPTURES a pristine generated bridge into patch.diff.
    if (bridgeCreatedHere) {
      this.bridgeCreatedEnvelopes.add(envelope.id);
      writeBridgeCreatedMarker(base, envelope.id);
    }
    return envelope;
  }

  /**
   * Best-effort baseline copy of the live tree for in-place diff(). Copies each
   * top-level entry individually while skipping only VCS/heavy ephemeral dirs.
   * The baseline is external, so project `.claudexor/` content is ordinary user
   * state and is copied like every other project path. On any failure the
   * baseline is absent and diff() returns empty; reviewers still read the tree.
   */
  private snapshotBaseline(base: string): void {
    const baseline = join(base, "baseline");
    const skip = new Set([".git", "node_modules", "__pycache__", ".venv", "venv"]);
    try {
      ensureDir(baseline);
      for (const entry of readdirSync(this.repoRoot)) {
        if (skip.has(entry)) continue;
        cpSync(join(this.repoRoot, entry), join(baseline, entry), { recursive: true });
      }
    } catch {
      /* baseline unavailable -> diff() falls back to empty */
    }
  }

  /** Env vars that scope a child harness to this envelope (HOME + per-harness config dirs). */
  envFor(env: WorkspaceEnvelope): Record<string, string> {
    return {
      HOME: env.home_dir,
      CODEX_HOME: env.harness_config_dirs["codex_home"] ?? join(env.home_dir, ".codex"),
      CLAUDE_CONFIG_DIR: env.harness_config_dirs["claude_config"] ?? join(env.home_dir, ".claude"),
      // Pin XDG_CONFIG_HOME to the scoped home so an XDG-aware harness
      // (opencode/cursor) cannot follow an INHERITED XDG_CONFIG_HOME back into the
      // operator's real ~/.config under `mirror_native` (§6 containment).
      XDG_CONFIG_HOME: join(env.home_dir, ".config"),
    };
  }

  /**
   * Provision a SCOPED, worktree-less harness HOME for READ-ONLY routes (plan,
   * ask, audit, orchestrate, reviewers). Read-only modes build no git worktree,
   * but a harness still writes native state — claude-code plan files, codex
   * session rollouts, transcripts — into `$HOME/.claude`, `$CODEX_HOME`, etc.
   * Without this, those land in the operator's REAL home (a live-caught leak: a
   * read-only `plan` wrote into `~/.claude/plans`). Same env shape as `envFor`:
   * non-native state and injected API-key routes stay scoped. This GENERIC
   * home never bridges the OS Keychain; an adapter that declares
   * `scoped_home_keychain_bridge` may create a vendor-only disposable child
   * HOME without copying credentials (INV-067). Caller disposes all scoped
   * state when the run ends.
   */
  readOnlyHomeEnv(): { env: Record<string, string>; dispose: () => void } {
    // A throwaway temp base — never under the project / synthetic repo root, so a
    // no-project Ask leaves nothing in its cwd (§7) and nothing in any worktree (§6).
    const base = mkdtempSync(join(tmpdir(), "claudexor-ro-"));
    const homeDir = join(base, "home");
    const codexHome = join(homeDir, ".codex");
    const claudeConfig = join(homeDir, ".claude");
    const cursorConfig = join(homeDir, ".cursor");
    const opencodeConfig = join(homeDir, ".config", "opencode");
    for (const d of [homeDir, codexHome, claudeConfig, cursorConfig, opencodeConfig]) ensureDir(d);
    return {
      env: {
        HOME: homeDir,
        CODEX_HOME: codexHome,
        CLAUDE_CONFIG_DIR: claudeConfig,
        XDG_CONFIG_HOME: join(homeDir, ".config"),
      },
      dispose: () => {
        try {
          rmSync(base, { recursive: true, force: true });
        } catch {
          /* best-effort: a leftover scoped home is harmless and gc-able */
        }
      },
    };
  }

  /**
   * Provision the DURABLE per-lane read-only home for a THREAD turn (INV-034).
   * Unlike `readOnlyHomeEnv`, this base is PERSISTENT under the project runtime
   * namespace and keyed by (thread, harness, profile): the next read-only turn
   * of the same lane reuses it, so the harness's recorded native session is
   * reachable for `codex exec resume` / `claude --resume`. Never disposed with
   * the run — the thread-purge / profile-deletion / retention owners remove it.
   */
  laneHomeEnv(threadId: string, harnessId: string, profileId: string | null): LaneHomeEnv {
    return ensureLaneHomeEnv(this.runtimeRoot, threadId, harnessId, profileId);
  }

  async captureDiff(env: WorkspaceEnvelope): Promise<{
    diff: string;
    binarySecretLike: boolean;
  }> {
    // In-place: there is no isolated worktree. Capture the candidate tree in a
    // temporary object database so a secret refusal cannot leave its bytes as
    // dangling objects in the user's repository. The exact per-turn base still
    // folds prior dirty state out of this turn's diff.
    const artifactRelative = this.ownedArtifactRelativeDirectory(env);
    const artifactExcludes = artifactRelative ? [`:(exclude,top)${artifactRelative}`] : [];
    if (env.worktree_path === env.repo_root) {
      if (env.base_sha) {
        const captured = await captureWorkingTreeTransient(
          env.repo_root,
          env.base_sha,
          artifactExcludes,
        );
        return { diff: captured.patch, binarySecretLike: captured.binarySecretLike };
      }
      // Non-git fallback: diff the best-effort cpSync baseline against the live
      // tree. Missing or failed capture is an uncaptured binary risk, never a
      // safe no-change result.
      const baseline = join(this.envelopeBase(env.task_id, env.attempt_id), "baseline");
      if (!existsSync(baseline)) return { diff: "", binarySecretLike: true };
      try {
        const r = await runCaptureRaw(
          "diff",
          [
            "-ruN",
            "-x",
            ".git",
            "-x",
            "node_modules",
            "-x",
            "__pycache__",
            "-x",
            ".venv",
            "-x",
            "venv",
            baseline,
            env.repo_root,
          ],
          { timeoutMs: 120_000 },
        );
        if (r.code !== 0 && r.code !== 1) {
          return { diff: "", binarySecretLike: true };
        }
        // Relativize the header paths to the git-style a/<rel> b/<rel> shape.
        // Downstream consumers (diffstat, protected-path/risk gating) match
        // REPO-RELATIVE globs like `test/**`; absolute `/…/repo/test/x`
        // headers would silently bypass every one of them.
        const fullDiff = relativizePlainDiffHeaders(r.stdout, baseline, env.repo_root);
        const relativized = artifactRelative
          ? excludePlainDiffPathPrefix(fullDiff, artifactRelative)
          : fullDiff;
        const CAP = 200_000;
        return {
          diff:
            relativized.length > CAP
              ? relativized.slice(0, CAP) + "\n... [diff truncated]\n"
              : relativized,
          // Inspect the complete captured text before projecting it into the
          // bounded artifact. A token beyond the 200k display cap must still
          // trip the secret fence.
          binarySecretLike:
            containsSecretLikeToken(relativized) ||
            plainDiffBinarySecretLike(relativized, env.repo_root),
        };
      } catch {
        return { diff: "", binarySecretLike: true };
      }
    }
    // Exclude the envelope-local generated CLAUDE.md bridge (INV-113) from the
    // candidate patch — by EXACT path, and only when BOTH conditions hold: (1)
    // THIS run's prep actually created the bridge (the recorded created-this-run
    // fact), and (2) the worktree file is still BYTE-IDENTICAL to the generated
    // bridge content. A git pathspec cannot express either condition, so the
    // decision is computed in code here. Condition (1) closes the A-3 residual:
    // byte-equality alone cannot tell our freshly written bridge from a candidate
    // that rewrote a PRE-EXISTING committed CLAUDE.md to exactly the bridge bytes,
    // and excluding the latter would silently drop the candidate's real edit. If
    // the created fact is absent (pre-existing file, or a prior run), we NEVER
    // exclude — failing toward CAPTURE. Condition (2) keeps a candidate that
    // EDITED the bridge we DID create in the diff. Same exact-path doctrine as
    // the marker-bound artifact-child exclusion. The fact survives a manager
    // restart via the persisted bridge-created.json marker (envelope-id-bound),
    // read only when the in-memory set lacks the id.
    const bridgeExcludes =
      this.bridgeCreatedFact(env) && isGeneratedClaudeBridge(env.worktree_path)
        ? [`:(exclude,top)${CLAUDE_BRIDGE_BASENAME}`]
        : [];
    const captured = await captureWorkingTreeTransient(env.worktree_path, env.base_sha ?? "HEAD", [
      ...artifactExcludes,
      ...bridgeExcludes,
    ]);
    return { diff: captured.patch, binarySecretLike: captured.binarySecretLike };
  }

  async diff(env: WorkspaceEnvelope): Promise<string> {
    return (await this.captureDiff(env)).diff;
  }

  /** The created-this-run bridge fact for diff(): in-memory set first, else
   *  the persisted envelope-id-bound marker (survives manager recreation). */
  private bridgeCreatedFact(env: WorkspaceEnvelope): boolean {
    if (this.bridgeCreatedEnvelopes.has(env.id)) return true;
    return bridgeCreatedMarkerMatches(this.envelopeBase(env.task_id, env.attempt_id), env.id);
  }

  async dispose(env: WorkspaceEnvelope): Promise<void> {
    // Drop the created-this-run bridge fact so a long-lived manager doesn't
    // accumulate envelope ids (a disposed envelope is never diffed again).
    this.bridgeCreatedEnvelopes.delete(env.id);
    // In-place envelopes point worktree_path at the live repo root; NEVER remove a
    // worktree or the tree itself in that case.
    const inPlace = env.worktree_path === env.repo_root;
    if (inPlace) this.removeOwnedArtifactDirectory(env);
    if (!inPlace) {
      const privateClone = existsSync(
        join(this.envelopeBase(env.task_id, env.attempt_id), "private-clone-v1"),
      );
      if (!privateClone) {
        try {
          await worktreeRemove(this.repoRoot, env.worktree_path);
        } catch {
          /* best-effort */
        }
        if (env.branch_name && env.branch_name !== "inplace") {
          try {
            await branchDelete(this.repoRoot, env.branch_name);
          } catch {
            /* best-effort */
          }
        }
      }
    }
    // Remove only the scoped envelope base (worktree + scoped home/env/logs/artifacts/
    // baseline, including any route-scoped API auth material), derived from task/attempt ids.
    // For git mode this equals dirname(worktree_path); for in-place it is a sibling
    // under the external runtime workspaces root, so deriving from ids prevents
    // dispose() from ever deleting the live tree.
    try {
      rmSync(this.envelopeBase(env.task_id, env.attempt_id), { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    // Prune the now-empty per-task parent dir (envelopeBase = <task>/<attempt>),
    // guarded to stay strictly inside the workspaces dir.
    try {
      const taskDir = join(this.workspacesDir(), env.task_id);
      if (
        taskDir.startsWith(this.workspacesDir() + sep) &&
        existsSync(taskDir) &&
        readdirSync(taskDir).length === 0
      ) {
        rmSync(taskDir, { recursive: true, force: true });
      }
    } catch {
      /* best-effort */
    }
    try {
      await worktreePrune(this.repoRoot);
    } catch {
      /* best-effort (repo may not be git in in-place mode) */
    }
  }

  /**
   * Dispose an ORPHANED envelope by ids alone (crash GC): a daemon
   * crash leaves envelopes with no live job. Reconstructs the disposal
   * surface (worktree path, branch name, envelope base) from the same id
   * derivation create() used, so the safety invariants (id-validated base,
   * never the live tree) hold without a persisted envelope record.
   */
  async disposeOrphan(taskId: string, attemptId: string): Promise<void> {
    const base = this.envelopeBase(taskId, attemptId);
    await this.dispose(
      WorkspaceEnvelopeSchema.parse({
        id: newId("env"),
        task_id: taskId,
        attempt_id: attemptId,
        repo_root: this.repoRoot,
        base_ref: "HEAD",
        base_sha: "0000000000000000000000000000000000000000",
        worktree_path: join(base, "tree"),
        branch_name: `claudexor/${taskId}/${attemptId}`,
        home_dir: join(base, "home"),
        harness_config_dirs: {
          codex_home: join(base, "home", ".codex"),
          claude_config: join(base, "home", ".claude"),
          cursor_config: join(base, "home", ".cursor"),
          opencode_config: join(base, "home", ".config", "opencode"),
        },
        policy_profile: "workspace_write",
        dirty_policy: "snapshot",
        created_at: nowIso(),
      }),
    );
  }
}

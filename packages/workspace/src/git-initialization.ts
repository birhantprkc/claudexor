import { WorkspaceError } from "@claudexor/core";
import { probeGitCapability, requireGitCapability } from "./git-capability.js";

export interface GitCommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type GitRunner = (repo: string, args: string[], input?: string) => Promise<GitCommandResult>;

export interface EnsureGitRepositoryResult {
  /** True when `git init` ran (the folder was not a repository). */
  initialized: boolean;
  /** True when a baseline commit was created (fresh repo or unborn HEAD). */
  baselineCommitted: boolean;
  /** Always false in v2: Claudexor never changes a project's `.gitignore`. */
  gitignoreSeeded: boolean;
  /** HEAD sha after the call. */
  headSha: string;
}

export interface GitInitializationProgress {
  initialized: boolean;
  baselineCommitted: boolean;
  gitignoreSeeded: false;
  headSha: string | null;
  failedStage: "init" | "add" | "commit" | "head";
}

/** A Git-boundary setup failed after it may already have changed repository
 * metadata. Callers must disclose this progress before terminal failure. */
export class GitInitializationError extends WorkspaceError {
  constructor(
    message: string,
    readonly progress: GitInitializationProgress,
  ) {
    super(message);
    this.name = "GitInitializationError";
  }
}

export interface EnsureGitRepositoryDependencies {
  probeCapability?: typeof probeGitCapability;
  runGit?: GitRunner;
}

/**
 * Establish the write-mode Git boundary. The caller supplies the canonical Git
 * runner so command execution remains owned by git.ts while this module owns
 * only the initialization transaction and its partial-progress receipt.
 */
export async function initializeGitRepository(
  repo: string,
  runGit: GitRunner,
  probeCapability: typeof probeGitCapability = probeGitCapability,
): Promise<EnsureGitRepositoryResult> {
  requireGitCapability(await probeCapability());
  const inside = await runGit(repo, ["rev-parse", "--is-inside-work-tree"]);
  const isRepo = inside.code === 0 && inside.stdout.trim() === "true";
  const hasHead = isRepo && (await runGit(repo, ["rev-parse", "--verify", "HEAD"])).code === 0;
  if (isRepo && hasHead) {
    const head = await runGit(repo, ["rev-parse", "HEAD"]);
    if (head.code !== 0)
      throw new WorkspaceError(`git rev-parse HEAD failed: ${head.stderr.trim()}`);
    return {
      initialized: false,
      baselineCommitted: false,
      gitignoreSeeded: false,
      headSha: head.stdout.trim(),
    };
  }

  let initialized = false;
  const partial = (
    failedStage: GitInitializationProgress["failedStage"],
    baselineCommitted = false,
    headSha: string | null = null,
  ): GitInitializationProgress => ({
    initialized,
    baselineCommitted,
    gitignoreSeeded: false,
    headSha,
    failedStage,
  });
  if (!isRepo) {
    const init = await runGit(repo, ["init"]);
    if (init.code !== 0) {
      // `git init` is not transactional: it can leave config/hooks/refs before
      // rejecting a later step. Disclose possible partial metadata even though
      // initialization did not complete.
      throw new GitInitializationError(`git init failed: ${init.stderr.trim()}`, partial("init"));
    }
    initialized = true;
  }

  const add = await runGit(repo, ["add", "-A"]);
  if (add.code !== 0)
    throw new GitInitializationError(
      `git add failed during repository initialization: ${add.stderr.trim()}`,
      partial("add"),
    );
  const commit = await runGit(repo, [
    "-c",
    "user.name=Claudexor",
    "-c",
    "user.email=noreply@claudexor.local",
    "commit",
    "--allow-empty",
    "--no-verify",
    "-m",
    "claudexor: initialize repository baseline",
  ]);
  if (commit.code !== 0)
    throw new GitInitializationError(
      `baseline commit failed during repository initialization: ${commit.stderr.trim()}`,
      partial("commit"),
    );
  const head = await runGit(repo, ["rev-parse", "HEAD"]);
  if (head.code !== 0) {
    throw new GitInitializationError(
      `git rev-parse HEAD failed after repository initialization: ${head.stderr.trim()}`,
      partial("head", true),
    );
  }
  return {
    initialized,
    baselineCommitted: true,
    gitignoreSeeded: false,
    headSha: head.stdout.trim(),
  };
}

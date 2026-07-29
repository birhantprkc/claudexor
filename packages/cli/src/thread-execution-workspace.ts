import type { ModeKind, Thread } from "@claudexor/schema";
import { runStartRequiresGit, type ControlRunStartRequest } from "@claudexor/schema";
import { ensureThreadWorktree, type ThreadWorktreeResult } from "@claudexor/workspace";

export interface ThreadWorkspaceAuthority {
  getThread(id: string): Thread | undefined;
  setThreadWorktree(id: string, path: string, baseSha: string): void;
}

export interface ThreadExecutionWorkspace {
  executionRoot?: string;
  inPlace: boolean;
  promoted: boolean;
  projectGitInitialization?: ThreadWorktreeResult["projectGitInitialization"];
}

/**
 * Whether the durable thread/project context makes this turn execute through a
 * Git worktree. This is the shared decision used by both preflight and the
 * actual resolver; keeping it pure prevents the admission path from drifting
 * from the workspace path after a new promotion rule is added.
 */
export function threadExecutionRequiresWorktree(input: {
  thread?: Pick<Thread, "workspace">;
  mode: ModeKind;
  protectedPaths: readonly string[];
}): boolean {
  if (!input.thread) return false;
  return (
    input.thread.workspace.mode === "isolated" ||
    (input.thread.workspace.mode === "in_place" &&
      input.mode === "agent" &&
      input.protectedPaths.length > 0)
  );
}

/** Canonical Git admission decision after thread/project context is resolved. */
export function threadRunStartRequiresGit(
  request: ControlRunStartRequest,
  thread: Pick<Thread, "workspace"> | undefined,
  protectedPaths: readonly string[],
): boolean {
  const mode = request.mode ?? "agent";
  return runStartRequiresGit(request, {
    effectiveWorkspaceRequiresGit: threadExecutionRequiresWorktree({
      thread,
      mode,
      protectedPaths,
    }),
  });
}

/** Resolve the effective execution tree before any adapter can start. */
export async function resolveThreadExecutionWorkspace(input: {
  threadId?: string;
  repoRoot: string;
  mode: ModeKind;
  requestedInPlace: boolean;
  protectedPaths: readonly string[];
  threads: ThreadWorkspaceAuthority;
  ensureWorktree?: (repoRoot: string, threadId: string) => Promise<ThreadWorktreeResult>;
}): Promise<ThreadExecutionWorkspace> {
  const thread = input.threadId ? input.threads.getThread(input.threadId) : undefined;
  if (!thread || !input.threadId) {
    return { inPlace: input.requestedInPlace, promoted: false };
  }
  const needsWorktree = threadExecutionRequiresWorktree({
    thread,
    mode: input.mode,
    protectedPaths: input.protectedPaths,
  });
  const promote = thread.workspace.mode === "in_place" && needsWorktree;
  if (!needsWorktree) {
    return { inPlace: input.requestedInPlace, promoted: false };
  }

  const ensure = input.ensureWorktree ?? ensureThreadWorktree;
  const worktree = await ensure(input.repoRoot, input.threadId);
  if (promote || worktree.created) {
    input.threads.setThreadWorktree(input.threadId, worktree.path, worktree.baseSha);
  }
  return {
    executionRoot: worktree.path,
    inPlace: true,
    promoted: promote,
    projectGitInitialization: worktree.projectGitInitialization,
  };
}

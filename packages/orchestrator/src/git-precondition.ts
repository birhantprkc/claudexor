import { join } from "node:path";
import type { ArtifactStore } from "@claudexor/artifact-store";
import type { EventLog } from "@claudexor/event-log";
import { makeOutcomeFacts, type ModeKind, type RunReason } from "@claudexor/schema";
import { noProjectRepoRoot } from "@claudexor/util";
import { ensureGitRepository, GitCapabilityError } from "@claudexor/workspace";
import { writeFailure } from "./runTerminalResults.js";
import { safeErrorMessage } from "./runSupport.js";

export interface GitPreconditionFailure {
  message: string;
  reason: RunReason;
}

const NO_PROJECT_ROOT = noProjectRepoRoot();

/** Establish the write-mode Git boundary and own its typed terminal failure. */
export async function ensureWriteModeGitBoundary(
  repoRoot: string,
  log: EventLog,
  store: ArtifactStore,
  paths: ReturnType<ArtifactStore["runPaths"]>,
  runId: string,
  mode: ModeKind,
): Promise<GitPreconditionFailure | null> {
  if (repoRoot === NO_PROJECT_ROOT) return null;
  try {
    const result = await ensureGitRepository(repoRoot);
    if (result.initialized || result.baselineCommitted) {
      log.emit("project.git.initialized", {
        repo_root: repoRoot,
        initialized: result.initialized,
        baseline_committed: result.baselineCommitted,
        gitignore_seeded: result.gitignoreSeeded,
        head_sha: result.headSha,
      });
    }
    return null;
  } catch (error) {
    const message = safeErrorMessage(error);
    const prerequisite = error instanceof GitCapabilityError;
    const reason: RunReason = prerequisite ? "workspace_unavailable" : "harness_failed";
    writeFailure(store, paths, {
      phase: "workspace",
      category: "project",
      safeMessage: message,
      runDir: paths.root,
      nextActions: prerequisite
        ? [error.capability.remediation ?? "Install Git and retry", "Retry the run"]
        : [
            "Check the project folder permissions",
            "Initialize git manually (git init)",
            "Retry the run",
          ],
    });
    store.writeText(
      join(paths.finalDir, "summary.md"),
      `# Run ${runId} (${mode})\n\n- Lifecycle: failed\n- Phase: workspace\n\n${message}\n`,
    );
    log.emit("output.ready", { kind: "summary", path: "final/summary.md", state: "diagnostic" });
    log.emit("run.failed", {
      lifecycle: "failed",
      facts: makeOutcomeFacts("failed", { reason }),
      reason,
      phase: "workspace",
      error: message,
      failure_ref: "final/failure.yaml",
    });
    return { message, reason };
  }
}

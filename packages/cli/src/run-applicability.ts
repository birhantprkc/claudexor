import { loadConfig } from "@claudexor/config";
import { normalizeExistingProjectRoot } from "@claudexor/control-api";
import {
  ControlRunApplicabilityResponse,
  ThreadWorkspace,
  type ControlRunStartRequest,
  type GitCapability,
  type RunGitApplicabilityCell,
  type RunGitApplicabilityMatrix,
  type WorkspaceMode,
} from "@claudexor/schema";
import { gitCapabilityProblem, probeGitCapability } from "@claudexor/workspace";
import { threadRunStartRequiresGit } from "./thread-execution-workspace.js";

type RunShape = "read_only" | "agent_convergence" | "agent_other";

export interface RunApplicabilityDependencies {
  gitCapability?: () => Promise<GitCapability>;
  protectedPaths?: (repoRoot: string) => readonly string[];
}

function requestFor(repoRoot: string, shape: RunShape): ControlRunStartRequest {
  const base = {
    prompt: "run applicability projection",
    scope: { kind: "project" as const, root: repoRoot, context: "auto" as const },
    execution: { isolation: shape === "read_only" ? ("envelope" as const) : ("live" as const) },
  };
  if (shape === "read_only") return { ...base, mode: "ask" };
  if (shape === "agent_convergence") return { ...base, mode: "agent", untilClean: true };
  return { ...base, mode: "agent" };
}

function cell(requiresGit: boolean, git: GitCapability): RunGitApplicabilityCell {
  const blocker = gitCapabilityProblem(git);
  if (!requiresGit || blocker === null) {
    return {
      applicable: true,
      requiresGit,
      code: null,
      reason: null,
      remediation: null,
    };
  }
  return {
    applicable: false,
    requiresGit: true,
    ...blocker,
  };
}

/**
 * Project one complete matrix through the same predicate the actual thread
 * resolver and run preflight use. Clients only select a cell from their exact
 * outgoing wire; they never reproduce Git/worktree business rules.
 */
export function buildRunApplicabilityMatrix(input: {
  repoRoot: string;
  protectedPaths: readonly string[];
  git: GitCapability;
}): RunGitApplicabilityMatrix {
  const workspace = (mode: WorkspaceMode) => ({
    workspace: ThreadWorkspace.parse({ mode }),
  });
  const project = (mode: WorkspaceMode) => {
    const thread = workspace(mode);
    const projectCell = (shape: RunShape) =>
      cell(
        threadRunStartRequiresGit(requestFor(input.repoRoot, shape), thread, input.protectedPaths),
        input.git,
      );
    return {
      read_only: projectCell("read_only"),
      agent_convergence: projectCell("agent_convergence"),
      agent_other: projectCell("agent_other"),
    };
  };
  return {
    in_place: project("in_place"),
    isolated: project("isolated"),
  };
}

/** Root-scoped service behind GET /run-applicability. */
export async function projectRunApplicability(
  requestedRoot: string,
  dependencies: RunApplicabilityDependencies = {},
) {
  const repoRoot = normalizeExistingProjectRoot(requestedRoot);
  const [git, protectedPaths] = await Promise.all([
    (dependencies.gitCapability ?? probeGitCapability)(),
    Promise.resolve(
      dependencies.protectedPaths?.(repoRoot) ??
        loadConfig(repoRoot).project.constraints.protected_paths,
    ),
  ]);
  return ControlRunApplicabilityResponse.parse({
    repoRoot,
    git,
    matrix: buildRunApplicabilityMatrix({ repoRoot, protectedPaths, git }),
  });
}

import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { GitCommandResult } from "./git-initialization.js";
import { ensureGitRepository, GitBoundaryRootRefusedError, GitInitializationError } from "./git.js";

const availableGit = async () => ({
  status: "available" as const,
  version: "git version test",
  detail: null,
  remediation: null,
});

describe("Git initialization progress", () => {
  it.each(["init", "add", "commit"] as const)(
    "discloses a partial repository mutation when %s fails",
    async (failedStage) => {
      const calls: string[][] = [];
      const runGit = async (_repo: string, args: string[]) => {
        calls.push(args);
        if (args[0] === "rev-parse") {
          return { code: 1, stdout: "", stderr: "not a repository" };
        }
        if (args[0] === "init") {
          return failedStage === "init"
            ? { code: 128, stdout: "", stderr: "invalid initial branch name" }
            : { code: 0, stdout: "initialized", stderr: "" };
        }
        if (args[0] === "add") {
          return failedStage === "add"
            ? { code: 1, stdout: "", stderr: "permission denied" }
            : { code: 0, stdout: "", stderr: "" };
        }
        return { code: 1, stdout: "", stderr: "commit refused" };
      };

      await expect(
        ensureGitRepository("/project", { probeCapability: availableGit, runGit }),
      ).rejects.toMatchObject({
        name: "GitInitializationError",
        progress: {
          initialized: failedStage !== "init",
          baselineCommitted: false,
          failedStage,
        },
      });
      expect(calls.some((args) => args[0] === "init")).toBe(true);
    },
  );

  it("uses a typed error class for partial-mutation consumers", () => {
    const error = new GitInitializationError("failed", {
      initialized: true,
      baselineCommitted: false,
      gitignoreSeeded: false,
      headSha: null,
      failedStage: "add",
    });
    expect(error).toBeInstanceOf(Error);
  });
});

describe("Git boundary root guard (INV-075 refusal exception)", () => {
  const tempDirs: string[] = [];
  afterAll(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** Record every git call; answer "not a repository" to the probes and
   * succeed everything else, so a refusal is provable as PRE-mutation. */
  const recordingGit = (calls: string[][], unbornHead = false) => {
    return async (_repo: string, args: string[]): Promise<GitCommandResult> => {
      calls.push(args);
      if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
        return unbornHead
          ? { code: 0, stdout: "true", stderr: "" }
          : { code: 1, stdout: "", stderr: "not a repository" };
      }
      if (args[0] === "rev-parse" && args[1] === "--verify") {
        return { code: 1, stdout: "", stderr: "no HEAD" };
      }
      if (args[0] === "rev-parse" && args[1] === "HEAD") {
        return { code: 0, stdout: "abc123\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
  };
  const mutations = (calls: string[][]) => calls.filter((args) => args[0] !== "rev-parse");

  it.each([false, true])(
    "refuses the user home directory before any mutation (unborn HEAD: %s)",
    async (unbornHead) => {
      const calls: string[][] = [];
      const error: unknown = await ensureGitRepository("/home/tester", {
        probeCapability: availableGit,
        runGit: recordingGit(calls, unbornHead),
        rootPolicy: { userHomeDir: () => "/home/tester", canonicalize: (path) => path },
      }).catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(GitBoundaryRootRefusedError);
      const refusal = error as GitBoundaryRootRefusedError;
      expect(refusal.code).toBe("git_boundary_root_refused");
      expect(refusal.status).toBe(400);
      expect(refusal.retryable).toBe(true);
      expect(refusal.context).toEqual({ root: "/home/tester", cause: "user_home" });
      expect(refusal.message).toContain("user home directory");
      // Both honest remediations: a subfolder, or a SELF-init with a first
      // commit (a bare `git init` would still be refused on the unborn-HEAD
      // path, so the text must never recommend it alone).
      expect(refusal.requiredActions.join("\n")).toContain("subfolder");
      expect(refusal.requiredActions.join("\n")).toContain("`git init`");
      expect(refusal.requiredActions.join("\n")).toContain("first commit");
      // The refusal happened BEFORE any mutation: probes only, no init/add/commit.
      expect(mutations(calls)).toEqual([]);
    },
  );

  it("refuses a filesystem root before any mutation", async () => {
    const calls: string[][] = [];
    const error: unknown = await ensureGitRepository("/", {
      probeCapability: availableGit,
      runGit: recordingGit(calls),
      rootPolicy: { userHomeDir: () => "/home/tester", canonicalize: (path) => path },
    }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(GitBoundaryRootRefusedError);
    const refusal = error as GitBoundaryRootRefusedError;
    expect(refusal.context).toEqual({ root: "/", cause: "filesystem_root" });
    expect(refusal.message).toContain("filesystem root");
    expect(mutations(calls)).toEqual([]);
  });

  it("fails CLOSED when no safe home resolves, naming that cause distinctly", async () => {
    const calls: string[][] = [];
    const error: unknown = await ensureGitRepository("/some/project", {
      probeCapability: availableGit,
      runGit: recordingGit(calls),
      rootPolicy: {
        userHomeDir: () => {
          throw new Error("Unable to resolve a safe user home directory");
        },
        canonicalize: (path) => path,
      },
    }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(GitBoundaryRootRefusedError);
    const refusal = error as GitBoundaryRootRefusedError;
    expect(refusal.context).toEqual({ root: "/some/project", cause: "unresolvable_home" });
    expect(refusal.message).toContain("could not be resolved");
    expect(refusal.requiredActions.join("\n")).toContain("HOME");
    expect(mutations(calls)).toEqual([]);
  });

  it("leaves a home directory that IS a healthy repository untouched (dotfiles users)", async () => {
    const calls: string[][] = [];
    const runGit = async (_repo: string, args: string[]): Promise<GitCommandResult> => {
      calls.push(args);
      if (args[1] === "--is-inside-work-tree") return { code: 0, stdout: "true\n", stderr: "" };
      if (args[1] === "--verify") return { code: 0, stdout: "abc123\n", stderr: "" };
      return { code: 0, stdout: "abc123\n", stderr: "" };
    };
    const result = await ensureGitRepository("/home/tester", {
      probeCapability: availableGit,
      runGit,
      rootPolicy: { userHomeDir: () => "/home/tester", canonicalize: (path) => path },
    });
    expect(result).toEqual({
      initialized: false,
      baselineCommitted: false,
      gitignoreSeeded: false,
      headSha: "abc123",
    });
    expect(mutations(calls)).toEqual([]);
  });

  it("refuses a symlinked spelling of the home directory (realpath on both sides)", async () => {
    const base = mkdtempSync(join(tmpdir(), "claudexor-boundary-home-"));
    tempDirs.push(base);
    const realHome = join(base, "real-home");
    mkdirSync(realHome);
    const linkedHome = join(base, "home-link");
    symlinkSync(realHome, linkedHome);
    const calls: string[][] = [];
    // Root spelled through the symlink, home reported as the real path; the
    // DEFAULT canonicalizer (realpath) must unify the two spellings.
    const error: unknown = await ensureGitRepository(linkedHome, {
      probeCapability: availableGit,
      runGit: recordingGit(calls),
      rootPolicy: { userHomeDir: () => realHome },
    }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(GitBoundaryRootRefusedError);
    expect((error as GitBoundaryRootRefusedError).context.cause).toBe("user_home");
    expect(mutations(calls)).toEqual([]);
  });

  it("still auto-initializes an ordinary non-git folder (guard passes)", async () => {
    const calls: string[][] = [];
    const result = await ensureGitRepository("/home/tester/project", {
      probeCapability: availableGit,
      runGit: recordingGit(calls),
      rootPolicy: { userHomeDir: () => "/home/tester", canonicalize: (path) => path },
    });
    expect(result).toEqual({
      initialized: true,
      baselineCommitted: true,
      gitignoreSeeded: false,
      headSha: "abc123",
    });
    expect(calls.some((args) => args[0] === "init")).toBe(true);
    expect(calls.some((args) => args[0] === "add")).toBe(true);
  });

  it("still gives an ordinary unborn-HEAD repository its baseline commit", async () => {
    const calls: string[][] = [];
    const result = await ensureGitRepository("/home/tester/project", {
      probeCapability: availableGit,
      runGit: recordingGit(calls, true),
      rootPolicy: { userHomeDir: () => "/home/tester", canonicalize: (path) => path },
    });
    expect(result).toEqual({
      initialized: false,
      baselineCommitted: true,
      gitignoreSeeded: false,
      headSha: "abc123",
    });
    expect(calls.some((args) => args[0] === "init")).toBe(false);
    expect(calls.some((args) => args[0] === "add")).toBe(true);
  });
});

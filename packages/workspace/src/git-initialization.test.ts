import { describe, expect, it } from "vitest";
import { ensureGitRepository, GitInitializationError } from "./git.js";

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

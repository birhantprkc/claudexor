import { describe, expect, it, vi } from "vitest";
import type { WorkspaceEnvelope } from "@claudexor/schema";
import type { WorkspaceManager } from "@claudexor/workspace";

vi.mock("@claudexor/workspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@claudexor/workspace")>();
  return {
    ...actual,
    revertWorkingTreePatch: async () => {
      throw new Error("sensitive rollback sentinel");
    },
  };
});

import { quarantineCandidateWorkspace, quarantineSecretDiff } from "./secretDiff.js";

const envelope = {
  repo_root: "/tmp/project",
  worktree_path: "/tmp/project",
  base_sha: null,
} as WorkspaceEnvelope;

describe("secret diff quarantine failure receipts", () => {
  it.each([
    { inPlace: true, disposition: "manual_cleanup" },
    { inPlace: false, disposition: "discarded" },
  ] as const)(
    "sanitizes a capture exception for inPlace=$inPlace",
    async ({ inPlace, disposition }) => {
      const wsm = {
        captureDiff: async () => {
          throw new Error("sensitive capture sentinel");
        },
      } as unknown as WorkspaceManager;

      const result = await quarantineCandidateWorkspace(wsm, envelope, inPlace);

      expect(result.diff).toBe("");
      expect(result.refusal?.disposition).toBe(disposition);
      expect(result.refusal?.detail).not.toContain("sensitive capture sentinel");
      expect(result.refusal?.detail).toMatch(inPlace ? /manual cleanup required/ : /discarded/);
    },
  );

  it("turns a rollback exception into a sanitized manual-cleanup receipt", async () => {
    const secret = `sk-${"r".repeat(24)}`;

    const result = await quarantineSecretDiff({
      diff: `diff --git a/LEAK.txt b/LEAK.txt\n+${secret}\n`,
      inPlace: true,
      repo: "/definitely/missing/claudexor-secret-rollback",
      binarySecretLike: false,
      gitBacked: false,
    });

    expect(result.diff).toBe("");
    expect(result.refusal).toMatchObject({ disposition: "manual_cleanup" });
    expect(result.refusal?.detail).toMatch(/could not be rolled back/);
    expect(result.refusal?.detail).not.toContain(secret);
  });
});

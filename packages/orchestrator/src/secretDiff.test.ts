import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkspaceEnvelope } from "@claudexor/schema";
import type { WorkspaceManager } from "@claudexor/workspace";

import { quarantineCandidateWorkspace, quarantineSecretDiff } from "./secretDiff.js";

const envelope = {
  repo_root: "/tmp/project",
  worktree_path: "/tmp/project",
  base_sha: null,
} as WorkspaceEnvelope;

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

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

  it("requires manual cleanup when isolated capture scratch cleanup is unproven", async () => {
    const error = Object.assign(new Error("sensitive primary capture error"), {
      cleanupError: new Error("sensitive cleanup error"),
    });
    const wsm = {
      captureDiff: async () => {
        throw error;
      },
    } as unknown as WorkspaceManager;

    const result = await quarantineCandidateWorkspace(wsm, envelope, false);

    expect(result.refusal).toMatchObject({ disposition: "manual_cleanup" });
    expect(result.refusal?.detail).toMatch(/private scratch cleanup could not be proven/);
    expect(result.refusal?.detail).not.toContain("sensitive");
  });

  it("turns a rollback exception into a sanitized manual-cleanup receipt", async () => {
    const secret = `sk-${"r".repeat(24)}`;

    const result = await quarantineSecretDiff({
      diff: `diff --git a/LEAK.txt b/LEAK.txt\n+${secret}\n`,
      inPlace: true,
      repo: "/definitely/missing/claudexor-secret-rollback",
      binarySecretLike: false,
      gitBacked: true,
    });

    expect(result.diff).toBe("");
    expect(result.refusal).toMatchObject({ disposition: "manual_cleanup" });
    expect(result.refusal?.detail).toMatch(/could not be rolled back/);
    expect(result.refusal?.detail).not.toContain(secret);
  });

  it("requires manual cleanup when unsafe linked media lies outside the reversible patch", async () => {
    const repo = mkdtempSync(join(tmpdir(), "claudexor-secret-outside-patch-"));
    roots.push(repo);
    writeFileSync(join(repo, "preview.png"), Buffer.alloc(16 * 1024 * 1024 + 1));
    writeFileSync(join(repo, "SAFE.txt"), "safe\n");
    const patch =
      "diff --git a/SAFE.txt b/SAFE.txt\n" +
      "new file mode 100644\n" +
      "--- /dev/null\n" +
      "+++ b/SAFE.txt\n" +
      "@@ -0,0 +1 @@\n" +
      "+safe\n";
    const wsm = {
      captureDiff: async () => ({ diff: patch, binarySecretLike: false }),
    } as unknown as WorkspaceManager;

    const result = await quarantineCandidateWorkspace(
      wsm,
      { ...envelope, repo_root: repo, worktree_path: repo },
      true,
      "![preview](preview.png)",
    );

    expect(existsSync(join(repo, "SAFE.txt"))).toBe(false);
    expect(existsSync(join(repo, "preview.png"))).toBe(true);
    expect(result.diff).toBe("");
    expect(result.refusal).toMatchObject({ disposition: "manual_cleanup" });
    expect(result.refusal?.detail).toMatch(/media outside that patch could not be proven removed/);
    expect(result.refusal?.detail).not.toContain("changed before rollback");
  });

  it("does not treat bytes reached through a reversible symlink as reverted", async () => {
    const root = mkdtempSync(join(tmpdir(), "claudexor-secret-symlink-target-"));
    roots.push(root);
    const repo = join(root, "repo");
    const outside = join(root, "outside");
    const target = join(outside, "leak.png");
    const link = join(repo, "preview.png");
    mkdirSync(repo, { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(target, link);
    writeFileSync(link, Buffer.alloc(16 * 1024 * 1024 + 1));
    const patch =
      "diff --git a/preview.png b/preview.png\n" +
      "new file mode 120000\n" +
      "--- /dev/null\n" +
      "+++ b/preview.png\n" +
      "@@ -0,0 +1 @@\n" +
      `+${target}\n` +
      "\\ No newline at end of file\n";
    const wsm = {
      captureDiff: async () => ({ diff: patch, binarySecretLike: false }),
    } as unknown as WorkspaceManager;

    const result = await quarantineCandidateWorkspace(
      wsm,
      { ...envelope, repo_root: repo, worktree_path: repo },
      true,
      "![preview](preview.png)",
    );

    expect(existsSync(link)).toBe(false);
    expect(existsSync(target)).toBe(true);
    expect(result.diff).toBe("");
    expect(result.refusal).toMatchObject({ disposition: "manual_cleanup" });
    expect(result.refusal?.detail).toMatch(/media outside that patch could not be proven removed/);
  });
});

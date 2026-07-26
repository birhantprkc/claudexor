import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectPartitions } from "@claudexor/daemon";
import { applyThreadDiff } from "./thread-delivery.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function objectStoreContains(repo: string, needle: string): boolean {
  const rows = execFileSync(
    "git",
    ["-C", repo, "cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype)"],
    { encoding: "utf8" },
  );
  return rows
    .trim()
    .split("\n")
    .some((row) => {
      const [sha, type] = row.split(" ");
      return (
        type === "blob" &&
        !!sha &&
        execFileSync("git", ["-C", repo, "cat-file", "blob", sha]).includes(needle)
      );
    });
}

describe("thread delivery secret fence", () => {
  it.each(["text", "binary"] as const)(
    "refuses a %s secret patch without writing the candidate blob",
    async (kind) => {
      const repo = mkdtempSync(join(tmpdir(), "claudexor-thread-delivery-"));
      dirs.push(repo);
      execFileSync("git", ["-C", repo, "init", "-b", "main"]);
      writeFileSync(join(repo, "README.md"), "# test\n");
      execFileSync("git", ["-C", repo, "add", "-A"]);
      execFileSync("git", [
        "-C",
        repo,
        "-c",
        "user.email=t@t.dev",
        "-c",
        "user.name=Test",
        "commit",
        "-m",
        "init",
      ]);
      const base = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();
      const secret = `sk-${"f".repeat(24)}`;
      writeFileSync(
        join(repo, kind === "text" ? "LEAK.txt" : "LEAK.bin"),
        kind === "text"
          ? `${secret}\n`
          : Buffer.concat([Buffer.from([0]), Buffer.from(secret), Buffer.from([0])]),
      );
      const thread = {
        workspace: { mode: "isolated", worktree_path: repo, base_sha: base },
        repo: { root: repo },
      };
      const threads = { getThread: () => thread } as unknown as ProjectPartitions;

      const result = await applyThreadDiff(threads, "thread-1", { mode: "apply" });

      expect(result).toMatchObject({ applied: false, status: "rejected", headMoved: false });
      expect(objectStoreContains(repo, secret)).toBe(false);
    },
  );
});

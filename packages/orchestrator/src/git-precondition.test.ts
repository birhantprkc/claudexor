import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "@claudexor/artifact-store";
import { EventLog } from "@claudexor/event-log";
import { GitInitializationError } from "@claudexor/workspace";
import { afterEach, describe, expect, it } from "vitest";
import { ensureWriteModeGitBoundary } from "./git-precondition.js";

describe("write-mode Git precondition", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("classifies a repository initialization failure as workspace unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "claudexor-git-precondition-"));
    roots.push(root);
    const store = new ArtifactStore(root, { claudexorDir: join(root, "runtime") });
    const paths = store.createRun("run-git-precondition");
    const log = new EventLog(paths.eventsPath, "run-git-precondition", "task-git-precondition");

    try {
      const failure = await ensureWriteModeGitBoundary(
        root,
        log,
        store,
        paths,
        "run-git-precondition",
        "agent",
        async () => {
          throw new Error("git init failed: permission denied");
        },
      );

      expect(failure).toEqual({
        message: "git init failed: permission denied",
        reason: "workspace_unavailable",
      });
      expect(readFileSync(join(paths.finalDir, "failure.yaml"), "utf8")).toContain(
        "phase: workspace",
      );
      const terminal = JSON.parse(
        readFileSync(paths.eventsPath, "utf8").trim().split("\n").at(-1)!,
      ) as {
        type: string;
        payload: { reason?: string };
      };
      expect(terminal.type).toBe("run.failed");
      expect(terminal.payload.reason).toBe("workspace_unavailable");
    } finally {
      log.dispose();
    }
  });

  it("emits partial Git initialization evidence before the workspace failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "claudexor-git-precondition-"));
    roots.push(root);
    const store = new ArtifactStore(root, { claudexorDir: join(root, "runtime") });
    const paths = store.createRun("run-partial-init");
    const log = new EventLog(paths.eventsPath, "run-partial-init", "task-partial-init");

    try {
      await ensureWriteModeGitBoundary(
        root,
        log,
        store,
        paths,
        "run-partial-init",
        "agent",
        async () => {
          throw new GitInitializationError("git add failed", {
            initialized: true,
            baselineCommitted: false,
            gitignoreSeeded: false,
            headSha: null,
            failedStage: "add",
          });
        },
      );
      const events = readFileSync(paths.eventsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> });
      expect(events[0]).toMatchObject({
        type: "project.git.initialized",
        payload: { initialized: true, partial: true, failed_stage: "add" },
      });
      expect(events.at(-1)?.type).toBe("run.failed");
    } finally {
      log.dispose();
    }
  });
});

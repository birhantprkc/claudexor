/**
 * Thread listing that is RESILIENT to a dead project (F2): a registered
 * project whose filesystem root has vanished (e.g. a swept ghost envelope
 * worktree) is SKIPPED with a disclosed per-project problem instead of
 * failing the whole listing, while every other project's threads load. Each
 * store sorts ITS threads by recency, but the stores concatenate — without a
 * merge-sort a fresh project thread lands below every global one (dogfood:
 * the fresh thread sank to the bottom). One global recency order.
 */
import { existsSync } from "node:fs";
import type { ControlProjectListingProblem, Thread } from "@claudexor/schema";
import type { JournalProjectionSlot } from "./journal-manager.js";
import type { ProjectPartitionCollection } from "./project-partition-preparation.js";
import type { ProjectStore } from "./projects.js";
import type { ThreadStore } from "./threads.js";

export function listProjectThreadsResilient(input: {
  partitions: ProjectPartitionCollection;
  projects: JournalProjectionSlot<ProjectStore>;
  globalThreads: JournalProjectionSlot<ThreadStore>;
}): { threads: Thread[]; problems: ControlProjectListingProblem[] } {
  input.partitions.sync();
  const registry = input.projects.current();
  const threads: Thread[] = [...input.globalThreads.current().listThreads()];
  const problems: ControlProjectListingProblem[] = [];
  for (const [id, entry] of input.partitions) {
    if (!entry.manager.ready()) continue;
    const root = registry.get(id)?.root;
    if (!root) continue;
    if (!existsSync(root)) {
      problems.push({
        projectId: id,
        root,
        code: "project_root_missing",
        message: `project root no longer exists: ${root}`,
      });
      continue;
    }
    for (const thread of entry.threads.current().listThreads()) threads.push(thread);
  }
  threads.sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));
  return { threads, problems };
}

import type { ControlProjectRemoveReceipt } from "@claudexor/schema";
import type { ProjectPartitionCollection } from "./project-partition-preparation.js";
import type { ProjectStore } from "./projects.js";

/**
 * QA-049 minimal project remove (extracted from project-partitions.ts,
 * INV-124): retire the durable registry entry and archive the journal
 * partition, fenced against non-purged threads and live/queued runs. The
 * caller has already synced the partition collection.
 */
export function removeProjectFromPartitions(
  registry: ProjectStore,
  partitions: ProjectPartitionCollection,
  id: string,
  activeRunRoots: ReadonlySet<string>,
): ControlProjectRemoveReceipt {
  const project = registry.get(id);
  if (!project) {
    throw Object.assign(new Error(`no such project: ${id}`), {
      code: "project_not_found",
      status: 404,
    });
  }
  const entry = partitions.get(id);
  if (entry) {
    if (!entry.manager.ready()) {
      throw Object.assign(
        new Error(`project ${id} partition requires journal recovery before it can be removed`),
        { code: "journal_recovery_required", status: 409 },
      );
    }
    const blocking = entry.threads
      .current()
      .listThreads()
      .filter((thread) => thread.state !== "purged");
    if (blocking.length > 0) {
      throw Object.assign(
        new Error(
          `project ${id} still has ${blocking.length} thread(s); trash and purge them before removing it`,
        ),
        { code: "project_has_threads", status: 409 },
      );
    }
  }
  if (activeRunRoots.has(project.root)) {
    throw Object.assign(
      new Error(`project ${id} has a live or queued run; wait for it to finish before removing it`),
      { code: "project_has_active_run", status: 409 },
    );
  }
  const archivedPartitionPath = entry ? entry.manager.archivePartition() : null;
  try {
    registry.unregister(id);
  } catch (unregisterError) {
    // Archive succeeded but the durable registry rejected the unregister: the
    // project is now archived-but-registered. Roll the archive back into the
    // active tree so the two views stay consistent, then surface the original
    // unregister failure. If the rollback ITSELF fails we cannot restore
    // consistency — disclose the partial state honestly with a typed error
    // rather than pretend the remove succeeded (Ф2 finding 4).
    if (entry && archivedPartitionPath) {
      try {
        entry.manager.restoreArchivedPartition(archivedPartitionPath);
      } catch (rollbackError) {
        throw Object.assign(
          new Error(
            `project ${id} could not be removed: its journal partition was archived to ${archivedPartitionPath}, the registry unregister failed, and the archive could not be rolled back (${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}); the project is archived-but-registered and needs manual reconciliation`,
          ),
          { code: "project_remove_partial", status: 500, archivedPartitionPath },
        );
      }
    }
    throw unregisterError;
  }
  partitions.delete(id);
  return {
    projectId: project.id,
    root: project.root,
    registryRemoved: true,
    journalPartitionArchived: archivedPartitionPath !== null,
    archivedPartitionPath,
    artifactsRetained: true,
    // W2: `activeRunRoots` was snapshotted by the caller via an async daemon
    // IPC job-list read BEFORE this synchronous removal. A run that starts in
    // the window between that snapshot and this point is not fenced — disclose
    // it honestly rather than implying an atomic guarantee we cannot make.
    activeRunCheck: "snapshot",
  };
}

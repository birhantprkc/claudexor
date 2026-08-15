import { createHash } from "node:crypto";
import { JournalRecoveryRequiredError } from "@claudexor/journal";
import { commandProjection, type CommandStore } from "./command-store.js";
import { interactionProjection, type InteractionStore } from "./interactions.js";
import { JournalManager, type JournalProjectionSlot } from "./journal-manager.js";
import { recoveryFrom } from "./journal-recovery-files.js";
import { operatorDecisionProjection, type OperatorDecisionStore } from "./operator-decisions.js";
import type { ProjectStore } from "./projects.js";
import { runEventProjection, type RunEventStore } from "./run-events.js";
import { threadProjection, type ThreadHeadPingSink, type ThreadStore } from "./threads.js";

export interface ProjectPartitionEntry {
  manager: JournalManager;
  commands: JournalProjectionSlot<CommandStore>;
  interactions: JournalProjectionSlot<InteractionStore>;
  decisions: JournalProjectionSlot<OperatorDecisionStore>;
  runEvents: JournalProjectionSlot<RunEventStore>;
  threads: JournalProjectionSlot<ThreadStore>;
}

export interface ProjectPartitionPreparationEntry {
  projectId: string;
  partition: string;
  status: "ready" | "recovery_required";
  virtual: boolean;
  fingerprint: string;
  manager: JournalManager;
}

export interface ProjectPartitionsPreparation {
  coverage: "complete" | "global_registry_unavailable";
  fingerprint: string | null;
  registeredProjectIds: string[];
  trustedProjectRoots: string[];
  partitions: ProjectPartitionPreparationEntry[];
  readyPartitions: string[];
  recoveryRequiredPartitions: string[];
}

export interface PreparedProjectPartitions {
  receipt: ProjectPartitionsPreparation;
  entries: Map<string, ProjectPartitionEntry>;
}

export class ProjectPartitionCollection extends Map<string, ProjectPartitionEntry> {
  constructor(
    private readonly rootDir: string,
    private readonly projects: JournalProjectionSlot<ProjectStore>,
    private readonly headPing?: ThreadHeadPingSink,
  ) {
    super();
  }

  sync(): void {
    const ids = new Set(
      this.projects
        .current()
        .list()
        .map((project) => project.id),
    );
    for (const id of ids) this.ensure(id);
    for (const [id, entry] of this) {
      if (ids.has(id)) continue;
      entry.manager.close();
      this.delete(id);
    }
  }

  ensure(projectId: string): ProjectPartitionEntry {
    const existing = this.get(projectId);
    if (existing) return existing;
    const entry = createProjectPartition(this.rootDir, `project:${projectId}`, this.headPing);
    entry.manager.start();
    this.set(projectId, entry);
    return entry;
  }

  healthy(): ProjectPartitionEntry[] {
    this.sync();
    return [...this.values()].filter((entry) => entry.manager.ready());
  }

  healthyRoots(): string[] {
    this.sync();
    const registry = this.projects.current();
    const roots: string[] = [];
    for (const [id, entry] of this) {
      if (!entry.manager.ready()) continue;
      const root = registry.get(id)?.root;
      if (root) roots.push(root);
    }
    return roots;
  }
}

export function prepareProjectPartitions(input: {
  rootDir: string;
  projects: JournalProjectionSlot<ProjectStore>;
  headPing?: ThreadHeadPingSink;
}): PreparedProjectPartitions {
  let projects: ReturnType<ProjectStore["list"]>;
  try {
    const registry = input.projects.prepared();
    registry.validateProjection();
    projects = registry.list();
  } catch {
    return {
      receipt: {
        coverage: "global_registry_unavailable",
        fingerprint: null,
        registeredProjectIds: [],
        trustedProjectRoots: [],
        partitions: [],
        readyPartitions: [],
        recoveryRequiredPartitions: [],
      },
      entries: new Map(),
    };
  }

  const entries = new Map<string, ProjectPartitionEntry>();
  const partitions: ProjectPartitionPreparationEntry[] = [];
  for (const project of projects) {
    const partition = `project:${project.id}`;
    const value = createProjectPartition(input.rootDir, partition, input.headPing);
    const preparation = value.manager.prepare();
    entries.set(project.id, value);
    partitions.push({
      projectId: project.id,
      partition,
      status: preparation.inspection.status,
      virtual: preparation.virtual,
      fingerprint: preparation.preparationFingerprint,
      manager: value.manager,
    });
  }
  const readyPartitions = partitions
    .filter((entry) => entry.status === "ready")
    .map((entry) => entry.partition);
  const recoveryRequiredPartitions = partitions
    .filter((entry) => entry.status === "recovery_required")
    .map((entry) => entry.partition);
  const registeredProjectIds = projects.map((project) => project.id);
  const trustedProjectRoots = projects.map((project) => project.root);
  return {
    receipt: {
      coverage: "complete",
      fingerprint: preparationFingerprint(registeredProjectIds, trustedProjectRoots, partitions),
      registeredProjectIds,
      trustedProjectRoots,
      partitions,
      readyPartitions,
      recoveryRequiredPartitions,
    },
    entries,
  };
}

/**
 * Live re-verdict for the in-process reopen (C6): recompute the stage-2
 * receipt from CURRENT partition state. A partition the operator quarantined
 * over the recovery route was reopened by its manager (openGeneration) and
 * now inspects ready; a registry that became readable after a global reopen
 * restores coverage. Read-only for everything still prepared — a registered
 * project without an entry gets a read-only prepare, never a write.
 */
export function refreshProjectPartitionsPreparation(input: {
  rootDir: string;
  projects: JournalProjectionSlot<ProjectStore>;
  headPing?: ThreadHeadPingSink;
  previous: ProjectPartitionsPreparation;
  entries: ProjectPartitionCollection;
}): ProjectPartitionsPreparation {
  let projects: ReturnType<ProjectStore["list"]>;
  try {
    const registry = input.projects.prepared();
    registry.validateProjection();
    projects = registry.list();
  } catch {
    return {
      coverage: "global_registry_unavailable",
      fingerprint: null,
      registeredProjectIds: [],
      trustedProjectRoots: [],
      partitions: [],
      readyPartitions: [],
      recoveryRequiredPartitions: [],
    };
  }
  const previousByPartition = new Map(
    input.previous.partitions.map((entry) => [entry.partition, entry]),
  );
  const partitions: ProjectPartitionPreparationEntry[] = [];
  for (const project of projects) {
    const partition = `project:${project.id}`;
    let entry = input.entries.get(project.id);
    if (!entry) {
      entry = createProjectPartition(input.rootDir, partition, input.headPing);
      entry.manager.prepare();
      input.entries.set(project.id, entry);
    }
    const inspection = entry.manager.inspect();
    partitions.push({
      projectId: project.id,
      partition,
      status: inspection.status === "ready" ? "ready" : "recovery_required",
      virtual: previousByPartition.get(partition)?.virtual ?? false,
      fingerprint: inspection.fingerprint,
      manager: entry.manager,
    });
  }
  const registeredProjectIds = projects.map((project) => project.id);
  const trustedProjectRoots = projects.map((project) => project.root);
  return {
    coverage: "complete",
    fingerprint: preparationFingerprint(registeredProjectIds, trustedProjectRoots, partitions),
    registeredProjectIds,
    trustedProjectRoots,
    partitions,
    readyPartitions: partitions
      .filter((entry) => entry.status === "ready")
      .map((entry) => entry.partition),
    recoveryRequiredPartitions: partitions
      .filter((entry) => entry.status === "recovery_required")
      .map((entry) => entry.partition),
  };
}

export function activatePreparedProjectPartitions(input: {
  rootDir: string;
  projects: JournalProjectionSlot<ProjectStore>;
  headPing?: ThreadHeadPingSink;
  receipt: ProjectPartitionsPreparation;
  entries: ProjectPartitionCollection;
  resetReceipt(receipt: ProjectPartitionsPreparation): void;
}): void {
  if (
    input.receipt.coverage !== "complete" ||
    input.receipt.recoveryRequiredPartitions.length > 0
  ) {
    throw new Error("project partitions require recovery before activation");
  }
  try {
    for (const entry of input.entries.values()) {
      // Reopened-after-quarantine managers are live (C6); skip revalidation.
      if (!entry.manager.ready()) entry.manager.revalidatePreparation();
    }
    for (const entry of input.entries.values()) entry.manager.activatePrepared();
  } catch (error) {
    const recovery = recoveryFrom(error, "project partition activation failed");
    for (const entry of input.entries.values()) entry.manager.close();
    input.entries.clear();
    const rebuilt = prepareProjectPartitions(input);
    for (const [id, entry] of rebuilt.entries) input.entries.set(id, entry);
    input.resetReceipt(rebuilt.receipt);
    throw new JournalRecoveryRequiredError(recovery);
  }
}

function createProjectPartition(
  rootDir: string,
  partition: string,
  headPing?: ThreadHeadPingSink,
): ProjectPartitionEntry {
  const manager = new JournalManager(rootDir, { partition });
  const value: ProjectPartitionEntry = {
    manager,
    commands: manager.registerProjection(commandProjection()),
    interactions: manager.registerProjection(interactionProjection()),
    decisions: manager.registerProjection(operatorDecisionProjection()),
    runEvents: manager.registerProjection(runEventProjection()),
    threads: manager.registerProjection(threadProjection(headPing)),
  };
  return value;
}

function preparationFingerprint(
  projectIds: string[],
  projectRoots: string[],
  partitions: ProjectPartitionPreparationEntry[],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        projectIds,
        projectRoots,
        partitions: partitions.map((entry) => ({
          partition: entry.partition,
          status: entry.status,
          virtual: entry.virtual,
          fingerprint: entry.fingerprint,
        })),
      }),
    )
    .digest("hex");
}

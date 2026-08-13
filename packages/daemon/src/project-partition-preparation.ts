import { createHash } from "node:crypto";
import { commandProjection, type CommandStore } from "./command-store.js";
import { interactionProjection, type InteractionStore } from "./interactions.js";
import { JournalManager, type JournalProjectionSlot } from "./journal-manager.js";
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

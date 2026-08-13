import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableJournal, journalPartitionDirectory } from "@claudexor/journal";
import { afterEach, describe, expect, it } from "vitest";
import { commandProjection, type CommandStore } from "./command-store.js";
import { interactionProjection, type InteractionStore } from "./interactions.js";
import { JournalManager, type JournalProjectionSlot } from "./journal-manager.js";
import { operatorDecisionProjection, type OperatorDecisionStore } from "./operator-decisions.js";
import { ProjectPartitions } from "./project-partitions.js";
import { projectProjection, type ProjectStore } from "./projects.js";
import { runEventProjection, type RunEventStore } from "./run-events.js";
import { threadProjection, type ThreadStore } from "./threads.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(name: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `claudexor-${name}-`)));
  roots.push(root);
  return root;
}

interface GlobalSlots {
  commands: JournalProjectionSlot<CommandStore>;
  interactions: JournalProjectionSlot<InteractionStore>;
  decisions: JournalProjectionSlot<OperatorDecisionStore>;
  runEvents: JournalProjectionSlot<RunEventStore>;
  projects: JournalProjectionSlot<ProjectStore>;
  threads: JournalProjectionSlot<ThreadStore>;
}

interface JournalManagerPreparation {
  partition: string;
  coverage: "complete";
  inspection: { status: "ready" | "recovery_required" };
  virtual: boolean;
}

interface ProjectPartitionsPreparation {
  coverage: "complete" | "global_registry_unavailable";
  registeredProjectIds: string[];
  trustedProjectRoots: string[];
  partitions: Array<{
    partition: string;
    status: "ready" | "recovery_required";
    virtual: boolean;
  }>;
  readyPartitions: string[];
  recoveryRequiredPartitions: string[];
}

function registerGlobal(manager: JournalManager): GlobalSlots {
  return {
    commands: manager.registerProjection(commandProjection()),
    interactions: manager.registerProjection(interactionProjection()),
    decisions: manager.registerProjection(operatorDecisionProjection()),
    runEvents: manager.registerProjection(runEventProjection()),
    projects: manager.registerProjection(projectProjection()),
    threads: manager.registerProjection(threadProjection()),
  };
}

function prepare(manager: JournalManager): JournalManagerPreparation {
  return (manager as unknown as { prepare(): JournalManagerPreparation }).prepare();
}

function preparedProjectStore(slot: JournalProjectionSlot<ProjectStore>): ProjectStore {
  return (slot as unknown as { prepared(): ProjectStore }).prepared();
}

function createPartitions(root: string, slots: GlobalSlots): ProjectPartitions {
  return new ProjectPartitions(
    root,
    slots.projects,
    slots.commands,
    slots.interactions,
    slots.decisions,
    slots.runEvents,
    slots.threads,
  );
}

function preparePartitions(value: ProjectPartitions): ProjectPartitionsPreparation {
  return (value as unknown as { prepare(): ProjectPartitionsPreparation }).prepare();
}

function seedProjects(root: string): Array<{ id: string; root: string }> {
  const firstRoot = join(root, "projects-a");
  const secondRoot = join(root, "projects-b");
  mkdirSync(firstRoot);
  mkdirSync(secondRoot);
  const manager = new JournalManager(root);
  const projects = manager.registerProjection(projectProjection());
  manager.start();
  const first = projects.current().register({
    root: firstRoot,
    idempotencyKey: "register-a",
    clientId: "test",
  });
  const second = projects.current().register({
    root: secondRoot,
    idempotencyKey: "register-b",
    clientId: "test",
  });
  manager.close();
  return [first, second];
}

function corrupt(path: string): void {
  const bytes = readFileSync(path);
  bytes[0] = (bytes[0] ?? 0) ^ 0xff;
  writeFileSync(path, bytes, { mode: 0o600 });
}

describe("journal bootstrap preparation", () => {
  it("keeps JournalManager construction and preparation read-only until activation", () => {
    const root = tempRoot("manager-prepare");
    const manager = new JournalManager(root);
    expect(existsSync(join(root, "journal"))).toBe(false);
    const slot = manager.registerProjection({
      name: "probe",
      create: (journal) => ({ journal }),
      validate: (value) => value.journal.records(),
    });

    const result = prepare(manager);
    expect(result).toMatchObject({
      partition: "global",
      coverage: "complete",
      inspection: { status: "ready" },
      virtual: true,
    });
    expect(
      (slot as unknown as { prepared(): { journal: DurableJournal } }).prepared().journal,
    ).toBeDefined();
    expect(existsSync(join(root, "journal"))).toBe(false);

    (manager as unknown as { revalidatePreparation(): void }).revalidatePreparation();
    expect(existsSync(join(root, "journal"))).toBe(false);
    (manager as unknown as { activatePrepared(): void }).activatePrepared();
    expect(slot.current().journal.state().status).toBe("ready");
    expect(existsSync(join(root, "journal"))).toBe(true);
    manager.close();
  });

  it("uses only the validated global registry for exact project coverage and trusted roots", () => {
    const root = tempRoot("partition-prepare");
    const projects = seedProjects(root);
    const manager = new JournalManager(root);
    const slots = registerGlobal(manager);
    const global = prepare(manager);
    expect(global.inspection.status).toBe("ready");
    expect(
      preparedProjectStore(slots.projects)
        .list()
        .map((project) => project.id)
        .sort(),
    ).toEqual(projects.map((project) => project.id).sort());

    const partitions = createPartitions(root, slots);
    const before = projects.map((project) =>
      existsSync(journalPartitionDirectory(join(root, "journal"), `project:${project.id}`)),
    );
    expect(before).toEqual([false, false]);
    const result = preparePartitions(partitions);

    expect(result.coverage).toBe("complete");
    expect(result.registeredProjectIds.slice().sort()).toEqual(
      projects.map((project) => project.id).sort(),
    );
    expect(result.trustedProjectRoots.slice().sort()).toEqual(
      projects.map((project) => project.root).sort(),
    );
    expect(result.readyPartitions.slice().sort()).toEqual(
      projects.map((project) => `project:${project.id}`).sort(),
    );
    expect(result.recoveryRequiredPartitions).toEqual([]);
    expect(result.partitions.every((partition) => partition.virtual)).toBe(true);
    for (const project of projects) {
      expect(
        existsSync(journalPartitionDirectory(join(root, "journal"), `project:${project.id}`)),
      ).toBe(false);
    }
    partitions.close();
    manager.close();
  });

  it("marks one corrupt registered partition globally ineligible while leaving missing peers virtual", () => {
    const root = tempRoot("partition-corrupt");
    const projects = seedProjects(root);
    const corruptPartition = `project:${projects[0]!.id}`;
    const writer = new DurableJournal({
      rootDir: join(root, "journal"),
      partition: corruptPartition,
    });
    writer.append("probe", { value: 1 });
    const corruptPath = writer.path;
    writer.close();
    corrupt(corruptPath);

    const manager = new JournalManager(root);
    const slots = registerGlobal(manager);
    prepare(manager);
    const partitions = createPartitions(root, slots);
    const result = preparePartitions(partitions);

    expect(result.coverage).toBe("complete");
    expect(result.recoveryRequiredPartitions).toEqual([corruptPartition]);
    expect(result.readyPartitions).toEqual([`project:${projects[1]!.id}`]);
    expect(result.partitions.find((entry) => entry.partition === corruptPartition)).toMatchObject({
      virtual: false,
      status: "recovery_required",
    });
    expect(
      result.partitions.find((entry) => entry.partition === `project:${projects[1]!.id}`),
    ).toMatchObject({ virtual: true, status: "ready" });
    partitions.close();
    manager.close();
  });

  it("exposes global-only recovery with unknown coverage when the registry is unavailable", () => {
    const root = tempRoot("global-unavailable");
    seedProjects(root);
    const globalPath = join(
      journalPartitionDirectory(join(root, "journal"), "global"),
      "journal.bin",
    );
    corrupt(globalPath);
    const rogue = join(root, "journal", "project-rogue-on-disk");
    mkdirSync(rogue);
    writeFileSync(join(rogue, "journal.bin"), "must-not-be-discovered", { mode: 0o600 });
    const rogueBefore = readFileSync(join(rogue, "journal.bin"));

    const manager = new JournalManager(root);
    const slots = registerGlobal(manager);
    expect(prepare(manager).inspection.status).toBe("recovery_required");
    const partitions = createPartitions(root, slots);
    const result = preparePartitions(partitions);

    expect(result).toMatchObject({
      coverage: "global_registry_unavailable",
      registeredProjectIds: [],
      trustedProjectRoots: [],
      partitions: [],
      readyPartitions: [],
      recoveryRequiredPartitions: [],
    });
    expect(readFileSync(join(rogue, "journal.bin"))).toEqual(rogueBefore);
    partitions.close();
    manager.close();
  });
});

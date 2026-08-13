import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import { resolve } from "node:path";
import { ZERO_HASH, replayFrames, type JournalRecord } from "./frame-codec.js";

export interface JournalPreparationReceipt {
  fingerprint: string;
  virtual: boolean;
  deferredRepair: null | {
    kind: "discard_unacknowledged_append";
    discardedBytes: number;
  };
}

export type PreparedJournalRecovery =
  | { status: "ready"; discardedTailBytes: number }
  | {
      status: "recovery_required";
      location: { kind: "byte"; byteOffset: number };
      reason: string;
      discardedTailBytes: number;
    };

export interface PreparedJournalInspection {
  receipt: JournalPreparationReceipt;
  recovery: PreparedJournalRecovery;
  records: JournalRecord[];
  epoch: string;
  nextSeq: number;
  previousFrameHash: string;
  knownFileBytes: number;
}

interface AppendIntent {
  v: 1;
  offset: number;
  length: number;
}

interface TreeSnapshot {
  fingerprint: string;
  rootExists: boolean;
  partitionExists: boolean;
  entries: Set<string>;
  files: Map<string, Buffer>;
  problems: string[];
}

export function inspectPreparedJournal(input: {
  rootDir: string;
  partitionDir: string;
  journalPath: string;
  intentPath: string;
  partition: string;
  initialEpoch: string;
}): PreparedJournalInspection {
  const tree = snapshotTree(input.rootDir, input.partitionDir);
  const journalBytes = tree.files.get(input.journalPath);
  const intentBytes = tree.files.get(input.intentPath);
  const unexpected = [...tree.entries].filter(
    (path) => path !== input.journalPath && path !== input.intentPath,
  );
  let problem = tree.problems[0] ?? null;
  let byteOffset = 0;
  let deferredRepair: JournalPreparationReceipt["deferredRepair"] = null;

  if (
    !problem &&
    journalBytes === undefined &&
    (intentBytes !== undefined || tree.partitionExists)
  ) {
    if (intentBytes !== undefined || unexpected.length > 0) {
      problem = "journal file is missing while partition state exists";
    }
  }

  let logicalBytes = journalBytes ?? Buffer.alloc(0);
  if (!problem && intentBytes !== undefined) {
    try {
      const intent = parseIntent(intentBytes);
      const prefix = replayFrames(logicalBytes.subarray(0, intent.offset), input.partition);
      if (
        intent.offset > logicalBytes.length ||
        logicalBytes.length > intent.offset + intent.length ||
        prefix.error ||
        prefix.incompleteOffset !== null
      ) {
        problem = "append intent does not match the journal prefix";
        byteOffset = intent.offset;
      } else {
        deferredRepair = {
          kind: "discard_unacknowledged_append",
          discardedBytes: logicalBytes.length - intent.offset,
        };
        logicalBytes = logicalBytes.subarray(0, intent.offset);
      }
    } catch (error) {
      problem = `append intent is malformed: ${safeMessage(error)}`;
    }
  }

  const decoded = replayFrames(logicalBytes, input.partition);
  if (!problem && decoded.incompleteOffset !== null) {
    problem = "unexplained suffix without append intent";
    byteOffset = decoded.incompleteOffset;
  }
  if (!problem && decoded.error) {
    problem = decoded.error.reason;
    byteOffset = decoded.error.offset;
  }

  const records = problem ? [] : decoded.records;
  const last = records.at(-1);
  const virtual = !tree.rootExists || !tree.partitionExists || journalBytes === undefined;
  return {
    receipt: { fingerprint: tree.fingerprint, virtual, deferredRepair },
    recovery: problem
      ? {
          status: "recovery_required",
          location: { kind: "byte", byteOffset },
          reason: problem,
          discardedTailBytes: 0,
        }
      : { status: "ready", discardedTailBytes: 0 },
    records,
    epoch: last?.epoch ?? input.initialEpoch,
    nextSeq: (last?.seq ?? 0) + 1,
    previousFrameHash: last?.frameHash ?? ZERO_HASH,
    knownFileBytes: logicalBytes.length,
  };
}

export function fingerprintPreparedJournal(rootDir: string, partitionDir: string): string {
  return snapshotTree(rootDir, partitionDir).fingerprint;
}

function snapshotTree(rootDir: string, partitionDir: string): TreeSnapshot {
  const hash = createHash("sha256");
  const files = new Map<string, Buffer>();
  const entries = new Set<string>();
  const problems: string[] = [];
  const root = inspectEntry(rootDir, "root", hash, files, problems, true);
  if (root.kind !== "directory") {
    hash.update("partition\0unreachable\0");
    return {
      fingerprint: hash.digest("hex"),
      rootExists: root.kind !== "missing",
      partitionExists: false,
      entries,
      files,
      problems,
    };
  }
  const partition = inspectEntry(partitionDir, "partition", hash, files, problems, true);
  if (partition.kind === "directory") {
    walkPartition(partitionDir, partitionDir, hash, files, entries, problems);
  }
  return {
    fingerprint: hash.digest("hex"),
    rootExists: true,
    partitionExists: partition.kind !== "missing",
    entries,
    files,
    problems,
  };
}

function walkPartition(
  path: string,
  partitionDir: string,
  hash: ReturnType<typeof createHash>,
  files: Map<string, Buffer>,
  entries: Set<string>,
  problems: string[],
): void {
  let names: string[];
  try {
    names = readdirSync(path).sort();
  } catch (error) {
    problems.push(`journal partition cannot be listed: ${safeMessage(error)}`);
    hash.update(`list-error\0${safeMessage(error)}\0`);
    return;
  }
  for (const name of names) {
    const child = `${path}/${name}`;
    const relative = child.slice(partitionDir.length + 1);
    entries.add(child);
    const inspected = inspectEntry(child, relative, hash, files, problems, true);
    if (inspected.kind === "directory") {
      walkPartition(child, partitionDir, hash, files, entries, problems);
    }
  }
}

function inspectEntry(
  path: string,
  label: string,
  hash: ReturnType<typeof createHash>,
  files: Map<string, Buffer>,
  problems: string[],
  strictMode: boolean,
): { kind: "missing" | "directory" | "file" | "other" } {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      hash.update(`${label}\0missing\0`);
      return { kind: "missing" };
    }
    problems.push(`${label} cannot be inspected: ${safeMessage(error)}`);
    hash.update(`${label}\0error\0${safeMessage(error)}\0`);
    return { kind: "other" };
  }
  hash.update(
    stat.isDirectory() && label === "root"
      ? `${label}\0${stat.dev}\0${stat.ino}\0${stat.mode}\0${stat.uid}\0${stat.gid}\0`
      : `${label}\0${stat.dev}\0${stat.ino}\0${stat.mode}\0${stat.uid}\0${stat.gid}\0${stat.nlink}\0${stat.size}\0${stat.mtimeMs}\0${stat.ctimeMs}\0`,
  );
  if (stat.isSymbolicLink()) {
    hash.update(`symlink\0${readlinkSync(path)}\0`);
    problems.push(`${label} is a symbolic link`);
    return { kind: "other" };
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    problems.push(`${label} is not owned by the current user`);
  }
  if (stat.isDirectory()) {
    if (realpathSync.native(path) !== resolve(path)) problems.push(`${label} is not canonical`);
    if (strictMode && process.platform !== "win32" && (stat.mode & 0o777) !== 0o700) {
      problems.push(`${label} is not private`);
    }
    return { kind: "directory" };
  }
  if (!stat.isFile() || stat.nlink !== 1) {
    problems.push(`${label} is not a private regular file`);
    return { kind: "other" };
  }
  if (strictMode && process.platform !== "win32" && (stat.mode & 0o777) !== 0o600) {
    problems.push(`${label} is not private`);
  }
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(fd);
      if (opened.dev !== stat.dev || opened.ino !== stat.ino || !opened.isFile()) {
        throw new Error("pathname identity changed while being read");
      }
      const bytes = readFileSync(fd);
      if (bytes.length !== opened.size) throw new Error("file changed while being read");
      files.set(path, bytes);
      hash.update(bytes);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    problems.push(`${label} cannot be read safely: ${safeMessage(error)}`);
    hash.update(`read-error\0${safeMessage(error)}\0`);
  }
  return { kind: "file" };
}

function parseIntent(bytes: Buffer): AppendIntent {
  if (bytes.length > 1024) throw new Error("unsafe file");
  const value = JSON.parse(bytes.toString("utf8")) as unknown;
  if (
    !isRecord(value) ||
    value.v !== 1 ||
    !Number.isSafeInteger(value.offset) ||
    Number(value.offset) < 0 ||
    !Number.isSafeInteger(value.length) ||
    Number(value.length) <= 0
  ) {
    throw new Error("invalid shape");
  }
  return value as unknown as AppendIntent;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

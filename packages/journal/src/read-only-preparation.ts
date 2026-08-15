import { createHash } from "node:crypto";
import {
  type BigIntStats,
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
import { dirname, join, resolve } from "node:path";
import { ZERO_HASH, replayFrames, type JournalRecord } from "./frame-codec.js";

export interface JournalPreparationReceipt {
  fingerprint: string;
  preparationIdentity: string;
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
  preparationIdentity: string;
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
    receipt: {
      fingerprint: tree.fingerprint,
      preparationIdentity: tree.preparationIdentity,
      virtual,
      deferredRepair,
    },
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

export function fingerprintPreparedJournal(
  rootDir: string,
  partitionDir: string,
): Pick<JournalPreparationReceipt, "fingerprint" | "preparationIdentity"> {
  const observed = snapshotTree(rootDir, partitionDir);
  return {
    fingerprint: observed.fingerprint,
    preparationIdentity: observed.preparationIdentity,
  };
}

function snapshotTree(rootDir: string, partitionDir: string): TreeSnapshot {
  const contentHash = createHash("sha256");
  const identityHash = createHash("sha256");
  const files = new Map<string, Buffer>();
  const entries = new Set<string>();
  const problems: string[] = [];
  if (!inspectTrustedParent(dirname(resolve(rootDir)), identityHash, problems)) {
    contentHash.update("root\0unreachable\0");
    return finishSnapshot({
      contentHash,
      identityHash,
      rootExists: false,
      partitionExists: false,
      entries,
      files,
      problems,
    });
  }
  const root = inspectEntry(rootDir, "root", contentHash, identityHash, files, problems, false);
  if (root.kind !== "directory") {
    contentHash.update("partition\0unreachable\0");
    identityHash.update("partition\0unreachable\0");
    return finishSnapshot({
      contentHash,
      identityHash,
      rootExists: root.kind !== "missing",
      partitionExists: false,
      entries,
      files,
      problems,
    });
  }
  const partition = inspectEntry(
    partitionDir,
    "partition",
    contentHash,
    identityHash,
    files,
    problems,
    false,
  );
  if (partition.kind === "directory") {
    walkPartition(
      partitionDir,
      partitionDir,
      partition.stat,
      contentHash,
      identityHash,
      files,
      entries,
      problems,
    );
  }
  assertDirectoryUnchanged(rootDir, root.stat, problems, "root");
  return finishSnapshot({
    contentHash,
    identityHash,
    rootExists: true,
    partitionExists: partition.kind !== "missing",
    entries,
    files,
    problems,
  });
}

function walkPartition(
  path: string,
  partitionDir: string,
  before: BigIntStats,
  contentHash: ReturnType<typeof createHash>,
  identityHash: ReturnType<typeof createHash>,
  files: Map<string, Buffer>,
  entries: Set<string>,
  problems: string[],
): void {
  let names: string[];
  try {
    names = readdirSync(path).sort();
  } catch (error) {
    problems.push(`journal partition cannot be listed: ${safeMessage(error)}`);
    contentHash.update(`list-error\0${safeMessage(error)}\0`);
    identityHash.update(`list-error\0${safeMessage(error)}\0`);
    return;
  }
  for (const name of names) {
    const child = join(path, name);
    const relative = child.slice(partitionDir.length + 1).replace(/\\/g, "/");
    entries.add(child);
    const inspected = inspectEntry(
      child,
      relative,
      contentHash,
      identityHash,
      files,
      problems,
      true,
    );
    if (inspected.kind === "directory") {
      walkPartition(
        child,
        partitionDir,
        inspected.stat,
        contentHash,
        identityHash,
        files,
        entries,
        problems,
      );
    }
  }
  try {
    if (readdirSync(path).sort().join("\0") !== names.join("\0")) {
      problems.push(`journal directory entries changed while being read: ${path}`);
    }
  } catch (error) {
    problems.push(`journal partition cannot be relisted: ${safeMessage(error)}`);
  }
  assertDirectoryUnchanged(path, before, problems, path);
}

function inspectEntry(
  path: string,
  label: string,
  contentHash: ReturnType<typeof createHash>,
  identityHash: ReturnType<typeof createHash>,
  files: Map<string, Buffer>,
  problems: string[],
  allowFile: boolean,
): { kind: "missing" | "other" } | { kind: "directory" | "file"; stat: BigIntStats } {
  let stat: BigIntStats;
  try {
    stat = lstatSync(path, { bigint: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      contentHash.update(`${label}\0missing\0`);
      identityHash.update(`${label}\0missing\0`);
      assertStillMissing(path, problems, label);
      return { kind: "missing" };
    }
    problems.push(`${label} cannot be inspected: ${safeMessage(error)}`);
    contentHash.update(`${label}\0error\0${safeMessage(error)}\0`);
    identityHash.update(`${label}\0error\0${safeMessage(error)}\0`);
    return { kind: "other" };
  }
  contentHash.update(`${label}\0${semanticMetadata(stat)}\0`);
  identityHash.update(`${label}\0${identityMetadata(stat)}\0`);
  if (stat.isSymbolicLink()) {
    try {
      const target = readlinkSync(path);
      contentHash.update(`symlink\0${target}\0`);
      identityHash.update(`symlink\0${target}\0`);
    } catch (error) {
      problems.push(`${label} symbolic-link target cannot be read: ${safeMessage(error)}`);
    }
    problems.push(`${label} is a symbolic link`);
    return { kind: "other" };
  }
  if (typeof process.getuid === "function" && stat.uid !== BigInt(process.getuid())) {
    problems.push(`${label} is not owned by the current user`);
  }
  if (stat.isDirectory()) {
    let safe = true;
    try {
      if (realpathSync.native(path) !== resolve(path)) {
        problems.push(`${label} is not canonical`);
        safe = false;
      }
    } catch (error) {
      problems.push(`${label} cannot be resolved canonically: ${safeMessage(error)}`);
      safe = false;
    }
    if (process.platform !== "win32" && Number(stat.mode & 0o777n) !== 0o700) {
      problems.push(`${label} is not private`);
      safe = false;
    }
    if (typeof process.getuid === "function" && stat.uid !== BigInt(process.getuid())) safe = false;
    return safe ? { kind: "directory", stat } : { kind: "other" };
  }
  if (!allowFile || !stat.isFile() || stat.nlink !== 1n) {
    problems.push(`${label} is not a private regular file`);
    return { kind: "other" };
  }
  if (process.platform !== "win32" && Number(stat.mode & 0o777n) !== 0o600) {
    problems.push(`${label} is not private`);
  }
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(fd, { bigint: true });
      if (
        opened.dev !== stat.dev ||
        opened.ino !== stat.ino ||
        !opened.isFile() ||
        observationMetadata(opened) !== observationMetadata(stat)
      ) {
        throw new Error("pathname identity changed while being read");
      }
      const bytes = readFileSync(fd);
      const after = fstatSync(fd, { bigint: true });
      if (
        BigInt(bytes.length) !== opened.size ||
        observationMetadata(opened) !== observationMetadata(after)
      ) {
        throw new Error("file changed while being read");
      }
      const namedAfter = lstatSync(path, { bigint: true });
      if (observationMetadata(stat) !== observationMetadata(namedAfter)) {
        throw new Error("pathname identity changed after being read");
      }
      files.set(path, bytes);
      contentHash.update(bytes);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    problems.push(`${label} cannot be read safely: ${safeMessage(error)}`);
    contentHash.update(`read-error\0${safeMessage(error)}\0`);
    identityHash.update(`read-error\0${safeMessage(error)}\0`);
  }
  return { kind: "file", stat };
}

function finishSnapshot(input: {
  contentHash: ReturnType<typeof createHash>;
  identityHash: ReturnType<typeof createHash>;
  rootExists: boolean;
  partitionExists: boolean;
  entries: Set<string>;
  files: Map<string, Buffer>;
  problems: string[];
}): TreeSnapshot {
  const fingerprint = input.contentHash.digest("hex");
  input.identityHash.update(`content\0${fingerprint}\0`);
  return {
    fingerprint,
    preparationIdentity: input.identityHash.digest("hex"),
    rootExists: input.rootExists,
    partitionExists: input.partitionExists,
    entries: input.entries,
    files: input.files,
    problems: input.problems,
  };
}

function inspectTrustedParent(
  path: string,
  identityHash: ReturnType<typeof createHash>,
  problems: string[],
): boolean {
  try {
    const before = lstatSync(path, { bigint: true });
    identityHash.update(`trusted-parent\0${identityMetadata(before)}\0`);
    if (
      before.isSymbolicLink() ||
      !before.isDirectory() ||
      realpathSync.native(path) !== path ||
      (typeof process.getuid === "function" && before.uid !== BigInt(process.getuid())) ||
      (process.platform !== "win32" && Number(before.mode & 0o777n) !== 0o700)
    ) {
      problems.push("journal root parent is not canonical and private");
      return false;
    }
    const after = lstatSync(path, { bigint: true });
    if (observationMetadata(before) !== observationMetadata(after)) {
      problems.push("journal root parent changed while being inspected");
      return false;
    }
    return true;
  } catch (error) {
    problems.push(`journal root parent cannot be inspected: ${safeMessage(error)}`);
    identityHash.update(`trusted-parent-error\0${safeMessage(error)}\0`);
    return false;
  }
}

function assertDirectoryUnchanged(
  path: string,
  before: BigIntStats,
  problems: string[],
  label: string,
): void {
  try {
    const after = lstatSync(path, { bigint: true });
    if (observationMetadata(before) !== observationMetadata(after)) {
      problems.push(`${label} changed while being inspected`);
    }
  } catch (error) {
    problems.push(`${label} became unavailable while being inspected: ${safeMessage(error)}`);
  }
}

function assertStillMissing(path: string, problems: string[], label: string): void {
  try {
    lstatSync(path);
    problems.push(`${label} appeared while being inspected`);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      problems.push(`${label} missing state is ambiguous: ${safeMessage(error)}`);
    }
  }
}

function semanticMetadata(stat: BigIntStats): string {
  const base = [entryType(stat), stat.mode & 0o777n, stat.uid, stat.gid];
  if (!stat.isDirectory()) base.push(stat.nlink, stat.size);
  return base.join(":");
}

function identityMetadata(stat: BigIntStats): string {
  const base = [stat.dev, stat.ino, entryType(stat), stat.mode & 0o777n, stat.uid, stat.gid];
  if (!stat.isDirectory()) base.push(stat.nlink);
  return base.join(":");
}

function observationMetadata(stat: BigIntStats): string {
  return [identityMetadata(stat), stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}

function entryType(stat: BigIntStats): string {
  if (stat.isDirectory()) return "directory";
  if (stat.isFile()) return "file";
  if (stat.isSymbolicLink()) return "symlink";
  return "other";
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

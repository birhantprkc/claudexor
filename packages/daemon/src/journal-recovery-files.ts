import { createHash, randomUUID } from "node:crypto";
import {
  type BigIntStats,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { JournalRecoveryRequiredError, type JournalRecoveryState } from "@claudexor/journal";
import type { ControlJournalExportReceipt } from "@claudexor/schema";
import { ensureCanonicalPrivateDirectory, fsyncDirectory } from "@claudexor/util";

export function recoveryFrom(
  error: unknown,
  fallback: string,
): Extract<JournalRecoveryState, { status: "recovery_required" }> {
  if (error instanceof JournalRecoveryRequiredError) return cloneRecovery(error.recovery) as never;
  return recoveryAt(0, `${fallback}: ${safeMessage(error)}`);
}

export function recoveryAt(
  byteOffset: number,
  reason: string,
): Extract<JournalRecoveryState, { status: "recovery_required" }> {
  return {
    status: "recovery_required",
    location: { kind: "byte", byteOffset },
    reason,
    discardedTailBytes: 0,
  };
}

export function cloneRecovery(value: JournalRecoveryState): JournalRecoveryState {
  return value.status === "ready" ? { ...value } : { ...value, location: { ...value.location } };
}

export function safeMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

export interface PartitionFingerprint {
  fingerprint: string;
  preparationIdentity: string;
  exists: boolean;
  problem: string | null;
}

/** Observe a recovery tree without throwing. Callers must reject `problem`
 * before trusting the fingerprint for activation or mutation. */
export function fingerprintPartition(
  path: string,
  trustedRoot = dirname(path),
): PartitionFingerprint {
  const contentHash = createHash("sha256");
  const identityHash = createHash("sha256");
  let exists = false;
  const problems: string[] = [];
  try {
    const ancestry = inspectCanonicalAncestry(path, trustedRoot, identityHash, problems);
    const root = ancestry.target;
    exists = root !== null;
    if (!root) {
      contentHash.update("missing\0");
    } else if (root.isSymbolicLink()) {
      contentHash.update(`symlink\0${safeReadlink(path)}\0`);
      problems.push("journal tree root is a symbolic link");
    } else if (!root.isDirectory()) {
      contentHash.update(`other\0${metadata(root)}\0`);
      problems.push("journal tree root is not a directory");
    } else {
      // Preserve the public recovery fingerprint across an atomic quarantine
      // rename and across this preparation hardening. Path/security identity
      // is intentionally separate below.
      contentHash.update("directory\0");
      fingerprintDirectory(path, contentHash, root);
    }
    revalidateAncestry(ancestry, problems);
  } catch (error) {
    problems.push(`journal tree could not be fingerprinted safely: ${safeMessage(error)}`);
    contentHash.update(`fingerprint-error\0${safeMessage(error)}\0`);
    identityHash.update(`fingerprint-error\0${safeMessage(error)}\0`);
  }
  const fingerprint = contentHash.digest("hex");
  identityHash.update(`content\0${fingerprint}\0`);
  return {
    fingerprint,
    preparationIdentity: identityHash.digest("hex"),
    exists,
    problem: problems[0] ?? null,
  };
}

export function requireStablePreparationIdentity(
  observed: PartitionFingerprint,
  context: string,
): string {
  if (observed.problem) throw new Error(`${context}: ${observed.problem}`);
  return observed.preparationIdentity;
}

interface AncestryObservation {
  target: BigIntStats | null;
  entries: Array<{ path: string; stat: BigIntStats }>;
  missingPath: string | null;
}

function inspectCanonicalAncestry(
  path: string,
  trustedRoot: string,
  identityHash: ReturnType<typeof createHash>,
  problems: string[],
): AncestryObservation {
  const absolutePath = resolve(path);
  const absoluteRoot = resolve(trustedRoot);
  const rel = relative(absoluteRoot, absolutePath);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error(`journal tree escapes trusted root: ${absolutePath}`);
  }
  const paths = [absoluteRoot];
  if (rel) {
    let cursor = absoluteRoot;
    for (const component of rel.split(sep)) {
      cursor = join(cursor, component);
      paths.push(cursor);
    }
  }
  const entries: AncestryObservation["entries"] = [];
  let missingPath: string | null = null;
  for (const [index, entryPath] of paths.entries()) {
    let stat: BigIntStats;
    try {
      stat = lstatSync(entryPath, { bigint: true });
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      missingPath = entryPath;
      identityHash.update(
        `missing\0${paths
          .slice(index)
          .map((value) => relative(absoluteRoot, value))
          .join("\0")}\0`,
      );
      break;
    }
    entries.push({ path: entryPath, stat });
    identityHash.update(`path\0${relative(absoluteRoot, entryPath)}\0${identityMetadata(stat)}\0`);
    if (stat.isSymbolicLink()) {
      problems.push(`journal tree ancestry is a symbolic link: ${entryPath}`);
      break;
    }
    const isTarget = index === paths.length - 1;
    if (!isTarget && !stat.isDirectory()) {
      problems.push(`journal tree ancestry is not a directory: ${entryPath}`);
      break;
    }
    if (stat.isDirectory()) validatePrivateDirectory(entryPath, stat, problems);
  }
  const final = entries.at(-1);
  return {
    target: !missingPath && final?.path === absolutePath ? final.stat : null,
    entries,
    missingPath,
  };
}

function validatePrivateDirectory(path: string, stat: BigIntStats, problems: string[]): void {
  if (typeof process.getuid === "function" && stat.uid !== BigInt(process.getuid())) {
    problems.push(`journal tree directory is not owned by the current user: ${path}`);
  }
  if (process.platform !== "win32" && Number(stat.mode & 0o777n) !== 0o700) {
    problems.push(`journal tree directory is not private: ${path}`);
  }
  try {
    if (realpathSync.native(path) !== resolve(path)) {
      problems.push(`journal tree directory is not canonical: ${path}`);
    }
  } catch (error) {
    problems.push(`journal tree directory cannot be resolved canonically: ${safeMessage(error)}`);
  }
}

function revalidateAncestry(observed: AncestryObservation, problems: string[]): void {
  for (const entry of observed.entries) {
    try {
      const after = lstatSync(entry.path, { bigint: true });
      if (observationMetadata(entry.stat) !== observationMetadata(after)) {
        problems.push(`journal tree ancestry changed while fingerprinting: ${entry.path}`);
      }
    } catch (error) {
      problems.push(`journal tree ancestry became unavailable: ${safeMessage(error)}`);
    }
  }
  if (observed.missingPath) {
    try {
      lstatSync(observed.missingPath);
      problems.push(`journal tree appeared while fingerprinting: ${observed.missingPath}`);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        problems.push(`journal tree missing state is ambiguous: ${safeMessage(error)}`);
      }
    }
  }
}

export function requireStableFingerprint(observed: PartitionFingerprint, context: string): string {
  if (observed.problem) throw new Error(`${context}: ${observed.problem}`);
  return observed.fingerprint;
}

export function exportPartitionEntries(source: string, destination: string) {
  if (!existsSync(source))
    return [
      { name: ".", type: "missing", mode: 0, size: 0, nlink: 0, sha256: null, copiedAs: null },
    ];
  const root = lstatSync(source, { bigint: true });
  if (!root.isDirectory() || root.isSymbolicLink()) {
    return [
      {
        name: ".",
        type: root.isSymbolicLink() ? "symlink" : "other",
        mode: Number(root.mode & 0o777n),
        size: Number(root.size),
        nlink: Number(root.nlink),
        sha256: null,
        copiedAs: null,
        ...(root.isSymbolicLink() ? { linkTarget: readlinkSync(source) } : {}),
      },
    ];
  }
  return readdirSync(source)
    .sort()
    .map((name) => {
      const path = join(source, name);
      const stat = lstatSync(path, { bigint: true });
      const type = stat.isFile()
        ? "file"
        : stat.isDirectory()
          ? "directory"
          : stat.isSymbolicLink()
            ? "symlink"
            : "other";
      let digest: string | null = null;
      let copiedAs: string | null = null;
      if (stat.isFile() && stat.nlink === 1n) {
        const bytes = readOwnedFile(path);
        digest = sha256(bytes);
        copiedAs = name;
        writeExclusiveFile(join(destination, name), bytes, 0o400);
      }
      return {
        name,
        type,
        mode: Number(stat.mode & 0o777n),
        size: Number(stat.size),
        nlink: Number(stat.nlink),
        sha256: digest,
        copiedAs,
        ...(stat.isSymbolicLink() ? { linkTarget: readlinkSync(path) } : {}),
      };
    });
}

export function exportJournalRecovery(input: {
  rootDir: string;
  partitionDir: string;
  partition: string;
  recovery: JournalRecoveryState;
  now: () => Date;
}): ControlJournalExportReceipt {
  const fingerprint = requireStableFingerprint(
    fingerprintPartition(input.partitionDir, input.rootDir),
    "journal recovery export input is unavailable",
  );
  const exportId = `journal-export-${input.now().getTime().toString(36)}-${randomUUID()}`;
  const exportsRoot = join(input.rootDir, "recovery-exports");
  ensureCanonicalPrivateDirectory(exportsRoot);
  const bundlePath = join(exportsRoot, exportId);
  ensureCanonicalPrivateDirectory(bundlePath);
  try {
    const entries = exportPartitionEntries(input.partitionDir, bundlePath);
    const createdAt = input.now().toISOString();
    const manifestPath = join(bundlePath, "manifest.json");
    writeExclusiveFile(
      manifestPath,
      Buffer.from(
        `${JSON.stringify(
          {
            schemaVersion: 1,
            exportId,
            partition: input.partition,
            fingerprint,
            recovery: input.recovery,
            createdAt,
            entries,
          },
          null,
          2,
        )}\n`,
      ),
      0o400,
    );
    fsyncDirectory(bundlePath);
    if (
      requireStableFingerprint(
        fingerprintPartition(input.partitionDir, input.rootDir),
        "journal recovery export input became unavailable",
      ) !== fingerprint
    ) {
      throw new Error("journal changed during recovery export");
    }
    return {
      schemaVersion: 1,
      exportId,
      partition: input.partition,
      fingerprint,
      bundlePath,
      manifestSha256: sha256File(manifestPath),
      createdAt,
    };
  } catch (error) {
    rmSync(bundlePath, { recursive: true, force: true });
    fsyncDirectory(exportsRoot);
    throw error;
  }
}

export function readOwnedFile(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd, { bigint: true });
    assertOwnedRegular(path, before);
    const bytes = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    if (metadata(before) !== metadata(after))
      throw new Error(`journal file changed while exporting: ${path}`);
    assertOwnedRegular(path, after);
    return bytes;
  } finally {
    closeSync(fd);
  }
}

export function writeAtomicPrivateJson(path: string, value: unknown, exclusive: boolean): void {
  ensureCanonicalPrivateDirectory(dirname(path));
  if (exclusive && existsSync(path)) {
    throw Object.assign(new Error("recovery idempotency record already exists"), {
      code: "idempotency_conflict",
      status: 409,
    });
  }
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeExclusiveFile(tmp, Buffer.from(`${JSON.stringify(value, null, 2)}\n`), 0o600);
    renameSync(tmp, path);
    fsyncDirectory(dirname(path));
  } finally {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* renamed or absent */
    }
  }
}

export function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha256File(path: string): string {
  return hashOwnedFile(path).toString("hex");
}

function hashOwnedFile(path: string, expected?: BigIntStats): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (expected && metadata(expected) !== metadata(before)) {
      throw new Error(`journal file changed before hashing: ${path}`);
    }
    assertOwnedRegular(path, before);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, offset);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
      offset += count;
    }
    const after = fstatSync(fd, { bigint: true });
    if (metadata(before) !== metadata(after))
      throw new Error(`journal file changed while hashing: ${path}`);
    assertOwnedRegular(path, after);
    return hash.digest();
  } finally {
    closeSync(fd);
  }
}

function assertOwnedRegular(path: string, opened: BigIntStats): void {
  const named = lstatSync(path, { bigint: true });
  if (
    !opened.isFile() ||
    opened.nlink !== 1n ||
    named.isSymbolicLink() ||
    !named.isFile() ||
    named.nlink !== 1n ||
    opened.dev !== named.dev ||
    opened.ino !== named.ino
  )
    throw new Error(`journal recovery file is not a singly-linked owned regular file: ${path}`);
}

function metadata(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(
    ":",
  );
}

function securityMetadata(stat: BigIntStats): string {
  const base = [entryType(stat), stat.mode & 0o777n, stat.uid, stat.gid];
  if (!stat.isDirectory()) base.push(stat.nlink);
  return base.join(":");
}

function identityMetadata(stat: BigIntStats): string {
  return [stat.dev, stat.ino, securityMetadata(stat)].join(":");
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

function safeReadlink(path: string): string {
  try {
    return readlinkSync(path);
  } catch (error) {
    return `unavailable:${errorCode(error) ?? "unknown"}`;
  }
}

function fingerprintDirectory(
  path: string,
  hash: ReturnType<typeof createHash>,
  before: BigIntStats,
): void {
  const names = readdirSync(path).sort();
  for (const name of names) {
    const entryPath = join(path, name);
    const stat = lstatSync(entryPath, { bigint: true });
    hash.update(`entry\0${name}\0${metadata(stat)}\0`);
    if (stat.isSymbolicLink()) {
      hash.update(`target\0${readlinkSync(entryPath)}\0`);
      assertUnchanged(entryPath, stat);
    } else if (stat.isFile() && stat.nlink === 1n) {
      hash.update(hashOwnedFile(entryPath, stat));
      assertUnchanged(entryPath, stat);
    } else {
      assertUnchanged(entryPath, stat);
    }
  }
  if (readdirSync(path).sort().join("\0") !== names.join("\0")) {
    throw new Error(`journal directory entries changed while hashing: ${path}`);
  }
  assertUnchanged(path, before);
}

function assertUnchanged(path: string, before: BigIntStats): void {
  const after = lstatSync(path, { bigint: true });
  if (metadata(before) !== metadata(after)) {
    throw new Error(`journal tree changed while hashing: ${path}`);
  }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

export function writeExclusiveFile(path: string, bytes: Buffer, mode: number): void {
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fsyncSync(fd);
    fchmodSync(fd, mode);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

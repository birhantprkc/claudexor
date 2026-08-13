/**
 * The bounded, private daemon startup diagnostic owner.
 *
 * This module deliberately does not acquire root authority. Its factory name
 * and required call contract make the ordering explicit: only a daemon that
 * already owns the data root may open the canonical log. Callers must treat
 * every diagnostic failure as non-authoritative for daemon lifecycle safety.
 */
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { logPath as canonicalLogPath } from "@claudexor/daemon";
import { redactSecrets, safeProblemMessage } from "@claudexor/util";

const DEFAULT_CURRENT_BYTES = 256 * 1024;
const DEFAULT_RECORD_BYTES = 16 * 1024;
const MAX_TAIL_BYTES = DEFAULT_CURRENT_BYTES;
const MAX_TAIL_LINES = 200;
const MIN_RECORD_BYTES = 256;
const SAFE_LABEL = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const activeWriters = new Set<string>();

export interface DaemonStartupDiagnosticContext {
  runtimeVersion: string;
  buildSha: string;
  entryPath: string;
  pid: number;
  dataRoot: string;
  launchSource: string;
}

export interface DaemonStartupDiagnosticRecord {
  stage: string;
  message: string;
  error?: unknown;
}

export interface DaemonStartupDiagnostics {
  readonly path: string;
  readonly rotatedPath: string;
  record(record: DaemonStartupDiagnosticRecord): boolean;
  close(): void;
  lastFailure(): string | null;
}

export interface DaemonStartupDiagnosticOptions {
  path?: string;
  maxCurrentBytes?: number;
  maxRecordBytes?: number;
  platform?: NodeJS.Platform;
  uid?: number;
  now?: () => Date;
}

interface SafeFileOptions {
  platform: NodeJS.Platform;
  uid: number | undefined;
  repairMode: boolean;
  create: boolean;
  exclusive?: boolean;
  readOnly?: boolean;
}

function boundedPositiveInt(value: number, name: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return value;
}

function diagnosticError(message: string, error?: unknown): Error {
  const detail = error === undefined ? "" : `: ${safeProblemMessage(error)}`;
  return new Error(
    `daemon diagnostic target is not safe and owner-controlled (${message})${detail}`,
  );
}

function validatePrivateParent(path: string, platform: NodeJS.Platform, uid?: number): void {
  const parent = dirname(path);
  try {
    const stat = lstatSync(parent);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw diagnosticError("parent is not a regular directory");
    }
    if (platform !== "win32" && uid !== undefined) {
      if (stat.uid !== uid) throw diagnosticError("parent has a foreign uid");
      if ((stat.mode & 0o077) !== 0) throw diagnosticError("parent permissions are not private");
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("daemon diagnostic target")) throw error;
    throw diagnosticError("parent cannot be proven", error);
  }
}

function validateOpenedPath(path: string, fd: number, options: SafeFileOptions): void {
  const opened = fstatSync(fd);
  const named = lstatSync(path);
  if (
    named.isSymbolicLink() ||
    !opened.isFile() ||
    !named.isFile() ||
    opened.nlink !== 1 ||
    named.nlink !== 1 ||
    opened.dev !== named.dev ||
    opened.ino !== named.ino
  ) {
    throw diagnosticError("target is not a singly-linked regular file");
  }
  if (
    options.platform !== "win32" &&
    options.uid !== undefined &&
    (opened.uid !== options.uid || named.uid !== options.uid)
  ) {
    throw diagnosticError("target has a foreign uid");
  }
  if (options.platform !== "win32" && options.repairMode && (opened.mode & 0o777) !== 0o600) {
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
  }
}

function openSafeFile(path: string, options: SafeFileOptions): number {
  validatePrivateParent(path, options.platform, options.uid);
  const access = options.readOnly ? constants.O_RDONLY : constants.O_RDWR | constants.O_APPEND;
  const create = options.create ? constants.O_CREAT : 0;
  const exclusive = options.exclusive ? constants.O_EXCL : 0;
  let fd: number | undefined;
  try {
    fd = openSync(path, access | create | exclusive | constants.O_NOFOLLOW, 0o600);
    validateOpenedPath(path, fd, options);
    return fd;
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    throw diagnosticError("file proof failed", error);
  }
}

function closeQuietly(fd: number | undefined): void {
  if (fd === undefined) return;
  try {
    closeSync(fd);
  } catch {
    /* diagnostics never own lifecycle success */
  }
}

function pathExistsWithoutFollowing(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function openExistingSafe(path: string, options: SafeFileOptions): number | undefined {
  if (!pathExistsWithoutFollowing(path)) return undefined;
  return openSafeFile(path, { ...options, create: false });
}

function writerIdentity(path: string): string {
  try {
    return join(realpathSync.native(dirname(path)), basename(path));
  } catch {
    return path;
  }
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  const marker = "[redacted]";
  const markerAt = value.indexOf(marker);
  const markerSuffix = `…${marker}`;
  const preserveMarker = markerAt >= 0 && Buffer.byteLength(markerSuffix) <= maxBytes;
  const source = preserveMarker ? value.slice(0, markerAt) : value;
  const suffix = preserveMarker ? markerSuffix : maxBytes >= 3 ? "…" : "";
  const suffixBytes = Buffer.byteLength(suffix);
  let low = 0;
  let high = source.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(source.slice(0, mid)) + suffixBytes <= maxBytes) low = mid;
    else high = mid - 1;
  }
  let prefix = source.slice(0, low);
  if (/\p{Surrogate}$/u.test(prefix)) prefix = prefix.slice(0, -1);
  return `${prefix}${suffix}`;
}

function redactedString(value: unknown, maxBytes: number): string {
  return truncateUtf8(redactSecrets(String(value)), maxBytes);
}

function diagnosticLine(
  context: DaemonStartupDiagnosticContext,
  input: DaemonStartupDiagnosticRecord,
  now: () => Date,
  maxRecordBytes: number,
): Buffer {
  const error = input.error;
  const failureClass =
    error instanceof Error
      ? error.name || error.constructor?.name || "Error"
      : error === undefined
        ? undefined
        : "NonErrorThrown";
  const stack =
    error instanceof Error
      ? error.stack || `${failureClass}: ${error.message}`
      : error === undefined
        ? undefined
        : String(error);
  const perField = maxRecordBytes;
  const record: Record<string, string | number> = {
    timestamp: redactedString(now().toISOString(), perField),
    runtimeVersion: redactedString(context.runtimeVersion, perField),
    buildSha: redactedString(context.buildSha, perField),
    entryPath: redactedString(context.entryPath, perField),
    pid: context.pid,
    dataRoot: redactedString(context.dataRoot, perField),
    launchSource: redactedString(context.launchSource, perField),
    stage: redactedString(input.stage, perField),
    message: redactedString(input.message, perField),
  };
  if (failureClass !== undefined) record.failureClass = redactedString(failureClass, 128);
  if (stack !== undefined) record.stack = redactedString(stack, perField);

  let encoded = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
  const shrinkOrder = ["message", "entryPath", "dataRoot", "stack", "runtimeVersion", "buildSha"];
  const minimumBytes: Record<string, number> = {
    message: 8,
    entryPath: 16,
    dataRoot: 16,
    stack: 160,
    runtimeVersion: 8,
    buildSha: 8,
  };
  while (encoded.length > maxRecordBytes) {
    const key = shrinkOrder.find((candidate) => {
      const value = record[candidate];
      return typeof value === "string" && Buffer.byteLength(value) > (minimumBytes[candidate] ?? 8);
    });
    if (!key) throw new Error("diagnostic record metadata exceeds the configured bound");
    const value = record[key] as string;
    const currentBytes = Buffer.byteLength(value);
    const nextBytes = Math.max(
      minimumBytes[key] ?? 8,
      currentBytes - Math.max(16, encoded.length - maxRecordBytes),
    );
    record[key] = truncateUtf8(value, nextBytes);
    encoded = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
  }
  return encoded;
}

function writeOversizeDiscardReceipt(
  path: string,
  context: DaemonStartupDiagnosticContext,
  options: Required<Pick<DaemonStartupDiagnosticOptions, "maxRecordBytes" | "platform" | "now">> & {
    uid?: number;
  },
): void {
  const line = diagnosticLine(
    context,
    {
      stage: "diagnostic_legacy_log_discarded",
      message: "an oversized legacy diagnostic generation was discarded without copying its bytes",
    },
    options.now,
    options.maxRecordBytes,
  );
  let fd = openExistingSafe(path, {
    platform: options.platform,
    uid: options.uid,
    repairMode: true,
    create: false,
  });
  try {
    if (fd === undefined) {
      fd = openSafeFile(path, {
        platform: options.platform,
        uid: options.uid,
        repairMode: true,
        create: true,
        exclusive: true,
      });
    }
    ftruncateSync(fd, 0);
    writeAll(fd, line);
    fsyncSync(fd);
  } finally {
    closeQuietly(fd);
  }
}

/** Open the canonical writer only after a separate root-authority owner won. */
export function openDaemonStartupDiagnosticsAfterAuthority(
  context: DaemonStartupDiagnosticContext,
  options: DaemonStartupDiagnosticOptions = {},
): DaemonStartupDiagnostics {
  if (!Number.isSafeInteger(context.pid) || context.pid <= 0) throw new Error("invalid daemon pid");
  if (!SAFE_LABEL.test(context.launchSource)) throw new Error("invalid daemon launch source");
  const path = resolve(options.path ?? canonicalLogPath());
  const rotatedPath = `${path}.1`;
  const maxCurrentBytes = boundedPositiveInt(
    options.maxCurrentBytes ?? DEFAULT_CURRENT_BYTES,
    "maxCurrentBytes",
    MIN_RECORD_BYTES,
  );
  const maxRecordBytes = boundedPositiveInt(
    options.maxRecordBytes ?? DEFAULT_RECORD_BYTES,
    "maxRecordBytes",
    MIN_RECORD_BYTES,
  );
  if (maxRecordBytes > maxCurrentBytes) {
    throw new Error("maxRecordBytes must not exceed maxCurrentBytes");
  }
  const platform = options.platform ?? process.platform;
  const uid = options.uid ?? process.getuid?.();
  const now = options.now ?? (() => new Date());
  const writerKey = writerIdentity(path);
  if (activeWriters.has(writerKey))
    throw new Error(`one diagnostic writer is already active for ${path}`);

  let fd: number | undefined;
  let closed = false;
  let failure: string | null = null;
  try {
    fd = openSafeFile(path, { platform, uid, repairMode: true, create: true });
    const current = fstatSync(fd);
    const rotated = openExistingSafe(rotatedPath, {
      platform,
      uid,
      repairMode: true,
      create: false,
    });
    if (rotated !== undefined) {
      const size = fstatSync(rotated).size;
      closeQuietly(rotated);
      if (size > maxCurrentBytes) {
        writeOversizeDiscardReceipt(rotatedPath, context, {
          maxRecordBytes,
          platform,
          uid,
          now,
        });
      }
    }
    if (current.size > maxCurrentBytes) {
      ftruncateSync(fd, 0);
      fsyncSync(fd);
      writeOversizeDiscardReceipt(rotatedPath, context, {
        maxRecordBytes,
        platform,
        uid,
        now,
      });
    }
    activeWriters.add(writerKey);
  } catch (error) {
    closeQuietly(fd);
    throw error;
  }

  const rotate = (): void => {
    if (fd === undefined) throw new Error("diagnostic writer is closed");
    validateOpenedPath(path, fd, { platform, uid, repairMode: true, create: false });
    const prior = openExistingSafe(rotatedPath, {
      platform,
      uid,
      repairMode: true,
      create: false,
    });
    closeQuietly(prior);
    if (prior !== undefined) unlinkSync(rotatedPath);
    closeSync(fd);
    fd = undefined;
    renameSync(path, rotatedPath);
    fd = openSafeFile(path, {
      platform,
      uid,
      repairMode: true,
      create: true,
      exclusive: true,
    });
  };

  return {
    path,
    rotatedPath,
    record(input): boolean {
      if (closed || fd === undefined) {
        failure = "diagnostic writer is closed";
        return false;
      }
      try {
        if (!SAFE_LABEL.test(input.stage)) throw new Error("invalid diagnostic stage");
        const line = diagnosticLine(context, input, now, maxRecordBytes);
        if (fstatSync(fd).size + line.length > maxCurrentBytes) rotate();
        if (fd === undefined) throw new Error("diagnostic writer closed during rotation");
        writeAll(fd, line);
        return true;
      } catch (error) {
        failure = safeProblemMessage(error);
        return false;
      }
    },
    close(): void {
      if (closed) return;
      closed = true;
      activeWriters.delete(writerKey);
      closeQuietly(fd);
      fd = undefined;
    },
    lastFailure: () => failure,
  };
}

export interface ReadDaemonDiagnosticTailOptions {
  path?: string;
  lines?: number;
  platform?: NodeJS.Platform;
  uid?: number;
}

/** Read only a bounded current-generation tail through the same inode proof. */
export function readDaemonDiagnosticTail(options: ReadDaemonDiagnosticTailOptions = {}): string {
  const path = resolve(options.path ?? canonicalLogPath());
  const lines = boundedPositiveInt(options.lines ?? 40, "lines", 1);
  if (lines > MAX_TAIL_LINES) throw new Error(`lines must not exceed ${MAX_TAIL_LINES}`);
  const platform = options.platform ?? process.platform;
  const uid = options.uid ?? process.getuid?.();
  const fd = openSafeFile(path, {
    platform,
    uid,
    repairMode: false,
    create: false,
    readOnly: true,
  });
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, MAX_TAIL_BYTES);
    const bytes = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const read = readSync(fd, bytes, offset, length - offset, size - length + offset);
      if (read === 0) break;
      offset += read;
    }
    const text = redactSecrets(bytes.subarray(0, offset).toString("utf8"));
    const split = text.split("\n");
    const terminated = split.at(-1) === "";
    if (terminated) split.pop();
    const tail = split.slice(-lines).join("\n");
    return terminated && tail ? `${tail}\n` : tail;
  } finally {
    closeSync(fd);
  }
}

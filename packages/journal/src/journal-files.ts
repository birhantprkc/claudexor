import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { fsyncDirectory } from "@claudexor/util";

export interface AppendIntent {
  v: 1;
  offset: number;
  length: number;
}

export function appendAndSync(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
  fsyncSync(fd);
}

export function ensurePrivateFile(path: string): void {
  if (!existsSync(path)) {
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    fsyncDirectory(dirname(path));
  }
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    throw new Error("journal path is not a private regular file");
  }
}

export function readDescriptor(fd: number): Buffer {
  const size = Number(fstatSync(fd, { bigint: true }).size);
  if (!Number.isSafeInteger(size) || size < 0) throw new Error("journal file size is invalid");
  const bytes = readFileSync(fd);
  if (bytes.length !== size) throw new Error("journal changed while being read");
  return bytes;
}

export function readIntent(path: string): AppendIntent | null {
  if (!existsSync(path)) return null;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024) throw new Error("unsafe file");
    const value = JSON.parse(readFileSync(fd, "utf8")) as unknown;
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
  } finally {
    closeSync(fd);
  }
}

export function writeIntent(path: string, value: AppendIntent): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
  fsyncDirectory(dirname(path));
}

export function removeFile(path: string): void {
  if (!existsSync(path)) return;
  rmSync(path);
  fsyncDirectory(dirname(path));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

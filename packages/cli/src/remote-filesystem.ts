import {
  closeSync,
  constants,
  accessSync,
  fstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ProjectStore } from "@claudexor/daemon";
import { ControlDirectoryListing } from "@claudexor/schema";

const MAX_DIRECTORY_ENTRIES = 1_000;
const MAX_PROJECT_FILE_BYTES = 25 * 1024 * 1024;

function contained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function canonicalDirectory(path: string, root: string): string {
  if (!isAbsolute(path)) {
    throw Object.assign(new Error("directory path must be absolute"), { status: 400 });
  }
  let canonical: string;
  try {
    canonical = realpathSync(path);
  } catch {
    throw Object.assign(new Error(`directory does not exist: ${path}`), { status: 400 });
  }
  if (!contained(root, canonical)) {
    throw Object.assign(new Error("directory path escapes the remote home"), {
      status: 403,
      code: "path_outside_remote_home",
    });
  }
  if (!statSync(canonical).isDirectory()) {
    throw Object.assign(new Error("directory path is not a directory"), { status: 400 });
  }
  return canonical;
}

export function listRemoteDirectory(requestedPath: string | undefined, homePath = homedir()) {
  const home = realpathSync(homePath);
  const path = canonicalDirectory(requestedPath || home, home);
  const candidates = [];
  for (const name of readdirSync(path)) {
    const lexical = join(path, name);
    try {
      const target = realpathSync(lexical);
      if (!contained(home, target)) continue;
      const stat = statSync(target);
      if (!stat.isDirectory() && !stat.isFile()) continue;
      let readable = true;
      try {
        accessSync(target, constants.R_OK);
      } catch {
        readable = false;
      }
      candidates.push({
        name,
        path: target,
        kind: stat.isDirectory() ? ("directory" as const) : ("file" as const),
        readable,
      });
    } catch {
      // Broken and inaccessible symlinks are not actionable picker entries.
    }
  }
  candidates.sort(
    (left, right) =>
      (left.kind === right.kind ? 0 : left.kind === "directory" ? -1 : 1) ||
      left.name.localeCompare(right.name),
  );
  const entries = candidates.slice(0, MAX_DIRECTORY_ENTRIES);
  const parentPath = path === home ? null : resolve(path, "..");
  return ControlDirectoryListing.parse({
    path,
    home,
    parent: parentPath && contained(home, parentPath) ? parentPath : null,
    entries,
    truncated: candidates.length > MAX_DIRECTORY_ENTRIES,
  });
}

export interface ScopedProjectFile {
  data: Buffer;
  contentType: string;
  fileName: string;
}

export function readScopedProjectFile(
  projects: ProjectStore,
  projectId: string,
  requestedPath: string,
): ScopedProjectFile {
  const project = projects.get(projectId);
  if (!project) throw Object.assign(new Error(`no such project: ${projectId}`), { status: 404 });
  if (
    !requestedPath ||
    isAbsolute(requestedPath) ||
    requestedPath.includes("\0") ||
    requestedPath.split(/[\\/]/).includes("..")
  ) {
    throw Object.assign(new Error("project file path must be a contained relative path"), {
      status: 400,
    });
  }
  const root = realpathSync(project.root);
  const lexical = resolve(root, requestedPath);
  let canonical: string;
  let expected: ReturnType<typeof statSync>;
  try {
    canonical = realpathSync(lexical);
    expected = statSync(canonical);
  } catch {
    throw Object.assign(new Error("project file does not exist"), { status: 404 });
  }
  if (!contained(root, canonical)) {
    throw Object.assign(new Error("project file path escapes its registered project"), {
      status: 403,
      code: "project_file_path_escape",
    });
  }
  let descriptor: number;
  try {
    descriptor = openSync(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw Object.assign(new Error("project file changed or is not a regular file"), {
      status: 409,
      code: "project_file_changed",
    });
  }
  try {
    const openedPath = openedDescriptorPath(descriptor, canonical);
    if (!contained(root, openedPath)) {
      throw Object.assign(new Error("opened project file escapes its registered project"), {
        status: 403,
        code: "project_file_path_escape",
      });
    }
    const before = fstatSync(descriptor);
    if (before.dev !== expected.dev || before.ino !== expected.ino || !before.isFile()) {
      throw Object.assign(new Error("project file changed before it was opened"), {
        status: 409,
        code: "project_file_changed",
      });
    }
    if (before.size > MAX_PROJECT_FILE_BYTES) {
      throw Object.assign(
        new Error(`project file exceeds the ${MAX_PROJECT_FILE_BYTES} byte fetch limit`),
        { status: 413, code: "project_file_too_large" },
      );
    }
    const buffer = Buffer.allocUnsafe(Math.min(MAX_PROJECT_FILE_BYTES + 1, before.size + 1));
    let bytes = 0;
    for (;;) {
      const count = readSync(descriptor, buffer, bytes, buffer.length - bytes, null);
      if (count === 0) break;
      bytes += count;
      if (bytes > MAX_PROJECT_FILE_BYTES) {
        throw Object.assign(
          new Error(`project file exceeds the ${MAX_PROJECT_FILE_BYTES} byte fetch limit`),
          { status: 413, code: "project_file_too_large" },
        );
      }
    }
    const after = fstatSync(descriptor);
    let finalPath: string;
    let final: ReturnType<typeof statSync>;
    try {
      finalPath = realpathSync(lexical);
      final = statSync(finalPath);
    } catch {
      throw Object.assign(new Error("project file changed while it was being read"), {
        status: 409,
        code: "project_file_changed",
      });
    }
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      after.size !== bytes ||
      final.dev !== after.dev ||
      final.ino !== after.ino ||
      finalPath !== canonical
    ) {
      throw Object.assign(new Error("project file changed while it was being read"), {
        status: 409,
        code: "project_file_changed",
      });
    }
    return {
      data: buffer.subarray(0, bytes),
      contentType: mimeType(openedPath),
      fileName: openedPath.split(sep).at(-1) ?? "remote-file",
    };
  } finally {
    closeSync(descriptor);
  }
}

function openedDescriptorPath(descriptor: number, fallback: string): string {
  // Linux exposes the kernel-bound pathname for an open descriptor. Darwin's
  // /dev/fd entries are not symlinks and realpath cannot recover F_GETPATH, so
  // the inode checks before and after the bounded descriptor read remain the
  // portability fence there.
  try {
    return realpathSync(`/proc/self/fd/${descriptor}`);
  } catch {
    return fallback;
  }
}

function mimeType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml";
    case ".json":
      return "application/json";
    case ".md":
    case ".txt":
    case ".log":
      return "text/plain; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

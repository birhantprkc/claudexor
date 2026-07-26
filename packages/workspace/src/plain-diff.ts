import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { parseUnifiedDiff } from "@claudexor/core";
import { containsSecretLikeToken } from "@claudexor/util";

const MAX_BINARY_SECRET_SCAN_BYTES = 32 * 1024 * 1024;

/** Rewrite only structural GNU/BSD `diff -ruN` headers to git-style paths.
 * Missing-side headers become `/dev/null`, making added/deleted files exactly
 * reversible with `git apply --no-index`; hunk content is never rewritten. */
export function relativizePlainDiffHeaders(
  text: string,
  baselineRoot: string,
  liveRoot: string,
): string {
  const base = baselineRoot.endsWith("/") ? baselineRoot : `${baselineRoot}/`;
  const live = liveRoot.endsWith("/") ? liveRoot : `${liveRoot}/`;
  const swap = (line: string): string => line.split(base).join("a/").split(live).join("b/");
  const lines = text.split("\n");
  const headerWitness = (line: string | undefined): boolean =>
    line !== undefined && (line.includes("\t") || line.slice(4).trim() === "/dev/null");
  const isFileHeaderTriple = (index: number, midHunk: boolean): boolean => {
    const triple =
      (lines[index]?.startsWith("--- ") ?? false) &&
      (lines[index + 1]?.startsWith("+++ ") ?? false) &&
      (lines[index + 2]?.startsWith("@@") ?? false);
    if (!triple) return false;
    return midHunk ? headerWitness(lines[index]) && headerWitness(lines[index + 1]) : true;
  };
  const canonicalHeader = (line: string): string => {
    const path = line.slice(4).split("\t", 1)[0] as string;
    return path !== "/dev/null" && !existsSync(path) ? `${line.slice(0, 4)}/dev/null` : swap(line);
  };
  let inHunk = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    if (line.startsWith("diff ")) {
      inHunk = false;
      lines[index] = swap(line);
      continue;
    }
    if (isFileHeaderTriple(index, inHunk)) {
      lines[index] = canonicalHeader(line);
      lines[index + 1] = canonicalHeader(lines[index + 1] as string);
      inHunk = false;
      index += 1;
      continue;
    }
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (line.startsWith("Binary files ") && line.endsWith(" differ") && !inHunk) {
      lines[index] = swap(line);
    }
  }
  return lines.join("\n");
}

/** `diff -ruN` carries no binary payload, so inspect each live binary
 * postimage directly. Oversized, non-regular, or unreadable bytes fail closed. */
export function plainDiffBinarySecretLike(text: string, liveRoot: string): boolean {
  const root = resolve(liveRoot);
  for (const file of parseUnifiedDiff(text).files) {
    if (!file.binaryStub || file.deleted || !file.newPath) continue;
    const source = resolve(root, file.newPath);
    if (source !== root && !source.startsWith(root + sep)) return true;
    let fd: number;
    try {
      fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return true;
    }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_BINARY_SECRET_SCAN_BYTES) return true;
      const bytes = readFileSync(fd);
      if (bytes.length > MAX_BINARY_SECRET_SCAN_BYTES) return true;
      if (containsSecretLikeToken(bytes.toString("latin1"))) return true;
    } catch {
      return true;
    } finally {
      closeSync(fd);
    }
  }
  return false;
}

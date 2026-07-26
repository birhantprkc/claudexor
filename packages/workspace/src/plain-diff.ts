import { existsSync } from "node:fs";

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

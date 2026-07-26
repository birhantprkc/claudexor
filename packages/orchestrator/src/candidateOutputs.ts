import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { dirname, extname, join, relative as pathRelative, resolve, sep } from "node:path";
import type { ArtifactStore } from "@claudexor/artifact-store";
import { CLAUDEXOR_ARTIFACT_DIR, summarizeDiffPaths } from "@claudexor/core";
import { containsSecretLikeToken } from "@claudexor/util";

const RASTER_OUTPUT_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;

function lstatIfPresent(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function writeNoFollow(path: string, data: string | Buffer, mode: number, replace: boolean): void {
  const flags =
    constants.O_WRONLY |
    constants.O_CREAT |
    constants.O_NOFOLLOW |
    (replace ? constants.O_TRUNC : constants.O_EXCL);
  const fd = openSync(path, flags, mode);
  try {
    writeFileSync(fd, data);
  } finally {
    closeSync(fd);
  }
}

function rasterBytesIfSafe(
  source: string,
  maxBytes = MAX_OUTPUT_BYTES,
): {
  bytes: Buffer;
  mode: number;
} | null {
  let fd: number | null = null;
  try {
    fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    const bytes = readFileSync(fd);
    if (bytes.length > maxBytes || containsSecretLikeToken(bytes.toString("latin1"))) return null;
    return { bytes, mode: stat.mode & 0o777 };
  } catch {
    // Detection callers interpret an unreadable raster as an unprovable secret
    // risk; persistence callers skip it. Never let a filesystem race turn the
    // fail-closed artifact fence into an untyped attempt crash.
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // The bytes are already bounded in memory or the read failed closed.
      }
    }
  }
}

function copyRasterIfSafe(source: string, target: string, maxBytes: number): number | null {
  const safe = rasterBytesIfSafe(source, maxBytes);
  if (!safe) return null;
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  writeNoFollow(target, safe.bytes, safe.mode, false);
  return safe.bytes.length;
}

type CandidatePathStatus =
  { kind: "safe"; path: string; stat: Stats } | { kind: "missing" | "symlink" | "unsafe" };

/** Lexically contain a path and reject symlinks or unreadable/non-directory
 * intermediate components before any candidate output is inspected. */
function candidatePathStatus(root: string, raw: string): CandidatePathStatus {
  const target = resolve(root, raw);
  if (target === root || !target.startsWith(root + sep)) return { kind: "unsafe" };
  const parts = pathRelative(root, target).split(sep).filter(Boolean);
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]!);
    let stat: Stats | null;
    try {
      stat = lstatIfPresent(current);
    } catch {
      return { kind: "unsafe" };
    }
    if (!stat) return { kind: "missing" };
    if (stat.isSymbolicLink()) {
      return { kind: index === parts.length - 1 ? "symlink" : "unsafe" };
    }
    if (index < parts.length - 1 && !stat.isDirectory()) return { kind: "unsafe" };
    if (index === parts.length - 1) return { kind: "safe", path: target, stat };
  }
  return { kind: "unsafe" };
}

function artifactMediaPaths(root: string): { paths: string[]; unsafe: boolean } {
  const artifactRoot = join(root, CLAUDEXOR_ARTIFACT_DIR);
  const rootStatus = candidatePathStatus(root, artifactRoot);
  if (rootStatus.kind === "missing") return { paths: [], unsafe: false };
  if (rootStatus.kind !== "safe" || !rootStatus.stat.isDirectory()) {
    return { paths: [], unsafe: true };
  }
  const paths: string[] = [];
  let unsafe = false;
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      unsafe = true;
      return;
    }
    for (const name of entries.sort()) {
      const status = candidatePathStatus(root, join(dir, name));
      if (status.kind === "missing") continue;
      // A leaf symlink is never followed or persisted, but its presence beside
      // ordinary owned media does not make the whole candidate suspicious.
      if (status.kind === "symlink") continue;
      if (status.kind !== "safe") {
        unsafe = true;
        continue;
      }
      if (status.stat.isDirectory()) {
        walk(status.path);
        continue;
      }
      if (!RASTER_OUTPUT_EXTENSIONS.has(extname(name).toLowerCase())) continue;
      if (!status.stat.isFile()) {
        unsafe = true;
        continue;
      }
      paths.push(pathRelative(root, status.path).split("\\").join("/"));
    }
  };
  walk(artifactRoot);
  return { paths, unsafe };
}

/** Stage large synthesis evidence in the envelope, returning an idempotent
 * cleanup that callers run before any diff/gate/review. */
export function stageFileBackedContext(worktreePath: string, content?: string): () => void {
  if (content === undefined) return () => {};
  const path = join(worktreePath, ".claudexor-synthesis-input.md");
  let original: { bytes: Buffer; mode: number } | null = null;
  const existing = lstatIfPresent(path);
  if (existing) {
    const stat = existing;
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("synthesis input path already exists and is not a regular file");
    }
    original = { bytes: readFileSync(path), mode: stat.mode & 0o777 };
  }
  writeNoFollow(path, content, 0o600, existing !== null);
  return () => {
    rmSync(path, { recursive: true, force: true });
    if (original) {
      writeNoFollow(path, original.bytes, original.mode, false);
      chmodSync(path, original.mode);
    }
  };
}

export function buildFileBackedSynthesisInput(input: {
  instructions: string;
  findings: readonly string[];
  candidates: readonly { label: string; attemptId: string; diff: string }[];
}): { prompt: string; content: string } {
  const diffs = input.candidates
    .map((candidate) => `### ${candidate.label} (${candidate.attemptId})\n${candidate.diff}`)
    .join("\n\n");
  return {
    prompt:
      `${input.instructions}\n\n` +
      "Read `.claudexor-synthesis-input.md` completely before editing. " +
      "It contains the findings and candidate diffs. Do not modify that temporary file.",
    content:
      `# Findings to fix\n\n${input.findings.map((finding) => `- ${finding}`).join("\n") || "(none)"}` +
      `\n\n# Candidate diffs\n\n${diffs}`,
  };
}

/**
 * Preserve candidate-generated raster outputs before its disposable envelope
 * is removed. Text/source truth remains in patch.diff; this is specifically
 * the produced-output plane needed by chat markdown screenshots.
 */
export function persistCandidateOutputs(input: {
  worktreePath: string;
  attemptDir: string;
  changedPaths: readonly string[];
}): string[] {
  const root = resolve(input.worktreePath);
  let total = 0;
  const preserved: string[] = [];
  const candidates = new Map<string, { relative: string; source: string }>();

  for (const raw of input.changedPaths) {
    if (!RASTER_OUTPUT_EXTENSIONS.has(extname(raw).toLowerCase())) continue;
    const status = candidatePathStatus(root, raw);
    if (status.kind !== "safe" || !status.stat.isFile()) continue;
    const relative = pathRelative(root, status.path).split("\\").join("/");
    let identity: string;
    try {
      // realpath returns the filesystem's canonical spelling, so case and
      // Unicode-normalization aliases on macOS collapse before any O_EXCL
      // destination write. The already-verified lexical path remains the
      // source used by the no-follow copy fence.
      identity = realpathSync.native(status.path);
    } catch {
      continue;
    }
    if (!candidates.has(identity)) {
      candidates.set(identity, { relative, source: status.path });
    }
  }

  for (const { relative, source } of candidates.values()) {
    const target = join(input.attemptDir, "produced", relative);
    const copied = copyRasterIfSafe(
      source,
      target,
      Math.min(MAX_OUTPUT_BYTES, MAX_TOTAL_BYTES - total),
    );
    if (copied === null) continue;
    total += copied;
    preserved.push(relative);
  }
  return preserved;
}

/**
 * Collect media the harness saved for the USER into the claudexor-owned
 * artifact dir (F4). These files are EXCLUDED from the candidate diff
 * (so a screenshot-only run reads as noChanges), so they never appear in the
 * diff's changed paths — this walk is how they reach the Evidence gallery.
 * Returns worktree-relative paths (retaining the `.claudexor-artifacts/`
 * prefix) preserved under the attempt's `produced/` plane. Symlink-safe and
 * byte-bounded exactly like `persistCandidateOutputs`.
 */
export function collectArtifactDirMedia(input: {
  worktreePath: string;
  attemptDir: string;
}): string[] {
  const root = resolve(input.worktreePath);
  let total = 0;
  const preserved: string[] = [];
  for (const rel of artifactMediaPaths(root).paths) {
    const status = candidatePathStatus(root, rel);
    if (status.kind !== "safe" || !status.stat.isFile()) continue;
    const target = join(input.attemptDir, "produced", rel);
    const copied = copyRasterIfSafe(
      status.path,
      target,
      Math.min(MAX_OUTPUT_BYTES, MAX_TOTAL_BYTES - total),
    );
    if (copied === null) continue;
    total += copied;
    preserved.push(rel);
  }
  return preserved;
}

export function candidateOutputsContainSecret(input: {
  worktreePath: string;
  changedPaths: readonly string[];
}): boolean {
  return candidateOutputSecretRisk(input).risky;
}

export function candidateOutputSecretRisk(input: {
  worktreePath: string;
  changedPaths: readonly string[];
}): {
  risky: boolean;
  riskyPaths: string[];
  nonReversiblePaths: string[];
  artifactDirectoryUnsafe: boolean;
} {
  const root = resolve(input.worktreePath);
  const artifactMedia = artifactMediaPaths(root);
  const riskyPaths: string[] = [];
  const nonReversiblePaths: string[] = [];
  const paths = [...input.changedPaths, ...artifactMedia.paths];
  for (const relative of new Set(paths)) {
    if (!RASTER_OUTPUT_EXTENSIONS.has(extname(relative).toLowerCase())) continue;
    const status = candidatePathStatus(root, relative);
    if (status.kind === "missing") continue;
    if (status.kind !== "safe" || !status.stat.isFile()) {
      riskyPaths.push(relative);
      // A text patch can represent the symlink or special-file directory
      // entry, but rollback cannot prove anything about bytes reached through
      // that entry. Never collapse it to a followed realpath identity.
      nonReversiblePaths.push(relative);
      continue;
    }
    const safe = rasterBytesIfSafe(status.path);
    if (!safe) riskyPaths.push(relative);
  }
  return {
    risky: artifactMedia.unsafe || riskyPaths.length > 0,
    riskyPaths,
    nonReversiblePaths,
    artifactDirectoryUnsafe: artifactMedia.unsafe,
  };
}

export function rasterLinksInMarkdown(markdown: string): string[] {
  const paths: string[] = [];
  for (const match of markdown.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
    const raw = match[1];
    if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("#")) continue;
    try {
      paths.push(decodeURIComponent(raw).replace(/^\.\//, ""));
    } catch {
      // Invalid URL escapes are not a usable file target.
    }
  }
  return [...new Set(paths)];
}

export function writeCandidateAttemptArtifacts(input: {
  store: ArtifactStore;
  attemptDir: string;
  worktreePath: string;
  diff: string;
  /** False for a secret-refused candidate: even an empty placeholder named
   * patch.diff would falsely imply that an inspectable patch was retained. */
  persistPatch?: boolean;
  /** False for a secret-refused candidate: no answer-adjacent or artifact-dir
   * media is retained, even when an individual raster is otherwise safe. */
  persistProducedMedia?: boolean;
  answerText?: string;
  record: Record<string, unknown>;
}): string[] {
  if (input.persistPatch !== false) {
    input.store.writeText(join(input.attemptDir, "patch.diff"), input.diff);
  }
  const stats = summarizeDiffPaths(input.diff);
  // Build one candidate path set before the first filesystem write. A raster
  // may be both linked from markdown and discovered under the owned artifact
  // directory; copying each source in a separate pass would race itself on the
  // O_EXCL destination and would incorrectly grant each pass its own byte cap.
  const produced =
    input.persistProducedMedia === false
      ? []
      : persistCandidateOutputs({
          worktreePath: input.worktreePath,
          attemptDir: input.attemptDir,
          changedPaths: [
            ...stats.paths,
            ...rasterLinksInMarkdown(input.answerText ?? ""),
            ...artifactMediaPaths(resolve(input.worktreePath)).paths,
          ],
        });
  input.store.writeYaml(join(input.attemptDir, "attempt.yaml"), {
    ...input.record,
    diffstat: {
      files: stats.paths.length,
      additions: stats.additions,
      deletions: stats.deletions,
    },
    produced_files: produced,
  });
  return produced;
}

/** Copy preserved winner outputs into the run root so relative markdown links
 * resolve under the UI's runDir scope after the envelope is gone. */
export function materializeWinnerOutputs(input: {
  attemptDir: string;
  runRoot: string;
  paths: readonly string[];
}): string[] {
  const copied: string[] = [];
  for (const relative of input.paths) {
    const source = join(input.attemptDir, "produced", relative);
    if (!existsSync(source)) continue;
    const target = join(input.runRoot, relative);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    copyFileSync(source, target);
    copied.push(relative);
  }
  return copied;
}

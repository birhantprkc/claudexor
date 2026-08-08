/**
 * Path-confinement guards for run-artifact reads: every artifact fetch must
 * resolve INSIDE the run/artifact root, symlinks are refused (a symlinked
 * artifact could read arbitrary host files into an HTTP response), and `..`
 * traversal is structurally impossible.
 *
 * The lstat→realpath windows here race concurrent tree mutation (git
 * atomic tmp-object renames in reviewer workspaces, reviewer-workspace
 * cleanup, retention deletion — GH #128). A path that vanishes mid-check IS
 * "no such artifact": both guards answer null, the same clean 404/refusal
 * every call site already maps null to. Only vanish errnos are tolerated;
 * everything else (EACCES/EPERM/EIO) stays loud. Deliberately NO existsSync
 * precheck: existsSync collapses every filesystem error into `false`, which
 * would silently convert an access error into null and falsify that loudness
 * contract — absence must come from the lstat errno itself.
 */
import { lstatSync, realpathSync } from "node:fs";
import { normalize, resolve, sep } from "node:path";

/** Errno-scoped vanish check for filesystem races: ENOENT/ENOTDIR mean the
 * path (or a parent that a directory component turned out not to be) stopped
 * existing mid-window — tolerable as "not there". Every other errno rethrows
 * so real trouble (EPERM/EIO) is never silently swallowed. */
export function isVanishedErrno(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

export function safeArtifactPath(root: string, requested: string): string | null {
  if (requested.includes("\0")) return null;
  const parts = requested.split(/[\\/]+/).filter(Boolean);
  if (parts.includes("..")) return null;
  const base = safeArtifactRoot(root);
  if (!base) return null;
  const clean = normalize(parts.join(sep));
  const abs = resolve(base, clean);
  try {
    const lst = lstatSync(abs);
    if (lst.isSymbolicLink()) return null;
    const real = realpathSync(abs);
    return real === base || real.startsWith(base + sep) ? real : null;
  } catch (err) {
    if (isVanishedErrno(err)) return null;
    throw err;
  }
}

export function safeArtifactRoot(root: string): string | null {
  if (!root) return null;
  try {
    const st = lstatSync(root);
    if (st.isSymbolicLink() || !st.isDirectory()) return null;
    return realpathSync(root);
  } catch (err) {
    if (isVanishedErrno(err)) return null;
    throw err;
  }
}

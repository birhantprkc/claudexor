import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { HarnessConfinement } from "@claudexor/schema";
import { sensitiveResourcePolicy, sha256 } from "@claudexor/util";
import { ConfinementUnavailableError } from "./errors.js";

/**
 * OS-enforced filesystem confinement for a delegated harness process.
 *
 * WHY THIS IS NOT AN ENV VAR. A scoped `HOME` redirects `~`-relative lookups
 * and nothing else; `/Users/<op>/.claudexor/v3/daemon/token` — a bearer for the
 * whole control API — stays one absolute path away. The threat model, the
 * live reproduction and the list of what this does NOT cover are in
 * docs/DELEGATED_CONFINEMENT.md; keep them in step with this file.
 *
 * WHY THE HARNESS SANDBOX STANDS DOWN. macOS refuses `sandbox_apply` inside an
 * already-restricted process (measured: any deny clause in the outer profile is
 * enough), and codex shells out to `/usr/bin/sandbox-exec` for its own
 * workspace-write sandbox. An outer boundary and the harness's own are
 * mutually exclusive, so the engine states `external_sandbox_full` — the
 * access profile that already means "I am providing the sandbox" — and each
 * adapter maps that onto its own switch. No harness name is branched on.
 */

const SEATBELT_BIN = "/usr/bin/sandbox-exec";

/** System prefixes a workspace-scoped run has no business writing to. */
const SYSTEM_WRITE_DENY = [
  "/usr",
  "/opt",
  "/Library",
  "/Applications",
  "/System",
  "/bin",
  "/sbin",
  "/etc",
  "/var",
] as const;

export interface ConfinementInput {
  /** The operator's REAL home — the thing the child must not be able to mine. */
  operatorHome: string;
  /** Claudexor's runtime tree: daemon token/socket, trust, every project's state. */
  runtimeRoot: string;
  /** Vendor credential state the harness itself authenticates out of (§8 carve-out). */
  nativeStateRoot: string;
  /** This attempt's scoped HOME. */
  scopedHome: string;
  /** This attempt's worktree (its cwd). */
  worktree: string;
  /** Scratch root the toolchain writes to; defaults to the process TMPDIR. */
  tmpDir?: string;
}

/** Whether an OS-enforced boundary exists on this host, and which one. */
export function confinementMechanism(
  platform: NodeJS.Platform = process.platform,
  binExists: (path: string) => boolean = existsSync,
): "seatbelt" | null {
  return platform === "darwin" && binExists(SEATBELT_BIN) ? "seatbelt" : null;
}

/**
 * Seatbelt matches RESOLVED paths (`/tmp` is `/private/tmp`), so a profile
 * written against the symlinked spelling silently allows what it names.
 * Resolution falls back to the literal for a path that does not exist yet —
 * a deny on a not-yet-created path is still worth emitting.
 */
function resolved(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/** Whether `root` is `path` or an ancestor of it, after resolution. */
function contains(root: string, path: string): boolean {
  const rel = relative(resolved(root), resolved(path));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel));
}

function subpath(paths: readonly string[]): string {
  return paths.map((path) => `(subpath ${JSON.stringify(resolved(path))})`).join(" ");
}

/**
 * The paths this profile must make unreadable. Also the probe surface: the
 * boundary is verified by trying to read the FIRST of them.
 */
export function confinementDeniedReadPaths(input: ConfinementInput): string[] {
  return [
    join(input.runtimeRoot, "daemon"),
    input.runtimeRoot,
    ...sensitiveResourcePolicy
      .homeRelativeCredentialEntries()
      .map((entry) => join(input.operatorHome, entry)),
  ];
}

/** SBPL text for one attempt. Last match wins, so the carve-outs follow the denies. */
export function buildConfinementProfile(input: ConfinementInput): string {
  const scratch = input.tmpDir ?? process.env.TMPDIR ?? "/tmp";
  const ownRoots = [input.scopedHome, input.worktree, input.nativeStateRoot];
  // SBPL is last-match-wins, and the order below is the policy. The scratch
  // allow sits ABOVE the operator-home deny on purpose: a `TMPDIR` configured
  // inside `$HOME` would otherwise re-open the whole home for writing. The run's
  // own roots come last because they outrank every deny above them, including
  // the case where the worktree lives inside the operator's home (isolation:
  // live, which is exactly the delegated shape).
  return [
    "(version 1)",
    "(allow default)",
    `(deny file-read* ${subpath(confinementDeniedReadPaths(input))})`,
    `(deny file-write* ${subpath([...SYSTEM_WRITE_DENY])})`,
    `(allow file-write* ${subpath([scratch, "/tmp"])})`,
    `(deny file-write* ${subpath([input.operatorHome])})`,
    `(allow file-read* file-write* ${subpath(ownRoots)})`,
    "",
  ].join("\n");
}

/**
 * Prove the profile denies, on THIS host, before the harness runs under it.
 *
 * A profile that fails to compile, or that a future macOS quietly stops
 * enforcing, would otherwise produce a run that reports `confined` and is not.
 * The probe reads a path the profile denies and requires the read to fail —
 * one ~30ms exec per attempt for an applied fact instead of an intention.
 */
export function verifyConfinementProfile(
  profile: string,
  probePath: string,
  run: (bin: string, args: string[]) => { status: number | null; stderr?: string } = (bin, args) =>
    spawnSync(bin, args, { encoding: "utf8", timeout: 15_000 }),
): void {
  // CONTROL first. A probe path that is simply absent fails the confined read
  // for the wrong reason, and the profile would be "proven" by an ENOENT.
  const control = run("/bin/ls", [probePath]);
  if (control.status !== 0) {
    throw new ConfinementUnavailableError(
      `filesystem confinement could not be verified: the probe path ${probePath} is not readable even unconfined, so a denial there proves nothing`,
    );
  }
  const probe = run(SEATBELT_BIN, ["-p", profile, "/bin/ls", probePath]);
  if (probe.status === 0) {
    throw new ConfinementUnavailableError(
      `filesystem confinement did not take effect: ${probePath} stayed readable under the seatbelt profile`,
    );
  }
  if (probe.status === null) {
    throw new ConfinementUnavailableError(
      `filesystem confinement could not be verified: the seatbelt probe did not complete${probe.stderr ? ` (${probe.stderr.trim().slice(0, 200)})` : ""}`,
    );
  }
}

/**
 * Build, verify and describe the boundary for one attempt.
 *
 * Refuses rather than degrading: a caller that asked for a confined run and got
 * an unconfined one has no way to tell from the outside, which is exactly the
 * failure this whole mechanism exists to remove.
 */
export function applyConfinement(
  input: ConfinementInput,
  platform: NodeJS.Platform = process.platform,
): HarnessConfinement {
  if (confinementMechanism(platform) === null) {
    throw new ConfinementUnavailableError(
      `no OS-enforced filesystem confinement is available on ${platform}; a delegated mutating run cannot be confined here`,
    );
  }
  const denied = confinementDeniedReadPaths(input);
  // The carve-outs are last-match-wins, so an "own root" that CONTAINS a denied
  // path silently re-opens it. Refuse rather than emit a policy that reads like
  // a boundary and is not.
  const ownRoots = [input.scopedHome, input.worktree, input.nativeStateRoot];
  const swallowed = ownRoots.find((root) =>
    denied.some((path) => path !== root && contains(root, path)),
  );
  if (swallowed) {
    throw new ConfinementUnavailableError(
      `filesystem confinement would be self-defeating: the allowed root ${swallowed} contains a path the policy must deny`,
    );
  }
  const profile = buildConfinementProfile(input);
  const probeCandidate = denied.find((path) => existsSync(path));
  if (!probeCandidate) {
    throw new ConfinementUnavailableError(
      "filesystem confinement could not be verified: none of the denied paths exists on this host, so the policy cannot be proven to deny anything",
    );
  }
  const probePath = resolved(probeCandidate);
  verifyConfinementProfile(profile, probePath);
  return {
    mechanism: "seatbelt",
    profile,
    profile_digest: sha256(profile),
    verified_denied_path: probePath,
  };
}

/** Rewrite an argv so the child (and every descendant) starts inside the boundary. */
export function confinedInvocation(
  confinement: HarnessConfinement | null | undefined,
  bin: string,
  args: readonly string[],
): { bin: string; args: string[] } {
  if (!confinement) return { bin, args: [...args] };
  return { bin: SEATBELT_BIN, args: ["-p", confinement.profile, bin, ...args] };
}

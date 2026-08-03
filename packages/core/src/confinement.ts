import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
 * adapter maps that onto its own switch. No harness name is branched on. That
 * stand-down is spent ONLY where a boundary was actually proven available: a
 * host with none keeps whatever enforcement the harness brings itself.
 *
 * WHERE THERE IS NO BOUNDARY. The run still runs. It does not pretend: the
 * absence and its reason are recorded on the attempt, told to the child, and
 * returned to the caller. Refusing on a platform we have not implemented would
 * make "delegated" a macOS-only feature; claiming a boundary we did not prove
 * would be worse than having none, so the type below cannot express a
 * mechanism name without the path it was proven to deny.
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

/**
 * The host the boundary is being applied ON. Injectable so the platform
 * branches are TESTABLE without booting that platform: the availability probe
 * and every exec go through here.
 */
export interface ConfinementHost {
  platform: NodeJS.Platform;
  exists(path: string): boolean;
  run(bin: string, args: readonly string[]): { status: number | null; stderr?: string };
}

const DEFAULT_HOST: ConfinementHost = {
  platform: process.platform,
  exists: existsSync,
  run: (bin, args) => spawnSync(bin, [...args], { encoding: "utf8", timeout: 15_000 }),
};

/**
 * One OS mechanism that can enforce the policy.
 *
 * `id` is the opaque label written to the attempt record. Nothing outside this
 * file may branch on it — the registry lookup in `confinedInvocation` is the
 * single place a mechanism's name selects behaviour, and every consumer above
 * asks only whether a proven boundary exists.
 */
interface ConfinementMechanism {
  readonly id: string;
  readonly platform: NodeJS.Platform;
  /** Candidate absolute paths for the enforcing binary; first that exists wins. */
  readonly bins: readonly string[];
  /** The policy for one attempt, in this mechanism's own encoding. */
  buildProfile(input: ConfinementInput, bin: string): string;
  /** Rewrite an argv so the child (and every descendant) starts inside the boundary. */
  invocation(
    profile: string,
    bin: string,
    args: readonly string[],
  ): { bin: string; args: string[] };
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

/** The run's own roots: allowed, and the reason the deny set needs carve-outs. */
function ownRoots(input: ConfinementInput): string[] {
  return [input.scopedHome, input.worktree, input.nativeStateRoot];
}

/** macOS: kernel-enforced per-path denial for the process and every descendant. */
const SEATBELT: ConfinementMechanism = {
  id: "seatbelt",
  platform: "darwin",
  bins: [SEATBELT_BIN],
  /** SBPL text. Last match wins, so the carve-outs follow the denies. */
  buildProfile(input) {
    const scratch = input.tmpDir ?? process.env.TMPDIR ?? "/tmp";
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
      `(allow file-read* file-write* ${subpath(ownRoots(input))})`,
      "",
    ].join("\n");
  },
  invocation(profile, bin, args) {
    return { bin: SEATBELT_BIN, args: ["-p", profile, bin, ...args] };
  },
};

/**
 * Linux: bubblewrap. A mount namespace that binds the whole host filesystem and
 * then mounts an empty tmpfs OVER each denied path, so the contents are not
 * reachable by any spelling. bwrap drops every capability before exec, so the
 * child cannot unmount what the namespace's owner mounted.
 *
 * The policy is the exact argv prefix, JSON-encoded — a mechanism whose policy
 * is not text still records the thing the process was actually started under,
 * which is what the digest is for.
 */
const BUBBLEWRAP: ConfinementMechanism = {
  id: "bubblewrap",
  platform: "linux",
  bins: ["/usr/bin/bwrap", "/bin/bwrap", "/usr/local/bin/bwrap"],
  buildProfile(input, bin) {
    const denied = confinementDeniedReadPaths(input).map(resolved);
    const argv = [bin, "--dev-bind", "/", "/"];
    // Every denied path, whether or not it exists yet: bwrap creates the
    // mountpoint inside the namespace, so a credential store the child creates
    // later lands on the tmpfs rather than escaping the policy.
    for (const path of denied) argv.push("--tmpfs", path);
    // Re-expose ONLY what a deny above would otherwise swallow — the scoped
    // home and the vendor credential root both live inside the runtime tree.
    for (const root of ownRoots(input).map(resolved)) {
      if (denied.some((path) => path !== root && contains(path, root))) {
        argv.push("--bind", root, root);
      }
    }
    return JSON.stringify(argv);
  },
  invocation(profile, bin, args) {
    const argv = JSON.parse(profile) as string[];
    return { bin: argv[0], args: [...argv.slice(1), bin, ...args] };
  },
};

const MECHANISMS: readonly ConfinementMechanism[] = [SEATBELT, BUBBLEWRAP];

/** Kept for the seam tests and the docs: the macOS policy text for one attempt. */
export function buildConfinementProfile(input: ConfinementInput): string {
  return SEATBELT.buildProfile(input, SEATBELT_BIN);
}

/** Read `probePath` from inside the policy, the way the harness child would. */
function readUnder(
  mechanism: ConfinementMechanism,
  profile: string,
  probePath: string,
  host: ConfinementHost,
): { status: number | null; stderr?: string } {
  const invocation = mechanism.invocation(profile, "/bin/ls", [probePath]);
  return host.run(invocation.bin, invocation.args);
}

/**
 * Prove the policy denies, on THIS host, before anything runs under it.
 *
 * Returns the reason it could NOT be proven, or null when it was. A policy that
 * fails to compile, or that a future OS quietly stops enforcing, would
 * otherwise produce a run that reports `confined` and is not.
 */
function proveConfinementDenial(
  mechanism: ConfinementMechanism,
  profile: string,
  probePath: string,
  host: ConfinementHost,
): string | null {
  // CONTROL first. A probe path that is simply absent fails the confined read
  // for the wrong reason, and the policy would be "proven" by an ENOENT.
  if (host.run("/bin/ls", [probePath]).status !== 0) {
    return `the probe path ${probePath} is not readable even unconfined, so a denial there proves nothing`;
  }
  const probe = readUnder(mechanism, profile, probePath, host);
  if (probe.status === 0) return `${probePath} stayed readable under the ${mechanism.id} policy`;
  if (probe.status === null) {
    const detail = probe.stderr ? ` (${probe.stderr.trim().slice(0, 200)})` : "";
    return `the ${mechanism.id} probe did not complete${detail}`;
  }
  return null;
}

/** A throwaway operator layout, shaped like the real one, for the self-test. */
function selfTestScaffold(base: string): ConfinementInput {
  const operatorHome = join(base, "home");
  const runtimeRoot = join(operatorHome, ".claudexor");
  const nativeStateRoot = join(runtimeRoot, "native");
  const scopedHome = join(runtimeRoot, "projects", "probe", "home");
  const worktree = join(operatorHome, "project");
  for (const dir of [join(runtimeRoot, "daemon"), nativeStateRoot, scopedHome, worktree]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(runtimeRoot, "daemon", "token"), "probe");
  writeFileSync(join(nativeStateRoot, "auth.json"), "{}");
  return { operatorHome, runtimeRoot, nativeStateRoot, scopedHome, worktree };
}

/**
 * Does this mechanism actually work HERE — not "is its binary installed".
 *
 * The two questions differ per platform and the difference is the whole point.
 * `sandbox-exec` present is a reliable oracle for Seatbelt; `bwrap` present is
 * NOT one for bubblewrap, because a distro can disable unprivileged user
 * namespaces and leave the binary in place. So the oracle is the mechanism's
 * own shape, executed: a denied path must be denied AND the carve-out nested
 * inside it must survive. Both halves matter — a boundary that also severs the
 * vendor credential root is a capability regression, not a fix, and it must
 * count as "no boundary here" rather than ship silently.
 */
function selfTest(
  mechanism: ConfinementMechanism,
  bin: string,
  host: ConfinementHost,
): string | null {
  const base = mkdtempSync(join(tmpdir(), "cxi-confine-probe-"));
  try {
    const input = selfTestScaffold(base);
    const profile = mechanism.buildProfile(input, bin);
    const denial = proveConfinementDenial(
      mechanism,
      profile,
      resolved(join(input.runtimeRoot, "daemon")),
      host,
    );
    if (denial) return denial;
    // A FILE inside the carve-out, never the directory: a mechanism that
    // re-exposed an EMPTY mount over the vendor credential root would let a
    // readable-but-empty directory pass for a working carve-out.
    const keep = resolved(join(input.nativeStateRoot, "auth.json"));
    if (readUnder(mechanism, profile, keep, host).status !== 0) {
      return "the policy also cut off the carve-outs the run needs (the vendor credential root nested inside the denied runtime tree came back unreadable)";
    }
    return null;
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

/** Whether an OS-enforced boundary can be applied on this host, and why not. */
type ConfinementAvailability =
  | { mechanism: ConfinementMechanism; bin: string; reason: null }
  | { mechanism: null; bin: null; reason: string };

function probeAvailability(host: ConfinementHost): ConfinementAvailability {
  const mechanism = MECHANISMS.find((candidate) => candidate.platform === host.platform);
  if (!mechanism) {
    return {
      mechanism: null,
      bin: null,
      reason: `no OS-enforced filesystem boundary is implemented for ${host.platform}`,
    };
  }
  const bin = mechanism.bins.find((candidate) => host.exists(candidate));
  if (!bin) {
    return {
      mechanism: null,
      bin: null,
      reason: `${host.platform} can enforce a boundary with ${mechanism.id}, but it is not installed here (looked for ${mechanism.bins.join(", ")})`,
    };
  }
  const why = selfTest(mechanism, bin, host);
  if (why) {
    return {
      mechanism: null,
      bin: null,
      reason: `${mechanism.id} is installed on this ${host.platform} host but did not enforce: ${why}`,
    };
  }
  return { mechanism, bin, reason: null };
}

let cachedAvailability: ConfinementAvailability | null = null;

/**
 * Whether an OS-enforced boundary exists on this host, and which one.
 *
 * Memoized for the real host only — the probe execs, and neither the platform
 * nor the installed mechanism changes inside one daemon process. An INJECTED
 * host is always probed fresh, so a test can drive every branch.
 */
function confinementMechanism(host: ConfinementHost): ConfinementAvailability {
  if (host !== DEFAULT_HOST) return probeAvailability(host);
  cachedAvailability ??= probeAvailability(host);
  return cachedAvailability;
}

/**
 * The one question a caller outside this file may ask about the host.
 *
 * Deliberately NOT "which mechanism": the routing decision that depends on this
 * — whether to tell the adapter to stand its own sandbox down — turns on
 * whether Claudexor will actually provide a boundary, never on which one or on
 * the platform's name.
 */
export function confinementBoundaryAvailable(host: ConfinementHost = DEFAULT_HOST): {
  available: boolean;
  reason: string | null;
} {
  const availability = confinementMechanism(host);
  return { available: availability.mechanism !== null, reason: availability.reason };
}

/** What one attempt's boundary turned out to be: applied, or absent and why. */
export interface ConfinementOutcome {
  /** The APPLIED boundary, or null when this host has none. */
  confinement: HarnessConfinement | null;
  /** Why no boundary was applied; null exactly when one was. */
  unavailableReason: string | null;
}

/**
 * Build, verify and describe the boundary for one attempt.
 *
 * Degrades HONESTLY where the platform offers nothing — the run proceeds and
 * the outcome carries the reason, which the caller writes onto the attempt,
 * into the child's prompt and into its own result. It never degrades SILENTLY,
 * and it never names a mechanism it did not just prove on this host.
 *
 * Still refuses for the two conditions that are Claudexor's own fault rather
 * than the platform's: an allowed root that swallows a denied one, and a policy
 * that a working mechanism failed to enforce for this attempt.
 */
export function applyConfinement(
  input: ConfinementInput,
  host: ConfinementHost = DEFAULT_HOST,
): ConfinementOutcome {
  const available = confinementMechanism(host);
  if (!available.mechanism) return { confinement: null, unavailableReason: available.reason };
  const denied = confinementDeniedReadPaths(input);
  // The carve-outs re-open whatever they contain, so an "own root" that CONTAINS
  // a denied path silently defeats the policy. Refuse rather than emit one that
  // reads like a boundary and is not.
  const swallowed = ownRoots(input).find((root) =>
    denied.some((path) => path !== root && contains(root, path)),
  );
  if (swallowed) {
    throw new ConfinementUnavailableError(
      `filesystem confinement would be self-defeating: the allowed root ${swallowed} contains a path the policy must deny`,
    );
  }
  const profile = available.mechanism.buildProfile(input, available.bin);
  const probeCandidate = denied.find((path) => host.exists(path));
  if (!probeCandidate) {
    throw new ConfinementUnavailableError(
      "filesystem confinement could not be verified: none of the denied paths exists on this host, so the policy cannot be proven to deny anything",
    );
  }
  const probePath = resolved(probeCandidate);
  const why = proveConfinementDenial(available.mechanism, profile, probePath, host);
  if (why) throw new ConfinementUnavailableError(`filesystem confinement failed: ${why}`);
  return {
    confinement: {
      mechanism: available.mechanism.id,
      profile,
      profile_digest: sha256(profile),
      verified_denied_path: probePath,
    },
    unavailableReason: null,
  };
}

/** Rewrite an argv so the child (and every descendant) starts inside the boundary. */
export function confinedInvocation(
  confinement: HarnessConfinement | null | undefined,
  bin: string,
  args: readonly string[],
): { bin: string; args: string[] } {
  if (!confinement) return { bin, args: [...args] };
  const mechanism = MECHANISMS.find((candidate) => candidate.id === confinement.mechanism);
  if (!mechanism) {
    // The record names a boundary this engine cannot apply. Spawning unwrapped
    // would run the child outside the boundary its own record claims.
    throw new ConfinementUnavailableError(
      `the attempt records confinement mechanism '${confinement.mechanism}', which this engine cannot apply`,
    );
  }
  return mechanism.invocation(confinement.profile, bin, args);
}

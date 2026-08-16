import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { HarnessConfinement } from "@claudexor/schema";
import { sensitiveResourcePolicy, sha256 } from "@claudexor/util";
import { ConfinementUnavailableError } from "./errors.js";
import { managedNodeRoot } from "./runtime-env.js";

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
 * WHERE THERE IS NO BOUNDARY — every platform but macOS, by owner decision, and
 * a macOS host missing `sandbox-exec`. The run still runs, on the scoped `HOME`
 * alone. It does not pretend: the absence and its reason are recorded on the
 * attempt, told to the child, and returned to the caller. Refusing instead would
 * make "delegated" a macOS-only feature; claiming a boundary we did not prove
 * would be worse than having none, so the type below cannot express a mechanism
 * name without the path it was proven to deny.
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

function literal(paths: readonly string[]): string {
  return paths.map((path) => `(literal ${JSON.stringify(resolved(path))})`).join(" ");
}

/**
 * The strict ancestors of the run's OWN roots that lie INSIDE the denied
 * runtime root: for each own root, `dirname(root)` walking up to and including
 * `runtimeRoot` itself, deduplicated in first-encounter order.
 *
 * WHY THESE NEED A METADATA CARVE-OUT. Path canonicalization — libc
 * `realpath(3)`, Rust `fs::canonicalize`, SQLite's unix VFS full-path
 * resolution — lstat/readlinks every intermediate path component. The
 * own-roots allow re-opens each root's SUBTREE, but the components BETWEEN
 * the runtime root and the root still match the runtime-root read deny, so
 * the walk dies with EPERM before the harness runs a single turn. Measured
 * live on two different own roots: codex canonicalizes its CODEX_HOME under
 * the native state root at startup (2026-08-10, `failed to canonicalize
 * CODEX_HOME`), and cursor-agent opens its SQLite chat store under the scoped
 * HOME, whose open canonicalizes the database path (2026-08-15,
 * `RetriableError: [internal] unable to open database file`, SQLITE_CANTOPEN,
 * 100% of mutating delegated cursor runs). These directories get
 * `file-read-metadata` on the LITERAL path only: stat/readlink of the
 * directory entry itself, never the data of any file under the runtime root
 * and never a directory listing (readdir is a data read on the directory).
 */
function ownRootTraversalAncestors(input: ConfinementInput): string[] {
  const root = resolved(input.runtimeRoot);
  const chain: string[] = [];
  for (const ownRoot of ownRoots(input)) {
    let current = dirname(resolved(ownRoot));
    // An already-collected ancestor proves the rest of its chain up to the
    // runtime root was collected with it, so the walk can stop there.
    while (contains(root, current) && !chain.includes(current)) {
      chain.push(current);
      if (current === root) break;
      const parent = dirname(current);
      if (parent === current) break; // filesystem root; cannot ascend further
      current = parent;
    }
  }
  return chain;
}

/**
 * The managed toolchain subtree (`<operator home>/.claudexor/node` — the Node
 * distribution plus the pinned vendor CLI shims), WHEN it lies inside the
 * denied runtime root. Null when it does not — nothing denies it there, so a
 * carve-out would be a no-op, mirroring the own-roots traversal pattern above.
 *
 * WHY THIS NEEDS A READ+EXEC CARVE-OUT. In the DEFAULT layout the runtime
 * root IS `~/.claudexor`, so the very binaries the spawn layer resolves for
 * the child (`~/.claudexor/node/bin/codex`, the `node` that runs them, their
 * `lib/node_modules` payloads) sit inside the read-denied tree — and exec IS
 * a read: the kernel refuses execvp of a binary the profile makes unreadable.
 * Measured live in the 3.3.15 VM battery (default config, phase 13):
 * `sandbox-exec: execvp() of '<runtime root>/node/bin/codex' failed:
 * Operation not permitted`, exit 71, before the harness ran an instruction.
 * The development-host smoke missed it because scratch mode relocates the
 * config root, putting the toolchain outside the denied tree.
 *
 * The subtree holds no secrets (a Node distribution and CLI shims), so it
 * gets a full `file-read*` allow — data, metadata and listings — which is
 * what execvp, `#!/usr/bin/env node` shim resolution and the CLI's own
 * resource loads need. It does NOT re-open writes: the later operator-home
 * write deny still covers the toolchain, so a confined child cannot trojan
 * the shims the operator's own daemon executes. The path is derived from the
 * same helper the launcher's PATH producer uses (`managedNodeRoot`), keyed on
 * the operator home — the anchor `composeBaseEnv` resolves binaries against —
 * so the profile and the spawn layer cannot drift apart.
 */
function managedToolchainSubtree(input: ConfinementInput): string | null {
  const toolchain = managedNodeRoot(input.operatorHome);
  return contains(input.runtimeRoot, toolchain) ? toolchain : null;
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
    const traversal = ownRootTraversalAncestors(input);
    const toolchain = managedToolchainSubtree(input);
    // SBPL is last-match-wins, and the order below is the policy. The scratch
    // allow sits ABOVE the operator-home deny on purpose: a `TMPDIR` configured
    // inside `$HOME` would otherwise re-open the whole home for writing. The run's
    // own roots come last because they outrank every deny above them, including
    // the case where the worktree lives inside the operator's home (isolation:
    // live, which is exactly the delegated shape). The two read carve-outs sit
    // directly AFTER the read deny they punch through, and BEFORE the write
    // section so neither can outrank a write deny: literal-only stat/readlink
    // on the own roots' intermediate directories, so `realpath(CODEX_HOME)` and
    // cursor's SQLite open under the scoped HOME work while file data and
    // directory listings under the runtime root stay denied (see
    // ownRootTraversalAncestors); then a full read allow on the
    // managed toolchain subtree, so the child can exec the very binaries the
    // spawn layer resolved for it (see managedToolchainSubtree). Writes to the
    // toolchain stay denied by the operator-home deny below.
    return [
      "(version 1)",
      "(allow default)",
      `(deny file-read* ${subpath(confinementDeniedReadPaths(input))})`,
      ...(traversal.length ? [`(allow file-read-metadata ${literal(traversal)})`] : []),
      ...(toolchain ? [`(allow file-read* ${subpath([toolchain])})`] : []),
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
 * The registry. ONE mechanism today, by owner decision: Seatbelt on macOS, and
 * NO kernel boundary anywhere else. Linux bubblewrap/Landlock and a Windows
 * equivalent were considered and declined — see docs/DELEGATED_CONFINEMENT.md §6.
 * Non-macOS is served by the scoped HOME plus a disclosed, typed absence, which
 * is what the rest of this file and the delegated terminal are shaped around.
 *
 * The list stays a list because the mechanism id is OPAQUE end to end: the only
 * place a name selects behaviour is the lookup in `confinedInvocation`.
 */
const MECHANISMS: readonly ConfinementMechanism[] = [SEATBELT];

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

/** A trimmed, bounded stderr tail for a probe's failure reason. */
function describeProbeFault(stderr: string | undefined): string {
  return stderr && stderr.trim() ? ` (${stderr.trim().slice(0, 200)})` : "";
}

/**
 * stderr signatures of the SANDBOX ITSELF failing to launch or apply the
 * profile — a refused `sandbox_apply`, a profile that would not compile/parse —
 * as opposed to the wrapped program running and hitting a real policy deny.
 * `sandbox-exec` prefixes its OWN failures with `sandbox-exec:` and never runs
 * the wrapped tool; a denied read instead surfaces from the tool itself
 * (`ls: <path>: Operation not permitted`). A nonzero exit carrying one of these
 * is infrastructure, not proof.
 */
const SANDBOX_APPLICATION_FAULT_RE =
  /sandbox-exec:|sandbox_apply|sandbox_compile|failed to (parse|compile|apply|initialize)|could not (parse|compile)|error parsing/i;

function isSandboxApplicationFault(stderr: string | undefined): boolean {
  return typeof stderr === "string" && SANDBOX_APPLICATION_FAULT_RE.test(stderr);
}

/**
 * Prove the policy denies, on THIS host, before anything runs under it.
 *
 * Returns the reason it could NOT be proven, or null when it was. A policy that
 * fails to compile, that a launcher refuses to apply, or that a future OS
 * quietly stops enforcing, would otherwise produce a run that records a false
 * `verified_denied_path` and reports `confined` when it is not.
 *
 * Three guards, because a nonzero exit alone means nothing:
 *   NEGATIVE control — the denied path must be readable UNCONFINED, or an
 *     ENOENT there would masquerade as a policy deny.
 *   POSITIVE control — an ALLOWED path must stay readable UNDER the sandbox. If
 *     it does not, the sandbox never applied (failed `sandbox_apply`, a profile
 *     that would not compile), so any subsequent "deny" is the launcher
 *     failing, not the policy denying. This is the guard the audit was missing.
 *   FAULT discrimination — even with the sandbox applied, a nonzero exit whose
 *     stderr is a launch/application fault, or that never completed, is never
 *     recorded as proof. Only an explained nonzero (positive control passed, no
 *     fault signature, path proven readable unconfined) is a real deny.
 */
function proveConfinementDenial(
  mechanism: ConfinementMechanism,
  profile: string,
  probePath: string,
  allowedControlPaths: readonly string[],
  host: ConfinementHost,
): string | null {
  // NEGATIVE CONTROL.
  if (host.run("/bin/ls", [probePath]).status !== 0) {
    return `the probe path ${probePath} is not readable even unconfined, so a denial there proves nothing`;
  }

  // POSITIVE CONTROL. Pick an allowed path that is readable unconfined, then
  // require it to STAY readable under the sandbox. A failure here is the sandbox
  // not applying, not the policy working.
  const control = allowedControlPaths
    .map((path) => resolved(path))
    .find((path) => host.run("/bin/ls", [path]).status === 0);
  if (!control) {
    return `no allowed control path was readable unconfined, so the ${mechanism.id} sandbox application could not be confirmed`;
  }
  const positive = readUnder(mechanism, profile, control, host);
  if (positive.status !== 0) {
    return `the ${mechanism.id} sandbox did not apply: the allowed control path ${control} was not readable under it${describeProbeFault(positive.stderr)}`;
  }

  // THE TEST: the denied path must now be denied under the proven-applied sandbox.
  const probe = readUnder(mechanism, profile, probePath, host);
  if (probe.status === 0) return `${probePath} stayed readable under the ${mechanism.id} policy`;
  if (isSandboxApplicationFault(probe.stderr)) {
    return `the ${mechanism.id} probe hit a sandbox application fault, not a policy deny${describeProbeFault(probe.stderr)}`;
  }
  if (probe.status === null) {
    return `the ${mechanism.id} probe did not complete${describeProbeFault(probe.stderr)}`;
  }
  return null;
}

/** Whether an OS-enforced boundary can be applied on this host, and why not. */
type ConfinementAvailability =
  | { mechanism: ConfinementMechanism; bin: string; reason: null }
  | { mechanism: null; bin: null; reason: string };

/**
 * Whether an OS-enforced boundary exists on this host, and which one.
 *
 * A platform with no mechanism is a DECISION, not a gap to be discovered at
 * spawn time, so the answer is a stated reason rather than a throw. Nothing here
 * hunts for a boundary the owner declined to build: the question is only whether
 * THIS platform's declared mechanism is present.
 */
function confinementMechanism(host: ConfinementHost): ConfinementAvailability {
  const mechanism = MECHANISMS.find((candidate) => candidate.platform === host.platform);
  if (!mechanism) {
    return {
      mechanism: null,
      bin: null,
      reason: `Claudexor applies no OS-enforced filesystem boundary on ${host.platform}; only macOS has one`,
    };
  }
  const bin = mechanism.bins.find((candidate) => host.exists(candidate));
  if (!bin) {
    return {
      mechanism: null,
      bin: null,
      reason: `${host.platform} enforces a boundary with ${mechanism.id}, which is not installed here (looked for ${mechanism.bins.join(", ")})`,
    };
  }
  return { mechanism, bin, reason: null };
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
 * Still refuses for the three conditions that are Claudexor's own layout or
 * this host's rather than the platform's: an allowed root that swallows a
 * denied one, a host where no denied path exists so nothing can be proven
 * denied, and a policy that a working mechanism failed to enforce for this
 * attempt.
 */
export function applyConfinement(
  input: ConfinementInput,
  host: ConfinementHost = DEFAULT_HOST,
): ConfinementOutcome {
  const denied = confinementDeniedReadPaths(input);
  // The carve-outs re-open whatever they contain, so an "own root" that CONTAINS
  // a denied path silently defeats the policy. This contradiction is Claudexor's
  // own layout being wrong, not a platform fact, so it is refused BEFORE the
  // host is asked whether it can enforce anything: a host with no boundary must
  // not turn a self-defeating policy into a quiet scoped-HOME run. Refuse rather
  // than emit one that reads like a boundary and is not.
  const swallowed = ownRoots(input).find((root) =>
    denied.some((path) => path !== root && contains(root, path)),
  );
  if (swallowed) {
    throw new ConfinementUnavailableError(
      `filesystem confinement would be self-defeating: the allowed root ${swallowed} contains a path the policy must deny`,
    );
  }
  const available = confinementMechanism(host);
  if (!available.mechanism) return { confinement: null, unavailableReason: available.reason };
  const profile = available.mechanism.buildProfile(input, available.bin);
  const probeCandidate = denied.find((path) => host.exists(path));
  if (!probeCandidate) {
    throw new ConfinementUnavailableError(
      "filesystem confinement could not be verified: none of the denied paths exists on this host, so the policy cannot be proven to deny anything",
    );
  }
  const probePath = resolved(probeCandidate);
  // The run's own allow-listed roots double as the positive-control surface:
  // one of them staying readable under the sandbox is what proves the profile
  // actually applied before any denial is credited.
  const why = proveConfinementDenial(
    available.mechanism,
    profile,
    probePath,
    ownRoots(input),
    host,
  );
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

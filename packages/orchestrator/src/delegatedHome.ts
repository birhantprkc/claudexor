import { existsSync } from "node:fs";
import type { ConfinementHost } from "@claudexor/core";
import {
  applyConfinement,
  confinementBoundaryAvailable,
  DelegatedEvidenceIncompleteError,
  DelegatedHomeUnavailableError,
} from "@claudexor/core";
import type { AccessProfile, HarnessConfinement, WorkspaceEnvelope } from "@claudexor/schema";
import { confinementBoundaryProven } from "@claudexor/schema";
import { claudexorOwnedRoot, nativeHarnessStateRoot, userHomeDir } from "@claudexor/util";
import type { WorkspaceManager } from "@claudexor/workspace";

/** What one attempt's harness HOME actually resolved to, and whether it is scoped. */
export interface ScopedHarnessHome {
  /** Env patch to spread onto the harness spec; absent when the attempt inherits the operator's env. */
  env?: Record<string, string>;
  /** Applied fact, recorded on the attempt so the caller can verify rather than trust. */
  isolated: boolean;
  /** The scoped home directory, or null when the attempt inherits the operator's. */
  homeDir: string | null;
  /** The APPLIED OS boundary, or null when this attempt runs without one. */
  confinement: HarnessConfinement | null;
  /**
   * Why this attempt got NO boundary, when it asked for one and the host had
   * none. Null both when a boundary WAS applied and when none was ever asked
   * for — an ordinary run is not "unconfined", it is out of scope, and the
   * terminal gate below depends on being able to tell those apart.
   */
  confinementUnavailableReason: string | null;
}

/** Access profiles under which the harness can modify the filesystem. */
export function isMutatingAccess(access: AccessProfile): boolean {
  return access !== "readonly";
}

/**
 * Whether this run's lanes should be told to stand their own sandbox down.
 *
 * Only a delegated run asks for an engine-provided boundary, and only a host
 * that can actually provide one earns the trade. Telling a harness to drop its
 * native sandbox where Claudexor will NOT replace it is a pure loss — strictly
 * worse than never having asked — so the two conditions are one expression
 * rather than a flag the caller passes and a check nobody makes.
 */
export function externallyConfinedLane(delegated: boolean, host?: ConfinementHost): boolean {
  return delegated && confinementBoundaryAvailable(host).available;
}

/** Roots the confinement is drawn against; overridable so tests never touch the real home. */
export interface ConfinementRoots {
  operatorHome: string;
  runtimeRoot: string;
  nativeStateRoot: string;
}

export function defaultConfinementRoots(): ConfinementRoots {
  return {
    operatorHome: userHomeDir(),
    runtimeRoot: claudexorOwnedRoot(),
    nativeStateRoot: nativeHarnessStateRoot(),
  };
}

/**
 * Decide the harness HOME and the OS boundary one attempt runs under.
 *
 * Unchanged for ordinary runs: an ISOLATED envelope gets the envelope's scoped
 * home, while an IN-PLACE attempt deliberately inherits the operator's native
 * environment so a harness whose native session store hangs off `$HOME` can
 * resume its vendor conversation.
 *
 * A DELEGATED run (`execution.delegated`) is scoped either way, and that is a
 * BEHAVIORAL CHANGE against that deliberate design — live + agent is exactly
 * the configuration a delegated mutating subagent uses. It is taken knowingly:
 * the caller is a machine orchestrator that owns the workspace, and the
 * operator's real `$HOME` holds material no delegated harness may read, above
 * all `~/.claudexor/v3/daemon/token`, which grants the entire control API.
 *
 * THE SCOPED HOME IS NOT THE BOUNDARY. It redirects `~`-relative lookups and
 * nothing more; the token above is one absolute path away, and a live probe
 * read it out of an ordinary `workspace_write` agent run. So a delegated
 * MUTATING attempt additionally gets an OS-ENFORCED boundary
 * (`applyConfinement`), verified against a path it denies before the harness is
 * spawned. A delegated READ-ONLY attempt keeps the harness's own read-only
 * enforcement instead: confinement stands that enforcement down (macOS refuses
 * nested sandboxes), which would be a net loss where there is no shell to
 * confine.
 *
 * WHERE THE HOST HAS NO BOUNDARY the attempt still runs, and says so: the
 * reason travels onto the attempt record, into the child's prompt and into the
 * caller's result. A delegated run that refused on every platform Claudexor has
 * not implemented a mechanism for would be a macOS-only feature wearing a
 * general name.
 *
 * THE COST of the scoped home, stated plainly: an in-place delegated attempt
 * CANNOT resume a native vendor session whose store lives under the real `$HOME`
 * — cursor (`~/.cursor`) and opencode (XDG data under `$HOME`) lose resume.
 * codex and claude keep it: their native session stores are Claudexor-owned
 * directories that the adapter re-points on top of this env and that the
 * confinement carves back out, and the macOS login Keychain is reached through
 * the declared scoped-home bridge (INV-067), so subscription auth is unaffected.
 *
 * Never degrades silently: a delegated attempt whose scoped home is not on disk,
 * or whose boundary cannot be applied and proven, refuses.
 */
export function scopedHarnessHome(
  wsm: WorkspaceManager,
  envelope: WorkspaceEnvelope,
  inPlaceEnvelope: boolean,
  delegated: boolean,
  access: AccessProfile = "workspace_write",
  roots: ConfinementRoots = defaultConfinementRoots(),
  host?: ConfinementHost,
): ScopedHarnessHome {
  if (inPlaceEnvelope && !delegated) {
    return {
      isolated: false,
      homeDir: null,
      confinement: null,
      confinementUnavailableReason: null,
    };
  }
  const env = wsm.envFor(envelope);
  const homeDir = env["HOME"];
  if (delegated && (!homeDir || !existsSync(homeDir))) {
    throw new DelegatedHomeUnavailableError(
      `delegated run cannot be confined: the scoped harness home for attempt ${envelope.attempt_id} is missing (${homeDir || "unset"})`,
    );
  }
  const outcome =
    delegated && isMutatingAccess(access)
      ? applyConfinement(
          {
            operatorHome: roots.operatorHome,
            runtimeRoot: roots.runtimeRoot,
            nativeStateRoot: roots.nativeStateRoot,
            scopedHome: homeDir as string,
            worktree: envelope.worktree_path,
          },
          host,
        )
      : { confinement: null, unavailableReason: null };
  return {
    env,
    isolated: true,
    homeDir: homeDir ?? null,
    confinement: outcome.confinement,
    confinementUnavailableReason: outcome.unavailableReason,
  };
}

/**
 * What the CHILD is told, when it is running without an OS boundary.
 *
 * Second of the three places the absence is disclosed (the attempt record and
 * the caller's result are the other two). A model that believes it is sandboxed
 * when it is not is the one reader whose behaviour actually changes on this
 * fact, so it is stated to the model in plain words rather than left in an
 * artifact it never reads.
 */
export function confinementNotice(home: ScopedHarnessHome | null | undefined): string | null {
  const reason = home?.confinementUnavailableReason;
  if (!reason) return null;
  return [
    "Engine disclosure — NO OS-ENFORCED BOUNDARY: this delegated run was asked to put your",
    `process inside a kernel-enforced filesystem boundary and could not: ${reason}.`,
    "Nothing outside this notice stops you from reading or writing any path this user account",
    "can reach. Confine yourself to the worktree you were given and the HOME you were given,",
    "and do not read the operator's credential stores or Claudexor's own runtime directory.",
  ].join("\n");
}

/**
 * What an attempt's harness process ACTUALLY ran under.
 *
 * One shape, written by the success path and the failure path alike. An attempt
 * that spawned a harness and then died still ran a process, and the caller of a
 * delegated run still needs to know what that process could reach — "it failed"
 * is not an answer to "was it confined".
 */
export interface AppliedAttemptFacts {
  harness_home_isolated: boolean;
  harness_home_dir: string | null;
  access_applied: AccessProfile;
  credential_profile_applied: string | null;
  /**
   * OPAQUE mechanism label, never a platform and never a promise: it is written
   * only together with the path below, which is the proof it was enforced.
   */
  confinement_mechanism: string | null;
  confinement_profile_digest: string | null;
  confinement_verified_denied_path: string | null;
  /**
   * Why this attempt ran with NO boundary. This is the field that makes an
   * honestly unconfined attempt DIFFERENT from an attempt whose evidence is
   * simply missing — the first is auditable, the second is not.
   */
  confinement_unavailable_reason: string | null;
}

/**
 * `home` is nullable on purpose: an attempt that died BEFORE its home was
 * decided still writes the block, with every field null. A record that omits
 * the fields entirely is indistinguishable from one written by an engine that
 * never had them, which is the ambiguity the terminal check exists to close.
 */
export function appliedAttemptFacts(
  home: ScopedHarnessHome | null | undefined,
  access: AccessProfile,
  credentialProfileId: string | null,
): AppliedAttemptFacts {
  return {
    harness_home_isolated: home?.isolated ?? false,
    harness_home_dir: home?.homeDir ?? null,
    access_applied: access,
    credential_profile_applied: credentialProfileId,
    confinement_mechanism: home?.confinement?.mechanism ?? null,
    confinement_profile_digest: home?.confinement?.profile_digest ?? null,
    confinement_verified_denied_path: home?.confinement?.verified_denied_path ?? null,
    confinement_unavailable_reason: home?.confinementUnavailableReason ?? null,
  };
}

/**
 * Whether an attempt's record is auditable for a delegated MUTATING run.
 *
 * The distinction this predicate exists to draw: evidence that is MISSING is
 * still a reason to refuse — an attempt that cannot say what it ran under is
 * indistinguishable from one that ran unconfined behind a green terminal.
 * Evidence that honestly says "no boundary here, and here is why" is COMPLETE;
 * the absence of a boundary is a fact about the host, not a gap in the record,
 * and refusing on it would make a delegated mutating run impossible wherever
 * Claudexor has not implemented a mechanism.
 *
 * A named mechanism is a claim, and only `verified_denied_path` discharges it —
 * so a record carrying the name without the proof is NOT complete, and neither
 * is one that claims a boundary and a reason for its absence at the same time.
 */
export function appliedEvidenceComplete(facts: AppliedAttemptFacts | null | undefined): boolean {
  if (!facts || !facts.harness_home_isolated || !facts.harness_home_dir) return false;
  if (facts.confinement_mechanism) {
    return confinementBoundaryProven(facts) && !facts.confinement_unavailable_reason;
  }
  return Boolean(facts.confinement_unavailable_reason);
}

/**
 * The terminal gate, shared by every lane that assembles attempts.
 *
 * A delegated MUTATING run may only reach a terminal when EVERY attempt it ran
 * can state what it ran under. One lane checking and its twin not is how a
 * mutating child ends up unconfined behind a green run, so the rule lives here
 * and both callers spend it.
 */
export function assertDelegatedEvidence(
  delegated: boolean,
  access: AccessProfile,
  attempts: readonly { attemptId: string; applied?: AppliedAttemptFacts }[],
): void {
  if (!delegated || !isMutatingAccess(access)) return;
  const unauditable = attempts.filter((attempt) => !appliedEvidenceComplete(attempt.applied));
  if (unauditable.length === 0) return;
  throw new DelegatedEvidenceIncompleteError(
    `delegated mutating run cannot terminalize: ${unauditable.length} attempt(s) state neither a proven confinement nor a reason there was none (${unauditable.map((attempt) => attempt.attemptId).join(", ")})`,
  );
}

import { existsSync } from "node:fs";
import {
  applyConfinement,
  DelegatedEvidenceIncompleteError,
  DelegatedHomeUnavailableError,
} from "@claudexor/core";
import type { AccessProfile, HarnessConfinement, WorkspaceEnvelope } from "@claudexor/schema";
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
}

/** Access profiles under which the harness can modify the filesystem. */
export function isMutatingAccess(access: AccessProfile): boolean {
  return access !== "readonly";
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
): ScopedHarnessHome {
  if (inPlaceEnvelope && !delegated) return { isolated: false, homeDir: null, confinement: null };
  const env = wsm.envFor(envelope);
  const homeDir = env["HOME"];
  if (delegated && (!homeDir || !existsSync(homeDir))) {
    throw new DelegatedHomeUnavailableError(
      `delegated run cannot be confined: the scoped harness home for attempt ${envelope.attempt_id} is missing (${homeDir || "unset"})`,
    );
  }
  const confinement =
    delegated && isMutatingAccess(access)
      ? applyConfinement({
          operatorHome: roots.operatorHome,
          runtimeRoot: roots.runtimeRoot,
          nativeStateRoot: roots.nativeStateRoot,
          scopedHome: homeDir as string,
          worktree: envelope.worktree_path,
        })
      : null;
  return { env, isolated: true, homeDir: homeDir ?? null, confinement };
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
  confinement_mechanism: "seatbelt" | null;
  confinement_profile_digest: string | null;
  confinement_verified_denied_path: string | null;
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
  };
}

/**
 * Whether an attempt's record is auditable for a delegated MUTATING run.
 *
 * A terminal that cannot state the HOME, the access profile and the applied
 * boundary of every attempt it ran is indistinguishable from one that ran
 * unconfined, so the run refuses instead of reporting success.
 */
export function appliedEvidenceComplete(facts: AppliedAttemptFacts | null | undefined): boolean {
  return Boolean(
    facts &&
    facts.harness_home_isolated &&
    facts.harness_home_dir &&
    facts.confinement_mechanism &&
    facts.confinement_profile_digest &&
    facts.confinement_verified_denied_path,
  );
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
    `delegated mutating run cannot terminalize: ${unauditable.length} attempt(s) carry no proof of the applied confinement (${unauditable.map((attempt) => attempt.attemptId).join(", ")})`,
  );
}

import type { CredentialUnusableObservation, QuotaSnapshot } from "@claudexor/schema";
import { quotaSnapshotAvailability } from "@claudexor/schema";

/**
 * THE live-observation matcher (A7): does a typed `credential_unusable`
 * observation currently condemn this subject for this decision's model? One
 * owner, so rotation refusal, exhaustion rows, and the pool terminal can never
 * disagree about which observation is live. Expired observations never match
 * (the self-expiry half of the clearing contract); a model-scoped observation
 * matches only its own model, while a credential-wide one (model=null) matches
 * every route — the write side owns that scoping decision.
 */
export function liveUnusableFor(
  observations: readonly CredentialUnusableObservation[],
  harnessId: string,
  profileId: string | null,
  model?: string | null,
  now: Date = new Date(),
): CredentialUnusableObservation | null {
  for (const obs of observations) {
    if (obs.harness_id !== harnessId) continue;
    if (obs.profile_id !== profileId) continue;
    if (obs.model !== null && obs.model !== (model ?? null)) continue;
    const expires = Date.parse(obs.expires_at);
    if (!Number.isFinite(expires) || expires <= now.getTime()) continue;
    return obs;
  }
  return null;
}

/**
 * Typed verdict that a credential subject's own observed quota evidence blocks
 * spending right now (A4 cooldown reader). `kind` distinguishes a spent window
 * with a known future reset (`exhausted`) from a live rate-limit cooldown
 * (`cooldown`); `resets_at` is the earliest known release instant.
 */
export interface QuotaBlock {
  blocked: true;
  constraint_id: string | null;
  resets_at: string | null;
  kind: "exhausted" | "cooldown";
}

/**
 * Does any observed quota window BLOCK this subject right now?
 *
 * Deliberately NOT a third copy of blocking semantics: each subject snapshot is
 * judged by the schema's own `quotaSnapshotAvailability` projection — the same
 * verdict the /v2/quota surface and the Accounts card show — so preflight can
 * never dispatch into a window the projection already calls unavailable.
 *
 * Two deliberate contrasts with `profileHeadroomBreach` (which stays fresh-only
 * for its 0.9 proactive threshold):
 * - STALE evidence blocks too. A cooldown/reset instant is absolute clock
 *   truth: the registry keeps a stale snapshot alive exactly because its
 *   `cooldown_until` still extends into the future (activeSnapshots), and a
 *   reactive vendor limit observed six minutes ago is still a live limit even
 *   though its snapshot has aged past the 5-minute fresh horizon.
 * - Blocking is EVIDENCE-of-limit, not usage-ratio proximity: an expired or
 *   unknown-reset window never blocks (the projection treats it as stale data).
 *
 * Model scope fails OPEN by construction: the projection matches by
 * case-insensitive alias containment, so a vendor display label
 * ("Gemini 3.7 Flash High") that cannot be proven to cover the routed slug
 * ("grok-4.6" — or even an unprovable "gemini-3.7-flash") leaves the subject
 * spendable rather than cooling every model on the account. A scoped window
 * with NO model context blocks only when it declares it governs the
 * unspecified-model route.
 */
export function profileQuotaBlock(
  snapshots: readonly QuotaSnapshot[],
  harnessId: string,
  profileId: string | null,
  model?: string | null,
  now?: Date,
): QuotaBlock | null {
  for (const snapshot of snapshots) {
    if (snapshot.subject.harness !== harnessId) continue;
    if ((snapshot.subject.subject_id ?? null) !== profileId) continue;
    const availability = quotaSnapshotAvailability(snapshot, { now, model: model ?? null });
    if (availability.state === "available") continue;
    return {
      blocked: true,
      constraint_id: availability.blocking_constraints[0] ?? null,
      resets_at: availability.resets_at,
      kind: availability.state,
    };
  }
  return null;
}

/**
 * One row of `route.profile.rotation_exhausted` candidate evidence, as the
 * pool-exhausted terminal consumes it. Structural on purpose: the rotation
 * module's rows satisfy it without this module importing that module (the
 * import runs the other way).
 */
export interface PoolExhaustionCandidate {
  profile_id: string;
  rejected: string;
  headroom: { resets_at: string | null } | null;
  cooldown: { resets_at: string | null } | null;
  /** A7: a live `credential_unusable` verdict about this row's credential —
   * dead-credential evidence for the terminal's claim, and an exclusion from
   * the reset fold (a dead credential's windows promise no reopen). */
  unusable?: { code: string } | null;
}

/** Rejection labels that keep a row a POOL MEMBER for the reset fold. The
 * other labels (`not_ready`, `not_in_rotation_policy`,
 * `credential_kind_mismatch`) mark identities rotation could never select, so
 * their quota evidence must not shape the pool's reopen promise. */
const POOL_MEMBER_REJECTIONS = new Set([
  "current",
  "already_tried",
  "headroom_exceeded",
  "cooldown",
  "not_selected",
]);

/**
 * The WHOLE pool refused, MACHINE-READABLY (A5).
 *
 * Mirrors `subscriptionWindowExhausted`'s reasoning: nothing malfunctioned —
 * no credential in this harness's rotation pool can serve the run right now,
 * which is exactly what `harness_unavailable` means. The message stays human;
 * the machine reads `code` and `resetsAt`, which the run terminal lifts onto
 * `final/failure.yaml` verbatim.
 *
 * `resetsAt` folds the EARLIEST known reset WITHIN the pool — the first
 * instant any member reopens — including the current/default subject's own
 * observed limit (`subjectLimit`, consulted only when no candidate row already
 * carries the subject's evidence, and EXCLUDED entirely when the subject's
 * credential itself was observed unusable: a dead credential's quota reset
 * will never help, so it must not shape the pool's reopen promise). This is deliberately the opposite of the
 * ACROSS-CANDIDATES rule (`unanimousDeclaredFailure` keeps the LATEST reset:
 * every slot must reopen); here ONE reopened member is enough to retry. Same
 * honesty rule as there: a limit-evidenced member with an UNKNOWN reset makes
 * the pool's reset unknown — a partial answer is worse than none — while
 * members rejected without limit evidence (e.g. structurally dead) never
 * poison the fold.
 */
export function credentialPoolExhausted(args: {
  harnessId: string;
  /** The triggering subject: a pinned profile id, or null for the default. */
  profileId: string | null;
  reason:
    "profile_headroom_preflight" | "vendor_limit_rejected" | "structural_pre_progress_failure";
  candidates: readonly PoolExhaustionCandidate[];
  /** The triggering subject's own observed limit evidence, when the candidate
   * rows cannot carry it (the default subject has no row; a just-observed
   * typed limit may not be ingested into the registry yet). */
  subjectLimit: { resets_at: string | null } | null;
  /** The differential probe's verdict on the triggering subject (A7), when it
   * found the credential itself dead — the terminal then says so instead of
   * promising a quota reset that will never help. */
  subjectUnusable?: Pick<CredentialUnusableObservation, "code"> | null;
}): Error {
  // A dead credential's quota windows promise no reopen: a row with a live
  // `credential_unusable` verdict never joins the fold, whatever its label.
  const members = args.candidates.filter(
    (c) =>
      POOL_MEMBER_REJECTIONS.has(c.rejected) &&
      !c.unusable &&
      (c.headroom !== null || c.cooldown !== null),
  );
  const limits = members.map((c) => c.headroom?.resets_at ?? c.cooldown?.resets_at ?? null);
  // Same rule for the triggering subject: its own observed limit joins the
  // fold only while its credential is not observed dead — the terminal must
  // not promise the DEAD subject's reset as the instant the pool reopens.
  if (
    args.subjectLimit &&
    !args.subjectUnusable &&
    !members.some((c) => c.profile_id === args.profileId)
  ) {
    limits.push(args.subjectLimit.resets_at);
  }
  const resetsAt =
    limits.length > 0 && limits.every((at): at is string => at !== null)
      ? limits.reduce((earliest, at) => (Date.parse(at) < Date.parse(earliest) ? at : earliest))
      : null;
  const subject = args.profileId ? `profile "${args.profileId}"` : "the default credentials";
  return Object.assign(
    new Error(
      `credential pool exhausted for "${args.harnessId}": ${subject} hit ${
        args.reason === "structural_pre_progress_failure"
          ? "a terminal pre-progress failure"
          : "a vendor limit"
      } and none of ${args.candidates.length} registered candidate(s) can take over` +
        (args.subjectUnusable
          ? `; the subject's credential itself was observed unusable (${args.subjectUnusable.code})`
          : "") +
        (resetsAt ? `; earliest pool reset ${resetsAt}` : ""),
    ),
    {
      code: "credential_pool_exhausted",
      // Not `internal`: nothing malfunctioned. No account in the pool can
      // serve this run until a window reopens (harness_unavailable).
      category: "harness_unavailable",
      resetsAt,
    },
  );
}

/**
 * PRE-SPAWN credential preflight (W5.4 `profile_headroom_preflight` + A4 live
 * blocks + A5 pool-exhausted split), split from `credential-profile-rotation`
 * so each file stays under the complexity cap: this module owns what happens
 * BEFORE a spawn (headroom/observed-block checks, the FAIL refusals, the
 * rotate-or-refuse decision); the rotation module owns candidate selection and
 * the REACTIVE mid-attempt failover. Re-exported through `credential-profiles`
 * like its siblings.
 */
import type {
  CredentialProfile,
  CredentialUnusableObservation,
  QuotaSnapshot,
} from "@claudexor/schema";
import {
  credentialPoolExhausted,
  profileQuotaBlock,
  type QuotaBlock,
} from "./credential-cooldown.js";
import {
  effectiveLimitAction,
  emitRotationExhausted,
  limitSubjectRoute,
  nextEligibleProfile,
  profileHeadroomBreach,
  type EmitFn,
  type HeadroomBreach,
  type ProfilePolicy,
  type SubjectRoute,
} from "./credential-profile-rotation.js";

/**
 * A spent subscription window, refused MACHINE-READABLY.
 *
 * The verdict a caller actually needs from this refusal is "not now, come back
 * at T" — and the only honest way to deliver T is as a field. Gluing it into
 * the sentence and shipping the terminal as `category: internal, code: null`
 * left every consumer (a surface, a scheduler, an automating host) to regex
 * the prose for a timestamp, which no contract in this repo permits. The
 * message stays human-readable; the machine reads `code` and `resetsAt`, which
 * the run terminal lifts onto `final/failure.yaml` verbatim.
 */
function subscriptionWindowExhausted(
  profileId: string,
  harnessId: string,
  breach: HeadroomBreach,
): Error {
  return Object.assign(
    new Error(
      `credential profile "${profileId}" (${harnessId}) is over its headroom threshold ` +
        `(${breach.constraint_id} at ${Math.round(breach.used_ratio * 100)}% >= ${Math.round(breach.threshold * 100)}%; ` +
        `limit_action=fail${breach.resets_at ? `; resets ${breach.resets_at}` : ""})`,
    ),
    {
      code: "subscription_window_exhausted",
      // Not `internal`: nothing malfunctioned. The account cannot serve this
      // run until its window reopens, which is what harness_unavailable means.
      category: "harness_unavailable",
      resetsAt: breach.resets_at,
    },
  );
}

/** The FAIL action's refusal for an OBSERVED live block (A4): same typed code
 * and category as the headroom form — a consumer asks "when can I come back",
 * not which detector fired — with the block's own evidence in the prose. */
function subscriptionWindowBlocked(profileId: string, harnessId: string, block: QuotaBlock): Error {
  return Object.assign(
    new Error(
      `credential profile "${profileId}" (${harnessId}) is ${
        block.kind === "exhausted"
          ? "over an observed vendor window"
          : "in a vendor rate-limit cooldown"
      } (${block.constraint_id ?? "cooldown"}; limit_action=fail${
        block.resets_at ? `; resets ${block.resets_at}` : ""
      })`,
    ),
    {
      code: "subscription_window_exhausted",
      category: "harness_unavailable",
      resetsAt: block.resets_at,
    },
  );
}

/**
 * Whether preflight should spend the candidate-readiness probe (seconds of
 * doctor calls) before spawn: only when the RESOLVED action for this subject
 * is `rotate` (A6: `auto` decides by the subject's route), the subject shows
 * quota evidence (fresh headroom breach or an observed live block), and the
 * subject is rotatable at all (a pinned profile, or a subscription default).
 * Hoisted out of the orchestrator so the resolution rule lives here once.
 */
function rotationProbeNeeded(args: {
  policy: ProfilePolicy;
  profile: CredentialProfile | null;
  defaultRoute: SubjectRoute;
  snapshots: readonly QuotaSnapshot[];
  harnessId: string;
  model?: string | null;
}): boolean {
  const { policy, profile, defaultRoute, snapshots, harnessId, model } = args;
  const route = limitSubjectRoute(profile, defaultRoute);
  if (effectiveLimitAction(policy, route) !== "rotate") return false;
  if (profile === null && defaultRoute !== "local_session") return false;
  const subjectId = profile?.profile_id ?? null;
  return (
    profileHeadroomBreach(snapshots, harnessId, subjectId, policy.headroom_threshold, model) !==
      null || profileQuotaBlock(snapshots, harnessId, subjectId, model) !== null
  );
}

/**
 * The ONE pre-spawn preflight composition (hoisted from the orchestrator so
 * the decision lives beside its branches): spend the candidate-readiness probe
 * only when `rotationProbeNeeded` says the RESOLVED action could use it, then
 * route the pinned-profile or default-subject lane. `probeReady` is the
 * caller's rotation-readiness epoch (`readyProfileIdsForRotation`).
 */
export async function runProfilePreflight(args: {
  profile: CredentialProfile | null;
  harnessId: string;
  policy: ProfilePolicy;
  registry: readonly CredentialProfile[];
  snapshots: readonly QuotaSnapshot[];
  unusable?: readonly CredentialUnusableObservation[];
  probeReady: () => Promise<ReadonlySet<string>>;
  defaultRoute: SubjectRoute;
  model?: string | null;
  emit: EmitFn;
}): Promise<CredentialProfile | null> {
  const { profile, harnessId, policy, registry, snapshots, unusable, defaultRoute, model, emit } =
    args;
  const readyProfileIds = rotationProbeNeeded({
    policy,
    profile,
    defaultRoute,
    snapshots,
    harnessId,
    model,
  })
    ? await args.probeReady()
    : new Set<string>();
  if (!profile) {
    // Unpinned runs (INV-135 auto-balance): under `rotate`, a fresh
    // default-subject headroom breach starts on the next eligible
    // subscription profile instead; `fail`/`ask` change nothing.
    return preflightDefaultSubject({
      harnessId,
      policy,
      registry,
      snapshots,
      readyProfileIds,
      defaultRoute,
      unusable,
      model,
      emit,
    });
  }
  return preflightCredentialProfile({
    profile,
    harnessId,
    policy,
    registry,
    snapshots,
    readyProfileIds,
    unusable,
    model,
    emit,
  });
}

/**
 * `profile_headroom_preflight` (W5.4): BEFORE spawn, the selected profile's
 * freshest quota windows are checked against the policy threshold. A breach
 * is always a typed event; `rotate` swaps to the next eligible profile with
 * provenance, `ask`/`fail` proceed on the selected profile — the runtime
 * `vendor_limit_rejected` evidence stays the terminating truth.
 */
export function preflightCredentialProfile(args: {
  profile: CredentialProfile;
  harnessId: string;
  policy: ProfilePolicy;
  registry: readonly CredentialProfile[];
  snapshots: readonly QuotaSnapshot[];
  readyProfileIds: ReadonlySet<string>;
  /** Live typed `credential_unusable` observations (A7) — exhaustion rows name
   * a dead-credential candidate typed instead of "not_ready". */
  unusable?: readonly CredentialUnusableObservation[];
  model?: string | null;
  emit: EmitFn;
}): CredentialProfile {
  const { profile, harnessId, policy, registry, snapshots, readyProfileIds, model, emit } = args;
  // The RESOLVED action for THIS subject (A6): `auto` decides by the pinned
  // profile's own credential kind — rotate for subscription, fail for metered.
  const action = effectiveLimitAction(policy, limitSubjectRoute(profile));
  const breach = profileHeadroomBreach(
    snapshots,
    harnessId,
    profile.profile_id,
    policy.headroom_threshold,
    model,
  );
  // The cooldown reader (A4) sees what the fresh-only headroom check cannot:
  // an OBSERVED live block — a reactive vendor-limit cooldown (stale-but-live
  // included) or a spent window with a known future reset.
  const block = breach ? null : profileQuotaBlock(snapshots, harnessId, profile.profile_id, model);
  if (!breach && !block) return profile;
  emit("route.profile.headroom_exceeded", {
    harness_id: harnessId,
    profile_id: profile.profile_id,
    action,
    constraint_id: breach?.constraint_id ?? block?.constraint_id ?? null,
    used_ratio: breach?.used_ratio ?? null,
    threshold: policy.headroom_threshold,
    resets_at: breach?.resets_at ?? block?.resets_at ?? null,
  });
  if (action === "fail") {
    // The documented FAIL action fails (release wave tier1 #4): a FRESH breach
    // or an observed live block under fail refuses before spawn with the
    // evidence, instead of silently proceeding into a vendor rejection.
    throw breach
      ? subscriptionWindowExhausted(profile.profile_id, harnessId, breach)
      : subscriptionWindowBlocked(profile.profile_id, harnessId, block as QuotaBlock);
  }
  if (action !== "rotate") return profile;
  const next = nextEligibleProfile(
    registry,
    harnessId,
    policy,
    profile,
    snapshots,
    readyProfileIds,
    new Set(),
    model,
  );
  if (!next) {
    const candidates = emitRotationExhausted({
      current: profile,
      harnessId,
      policy,
      registry,
      snapshots,
      readyProfileIds,
      unusable: args.unusable,
      model,
      reason: "profile_headroom_preflight",
      emit,
    });
    // A5 preflight split: an OBSERVED live block (spent window / active
    // cooldown) with an exhausted pool is hard evidence — refuse typed BEFORE
    // spawn. A bare headroom breach is proximity, not proof the window is
    // spent: proceed on the selected profile and let the vendor be the truth.
    const hard = block ?? profileQuotaBlock(snapshots, harnessId, profile.profile_id, model);
    if (hard) {
      throw credentialPoolExhausted({
        harnessId,
        profileId: profile.profile_id,
        reason: "profile_headroom_preflight",
        candidates,
        subjectLimit: { resets_at: hard.resets_at },
      });
    }
    return profile;
  }
  emit("route.profile.rotated", {
    harness_id: harnessId,
    from_profile_id: profile.profile_id,
    to_profile_id: next.profile_id,
    reason: "profile_headroom_preflight",
    constraint_id: breach?.constraint_id ?? block?.constraint_id ?? null,
    used_ratio: breach?.used_ratio ?? null,
    resets_at: breach?.resets_at ?? block?.resets_at ?? null,
  });
  return next;
}

/**
 * Default-subject start selection (INV-135, owner scope "auto-balance"): when
 * NO profile is pinned, the EFFECTIVE action is `rotate` (explicit, or `auto`
 * on a subscription route — A6), and the DEFAULT store's own fresh quota
 * window is at/over the headroom bound, pick the first eligible SUBSCRIPTION
 * profile instead of spawning into a near-certain vendor limit. Explicit
 * `fail`/`ask` keep the pre-A6 default-user behavior untouched (the profile
 * engine's fail action governs PINNED profiles only — throwing here would
 * brick every default user at 90% quota). Unknown or stale usage never
 * rotates.
 */
export function preflightDefaultSubject(args: {
  harnessId: string;
  policy: ProfilePolicy;
  registry: readonly CredentialProfile[];
  snapshots: readonly QuotaSnapshot[];
  readyProfileIds: ReadonlySet<string>;
  defaultRoute: "local_session" | "api_key" | null;
  unusable?: readonly CredentialUnusableObservation[];
  model?: string | null;
  emit: EmitFn;
}): CredentialProfile | null {
  const { harnessId, policy, registry, snapshots, readyProfileIds, defaultRoute, model, emit } =
    args;
  // A6: `auto` resolves by the DEFAULT subject's route — a subscription
  // default rotates, a metered or unknown default keeps today's behavior.
  const action = effectiveLimitAction(policy, defaultRoute);
  if (action !== "rotate" || defaultRoute !== "local_session") return null;
  const breach = profileHeadroomBreach(
    snapshots,
    harnessId,
    null,
    policy.headroom_threshold,
    model,
  );
  // Same A4 cooldown reader as the pinned lane: the default subject's own
  // observed live block (reactive cooldown / spent window) rotates too.
  const block = breach ? null : profileQuotaBlock(snapshots, harnessId, null, model);
  if (!breach && !block) return null;
  emit("route.profile.headroom_exceeded", {
    harness_id: harnessId,
    profile_id: null,
    action,
    constraint_id: breach?.constraint_id ?? block?.constraint_id ?? null,
    used_ratio: breach?.used_ratio ?? null,
    threshold: policy.headroom_threshold,
    resets_at: breach?.resets_at ?? block?.resets_at ?? null,
  });
  const next = nextEligibleProfile(
    registry,
    harnessId,
    policy,
    null,
    snapshots,
    readyProfileIds,
    new Set(),
    model,
  );
  if (!next) {
    const candidates = emitRotationExhausted({
      current: null,
      harnessId,
      policy,
      registry,
      snapshots,
      readyProfileIds,
      unusable: args.unusable,
      model,
      reason: "profile_headroom_preflight",
      emit,
    });
    // Same A5 preflight split as the pinned lane: the DEFAULT subject's own
    // observed live block with no eligible alternative refuses typed before
    // spawn; a bare headroom breach proceeds (not proven spent).
    const hard = block ?? profileQuotaBlock(snapshots, harnessId, null, model);
    if (hard) {
      throw credentialPoolExhausted({
        harnessId,
        profileId: null,
        reason: "profile_headroom_preflight",
        candidates,
        subjectLimit: { resets_at: hard.resets_at },
      });
    }
    return null;
  }
  emit("route.profile.rotated", {
    harness_id: harnessId,
    from_profile_id: null,
    to_profile_id: next.profile_id,
    reason: "profile_headroom_preflight",
    constraint_id: breach?.constraint_id ?? block?.constraint_id ?? null,
    used_ratio: breach?.used_ratio ?? null,
    resets_at: breach?.resets_at ?? block?.resets_at ?? null,
  });
  return next;
}

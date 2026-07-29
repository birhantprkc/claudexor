import type { CredentialProfile, HarnessRunSpec, QuotaSnapshot } from "@claudexor/schema";
import { HarnessRunSpec as HarnessRunSpecSchema } from "@claudexor/schema";

export interface ProfilePolicy {
  limit_action: "fail" | "ask" | "rotate";
  rotation_eligible: string[];
  headroom_threshold: number;
}

/** Typed quota evidence for a profile over its headroom bound (provenance). */
export interface HeadroomBreach {
  constraint_id: string;
  used_ratio: number;
  threshold: number;
  resets_at: string | null;
}

/**
 * Proactive headroom check (W5.4 `profile_headroom_preflight`): the SELECTED
 * profile's freshest snapshot windows against the policy threshold. Unknown
 * usage is NOT a breach — rotation never triggers on missing data.
 */
export function profileHeadroomBreach(
  snapshots: readonly QuotaSnapshot[],
  harnessId: string,
  profileId: string | null,
  threshold: number,
): HeadroomBreach | null {
  for (const snapshot of snapshots) {
    // FRESH evidence only (release wave tier1 #3): a stale or unknown reading
    // must never breach headroom, rotate a profile away, or fail selection.
    if (snapshot.freshness !== "fresh") continue;
    if (snapshot.subject.harness !== harnessId) continue;
    if ((snapshot.subject.subject_id ?? null) !== profileId) continue;
    for (const constraint of snapshot.constraints) {
      if (constraint.used_ratio !== null && constraint.used_ratio >= threshold) {
        return {
          constraint_id: constraint.id,
          used_ratio: constraint.used_ratio,
          threshold,
          resets_at: constraint.resets_at,
        };
      }
    }
  }
  return null;
}

/**
 * The next rotation target after `currentProfileId` (W5.4): policy order wins
 * (`rotation_eligible`), else every enabled profile of the harness in registry
 * order. The current profile and disabled/unknown ids never come back; a
 * profile already over the headroom bound is skipped (rotating INTO a spent
 * subscription is not a failover). Cross-subscription rotation of one vendor
 * is allowed by owner decision — but rotation NEVER crosses credential kinds
 * (release wave round-16 BLOCK): a subscription→API-key swap silently changes
 * the payment model mid-attempt, and the attempt's first-wins auth-route
 * receipt (decided once before spawn) would misvalue metered usage as
 * subscription entitlement, bypassing a finite cash cap.
 */
export function nextEligibleProfile(
  registry: readonly CredentialProfile[],
  harnessId: string,
  policy: ProfilePolicy,
  current: Pick<CredentialProfile, "profile_id" | "credential_kind"> | null,
  snapshots: readonly QuotaSnapshot[],
  readyProfileIds: ReadonlySet<string>,
  excluded: ReadonlySet<string> = new Set(),
): CredentialProfile | null {
  const pool = registry.filter((p) => p.harness_id === harnessId && p.enabled);
  const ordered =
    policy.rotation_eligible.length > 0
      ? policy.rotation_eligible
          .map((id) => pool.find((p) => p.profile_id === id))
          .filter((p): p is CredentialProfile => p !== undefined)
      : pool;
  for (const candidate of ordered) {
    if (candidate.profile_id === current?.profile_id) continue;
    if (excluded.has(candidate.profile_id)) continue;
    // Fail-CLOSED kind guard (round-17 hardening of the round-16 BLOCK): the
    // kind comes from the TYPED current profile in hand — never re-found in
    // a freshly reloaded pool, where a mid-flight disable/remove of the
    // current profile would have silently dropped the cross-kind prohibition.
    if (current !== null && candidate.credential_kind !== current.credential_kind) continue;
    // `current === null` is the DEFAULT subject (the vendor-native store): the
    // same round-16 BLOCK applies — rotating the subscription default INTO an
    // api_key profile would silently change the payment model mid-attempt.
    if (current === null && candidate.credential_kind === "api_key") continue;
    if (!readyProfileIds.has(candidate.profile_id)) continue;
    if (
      profileHeadroomBreach(snapshots, harnessId, candidate.profile_id, policy.headroom_threshold)
    )
      continue;
    return candidate;
  }
  return null;
}

/**
 * `rotation_retry_eligible` (sol #30): a failover retry is allowed ONLY when
 * the attempt saw a TYPED vendor limit AND produced no deliverable and no
 * workspace mutation — a partially-acted attempt never silently reruns.
 */
export function rotationRetryEligible(input: {
  sawTypedLimit: boolean;
  deliverableEmpty: boolean;
}): boolean {
  return input.sawTypedLimit && input.deliverableEmpty;
}

type EmitFn = (
  type:
    | "route.profile.headroom_exceeded"
    | "route.profile.rotated"
    | "route.profile.rotation_exhausted",
  payload: Record<string, unknown>,
) => void;

function emitRotationExhausted(args: {
  current: Pick<CredentialProfile, "profile_id" | "credential_kind"> | null;
  harnessId: string;
  policy: ProfilePolicy;
  registry: readonly CredentialProfile[];
  snapshots: readonly QuotaSnapshot[];
  readyProfileIds: ReadonlySet<string>;
  excluded?: ReadonlySet<string>;
  attemptId?: string;
  reason: "profile_headroom_preflight" | "vendor_limit_rejected";
  emit: EmitFn;
}): void {
  const excluded = args.excluded ?? new Set<string>();
  const candidates = args.registry
    .filter((profile) => profile.harness_id === args.harnessId && profile.enabled)
    .map((profile) => {
      const breach = profileHeadroomBreach(
        args.snapshots,
        args.harnessId,
        profile.profile_id,
        args.policy.headroom_threshold,
      );
      const rejected =
        profile.profile_id === args.current?.profile_id
          ? "current"
          : args.policy.rotation_eligible.length > 0 &&
              !args.policy.rotation_eligible.includes(profile.profile_id)
            ? "not_in_rotation_policy"
            : excluded.has(profile.profile_id)
              ? "already_tried"
              : args.current && profile.credential_kind !== args.current.credential_kind
                ? "credential_kind_mismatch"
                : args.current === null && profile.credential_kind === "api_key"
                  ? "credential_kind_mismatch"
                  : !args.readyProfileIds.has(profile.profile_id)
                    ? "not_ready"
                    : breach
                      ? "headroom_exceeded"
                      : "not_selected";
      return {
        profile_id: profile.profile_id,
        credential_kind: profile.credential_kind,
        rejected,
        headroom: breach,
      };
    });
  args.emit("route.profile.rotation_exhausted", {
    harness_id: args.harnessId,
    attempt_id: args.attemptId,
    from_profile_id: args.current?.profile_id ?? null,
    reason: args.reason,
    threshold: args.policy.headroom_threshold,
    candidates,
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
  emit: EmitFn;
}): CredentialProfile {
  const { profile, harnessId, policy, registry, snapshots, readyProfileIds, emit } = args;
  const breach = profileHeadroomBreach(
    snapshots,
    harnessId,
    profile.profile_id,
    policy.headroom_threshold,
  );
  if (!breach) return profile;
  emit("route.profile.headroom_exceeded", {
    harness_id: harnessId,
    profile_id: profile.profile_id,
    action: policy.limit_action,
    constraint_id: breach.constraint_id,
    used_ratio: breach.used_ratio,
    threshold: breach.threshold,
    resets_at: breach.resets_at,
  });
  if (policy.limit_action === "fail") {
    // The documented FAIL action fails (release wave tier1 #4): a FRESH breach
    // under fail refuses before spawn with the evidence, instead of silently
    // proceeding into a vendor rejection.
    throw new Error(
      `credential profile "${profile.profile_id}" (${harnessId}) is over its headroom threshold ` +
        `(${breach.constraint_id} at ${Math.round(breach.used_ratio * 100)}% >= ${Math.round(breach.threshold * 100)}%; ` +
        `limit_action=fail${breach.resets_at ? `; resets ${breach.resets_at}` : ""})`,
    );
  }
  if (policy.limit_action !== "rotate") return profile;
  const next = nextEligibleProfile(
    registry,
    harnessId,
    policy,
    profile,
    snapshots,
    readyProfileIds,
  );
  if (!next) {
    emitRotationExhausted({
      current: profile,
      harnessId,
      policy,
      registry,
      snapshots,
      readyProfileIds,
      reason: "profile_headroom_preflight",
      emit,
    });
    return profile;
  }
  emit("route.profile.rotated", {
    harness_id: harnessId,
    from_profile_id: profile.profile_id,
    to_profile_id: next.profile_id,
    reason: "profile_headroom_preflight",
    constraint_id: breach.constraint_id,
    used_ratio: breach.used_ratio,
    resets_at: breach.resets_at,
  });
  return next;
}

/**
 * Default-subject start selection (INV-135, owner scope "auto-balance"): when
 * NO profile is pinned, the policy is `rotate`, and the DEFAULT store's own
 * fresh quota window is at/over the headroom bound, pick the first eligible
 * SUBSCRIPTION profile instead of spawning into a near-certain vendor limit.
 * Strictly opt-in: `fail`/`ask` keep today's default-user behavior untouched
 * (the profile engine's fail action governs PINNED profiles only — throwing
 * here would brick every default user at 90% quota). Unknown or stale usage
 * never rotates.
 */
export function preflightDefaultSubject(args: {
  harnessId: string;
  policy: ProfilePolicy;
  registry: readonly CredentialProfile[];
  snapshots: readonly QuotaSnapshot[];
  readyProfileIds: ReadonlySet<string>;
  defaultRoute: "local_session" | "api_key" | null;
  emit: EmitFn;
}): CredentialProfile | null {
  const { harnessId, policy, registry, snapshots, readyProfileIds, defaultRoute, emit } = args;
  if (policy.limit_action !== "rotate" || defaultRoute !== "local_session") return null;
  const breach = profileHeadroomBreach(snapshots, harnessId, null, policy.headroom_threshold);
  if (!breach) return null;
  emit("route.profile.headroom_exceeded", {
    harness_id: harnessId,
    profile_id: null,
    action: policy.limit_action,
    constraint_id: breach.constraint_id,
    used_ratio: breach.used_ratio,
    threshold: breach.threshold,
    resets_at: breach.resets_at,
  });
  const next = nextEligibleProfile(registry, harnessId, policy, null, snapshots, readyProfileIds);
  if (!next) {
    emitRotationExhausted({
      current: null,
      harnessId,
      policy,
      registry,
      snapshots,
      readyProfileIds,
      reason: "profile_headroom_preflight",
      emit,
    });
    return null;
  }
  emit("route.profile.rotated", {
    harness_id: harnessId,
    from_profile_id: null,
    to_profile_id: next.profile_id,
    reason: "profile_headroom_preflight",
    constraint_id: breach.constraint_id,
    used_ratio: breach.used_ratio,
    resets_at: breach.resets_at,
  });
  return next;
}

/**
 * Reactive failover plan (`vendor_limit_rejected`, W5.4): rotation fires ONLY
 * on the typed predicate under a `rotate` policy, marks the current profile
 * tried (at most once per attempt each), and returns the next target with
 * provenance already emitted — or null when the attempt must fail as-is.
 * `currentProfile: null` is the DEFAULT subject: allowed ONLY when the caller
 * proves the attempt's pre-spawn route was vendor_native (a metered default
 * hitting a limit is a budget fact, not a subscription to fail over from).
 */
export function planReactiveRotation(args: {
  currentProfile: CredentialProfile | null;
  defaultRouteWasVendorNative?: boolean;
  harnessId: string;
  attemptId: string;
  policy: ProfilePolicy;
  registry: readonly CredentialProfile[];
  snapshots: readonly QuotaSnapshot[];
  readyProfileIds: ReadonlySet<string>;
  triedProfiles: Set<string>;
  sawTypedLimit: boolean;
  deliverableEmpty: boolean;
  lastLimit: { retryDelayMs: number | null; resetsAt: string | null } | null;
  emit: EmitFn;
}): CredentialProfile | null {
  if (!rotationRetryEligible(args)) return null;
  if (args.policy.limit_action !== "rotate") return null;
  if (args.currentProfile === null && args.defaultRouteWasVendorNative !== true) return null;
  if (args.currentProfile) args.triedProfiles.add(args.currentProfile.profile_id);
  const next = nextEligibleProfile(
    args.registry,
    args.harnessId,
    args.policy,
    args.currentProfile,
    args.snapshots,
    args.readyProfileIds,
    args.triedProfiles,
  );
  if (!next) {
    emitRotationExhausted({
      current: args.currentProfile,
      harnessId: args.harnessId,
      policy: args.policy,
      registry: args.registry,
      snapshots: args.snapshots,
      readyProfileIds: args.readyProfileIds,
      excluded: args.triedProfiles,
      attemptId: args.attemptId,
      reason: "vendor_limit_rejected",
      emit: args.emit,
    });
    return null;
  }
  args.emit("route.profile.rotated", {
    harness_id: args.harnessId,
    attempt_id: args.attemptId,
    from_profile_id: args.currentProfile?.profile_id ?? null,
    to_profile_id: next.profile_id,
    reason: "vendor_limit_rejected",
    retry_delay_ms: args.lastLimit?.retryDelayMs ?? null,
    resets_at: args.lastLimit?.resetsAt ?? null,
  });
  return next;
}

/**
 * Shared reactive-failover step for BOTH lanes: given the attempt's typed
 * evidence, plan a rotation and rebuild the spec on a NEW vendor session
 * under the next profile — or return null when the attempt must fail as-is.
 */
export function rotateSpecOnTypedLimit(args: {
  spec: HarnessRunSpec;
  harnessId: string;
  attemptId: string;
  policy: ProfilePolicy;
  registry: readonly CredentialProfile[];
  snapshots: readonly QuotaSnapshot[];
  readyProfileIds: ReadonlySet<string>;
  triedProfiles: Set<string>;
  sawTypedLimit: boolean;
  deliverableEmpty: boolean;
  lastLimit: { retryDelayMs: number | null; resetsAt: string | null } | null;
  emit: EmitFn;
  newSessionId: () => string;
  /** Pre-spawn route estimate for a profile-less spec: default-subject
   * rotation is allowed ONLY off a vendor_native attempt. */
  defaultRouteWasVendorNative?: boolean;
}): HarnessRunSpec | null {
  const rotation = planReactiveRotation({
    currentProfile: args.spec.credential_profile ?? null,
    defaultRouteWasVendorNative: args.defaultRouteWasVendorNative,
    harnessId: args.harnessId,
    attemptId: args.attemptId,
    policy: args.policy,
    registry: args.registry,
    snapshots: args.snapshots,
    readyProfileIds: args.readyProfileIds,
    triedProfiles: args.triedProfiles,
    sawTypedLimit: args.sawTypedLimit,
    deliverableEmpty: args.deliverableEmpty,
    lastLimit: args.lastLimit,
    emit: args.emit,
  });
  if (!rotation) return null;
  return HarnessRunSpecSchema.parse({
    ...args.spec,
    session_id: args.newSessionId(),
    credential_profile: rotation,
    resume_session_id: null,
  });
}

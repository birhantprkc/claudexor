import type {
  AuthPreference,
  AuthSourceReadiness,
  CredentialProfile,
  CredentialProfileStatus,
  HarnessEvent,
  QuotaAbsence,
  QuotaSnapshot,
} from "@claudexor/schema";
import {
  CredentialProfileStatus as CredentialProfileStatusSchema,
  quotaSourceTraits,
} from "@claudexor/schema";
import { redactSecrets } from "@claudexor/util";
import { estimateEffectiveAuthRoute } from "@claudexor/schema";
import {
  effectiveLimitAction,
  nextEligibleProfile,
  profileHeadroomBreach,
  type ProfilePolicy,
} from "./credential-profile-rotation.js";
import { profileQuotaBlock } from "./credential-cooldown.js";
export {
  effectiveLimitAction,
  limitSubjectRoute,
  nextEligibleProfile,
  planReactiveRotation,
  profileHeadroomBreach,
  rotateSpecOnTypedLimit,
  rotationRetryEligible,
  staticRotationCandidates,
  type ProfilePolicy,
} from "./credential-profile-rotation.js";
export {
  preflightCredentialProfile,
  preflightDefaultSubject,
  runProfilePreflight,
} from "./credential-preflight.js";

/**
 * The ONE resolve owner for credential profiles (INV-135): explicit id →
 * durable registry entry for exactly this harness. Unknown, disabled, or
 * harness-mismatched ids throw a typed refusal — an explicit profile must
 * never silently become the default credential ladder.
 */
export function resolveCredentialProfile(
  registry: readonly CredentialProfile[],
  wanted: string,
  harnessId: string,
): CredentialProfile {
  const match = registry.find((p) => p.profile_id === wanted && p.harness_id === harnessId);
  if (!match) {
    throw new Error(`credential profile "${wanted}" is not registered for harness "${harnessId}"`);
  }
  if (!match.enabled) {
    throw new Error(`credential profile "${wanted}" (${harnessId}) is disabled`);
  }
  return match;
}

export async function selectedProfileAvailability(input: {
  registry: readonly CredentialProfile[];
  profileId?: string | null;
  harnessId: string;
  probe?: (profile: CredentialProfile) => Promise<CredentialProfileStatus>;
  /** The quota poller's authenticated vendor evidence, when the caller holds
   * it. Omitting it admits on the LOCAL store alone — which is the reading of
   * `verification: passed` that let a run dispatch into a revoked token. */
  quota?: VendorQuotaObservations | null;
}): Promise<string | null> {
  if (!input.profileId) return null;
  let profile: CredentialProfile;
  try {
    profile = resolveCredentialProfile(input.registry, input.profileId, input.harnessId);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  if (!input.probe) return `harness "${input.harnessId}" has no profile probe`;
  const result = vendorVerifiedProfileStatus(
    await probeCredentialProfileStatus(profile, input.probe),
    input.quota,
  );
  return profileStatusAdmits(profile, result)
    ? "available"
    : (result.detail ?? `${result.availability}/${result.verification}`);
}

/** What the quota poller's last authenticated vendor contact says about ONE
 * credential subject's liveness. Null = the poller has no verdict to offer. */
export type VendorCredentialObservation =
  | { outcome: "honored"; observed_at: string }
  | { outcome: "revoked"; observed_at: string; detail: string };

/**
 * The poller's verdict for one profile, if it has one (INV-135 honesty).
 *
 * The quota poller ALREADY calls the vendor once a minute with each profile's
 * own token; a fresh snapshot from such a call means the credential was
 * honored, and a typed `auth_revoked` absence means it was rejected. Reading
 * that existing evidence is why profile verification can be live without a
 * probe run — a config-dir login has no cheaper liveness test than spending
 * quota on a mini-run, so building one would cost exactly what it measures.
 */
export function vendorCredentialObservation(
  quota: { snapshots: readonly QuotaSnapshot[]; absences: readonly QuotaAbsence[] },
  harnessId: string,
  profileId: string,
): VendorCredentialObservation | null {
  const owns = (subject: QuotaSnapshot["subject"]): boolean =>
    subject.harness === harnessId && (subject.subject_id ?? null) === profileId;
  // A rejection outranks a cached success. The registry retires a snapshot the
  // vendor has contradicted, but snapshots and absences are read through two
  // separate calls, so a cycle landing between them can still hand this one
  // subject both. Reading the older success first is what made a revoked
  // credential report as honored; the fail-closed order is the honest one.
  const revoked = quota.absences.find(
    (item) => owns(item.subject) && item.reason === "auth_revoked",
  );
  if (revoked) {
    return {
      outcome: "revoked",
      observed_at: revoked.observed_at,
      detail: revoked.detail ?? "the vendor rejected this profile's credential",
    };
  }
  const snapshot = quota.snapshots.find(
    (item) => owns(item.subject) && quotaSourceTraits(item.source).vendorAuthenticated,
  );
  return snapshot ? { outcome: "honored", observed_at: snapshot.observed_at } : null;
}

/**
 * Overlay the vendor's verdict onto a locally-probed profile status, so
 * `verification` means what a router assumes it means.
 *
 * The overlay may DOWNGRADE freely — a rejected credential is a fact the local
 * store cannot see, and it is exactly the case that made a `passed` profile
 * fail a run one minute later. It may not UPGRADE: a local probe that already
 * said "this dir is logged in under the wrong method" knows something the usage
 * endpoint does not, so a successful vendor call only re-stamps provenance on
 * an already-passing verdict. Absent a verdict the status is returned
 * untouched, still declaring `local_store`.
 */
export function withVendorCredentialObservation(
  status: CredentialProfileStatus,
  observation: VendorCredentialObservation | null,
): CredentialProfileStatus {
  if (!observation) return status;
  if (observation.outcome === "revoked") {
    return {
      ...status,
      verification: "failed",
      verification_source: "vendor",
      detail: redactSecrets(observation.detail),
      last_verified_at: observation.observed_at,
    };
  }
  if (status.verification !== "passed") return status;
  return {
    ...status,
    verification_source: "vendor",
    last_verified_at: observation.observed_at,
  };
}

/** The quota poller's evidence for every subject: what an authenticated vendor
 *  call last returned, and which subjects it could not answer for. */
export interface VendorQuotaObservations {
  snapshots: readonly QuotaSnapshot[];
  absences: readonly QuotaAbsence[];
}

/**
 * The vendor-verified reading of ONE probed profile status — the single
 * composition behind every consumer of `profileStatusAdmits`: run admission,
 * rotation readiness, and the accounts projection. Keeping the overlay in one
 * place is the point: applying it on the listing branch alone is what let the
 * Accounts card say `revoked` while the router dispatched into the same token.
 *
 * `probeCredentialProfileStatus` guarantees the status carries its own
 * profile's identity, so the subject is read from the status itself. Without
 * quota evidence the local verdict stands untouched.
 */
export function vendorVerifiedProfileStatus(
  status: CredentialProfileStatus,
  quota: VendorQuotaObservations | null | undefined,
): CredentialProfileStatus {
  if (!quota) return status;
  return withVendorCredentialObservation(
    status,
    vendorCredentialObservation(quota, status.harness_id, status.profile_id),
  );
}

/** One readiness predicate shared by run admission and accounts projection. */
export function profileStatusAdmits(
  profile: Pick<CredentialProfile, "credential_kind">,
  result: { availability: string; verification: string },
): boolean {
  const verificationAdmits =
    result.verification === "passed" ||
    (profile.credential_kind === "api_key" && result.verification === "not_run");
  return result.availability === "available" && verificationAdmits;
}

/** One fail-closed profile doctor wrapper shared by Accounts and runtime
 * selection. Probe failures are readiness facts, never selector exceptions. */
export async function probeCredentialProfileStatus(
  profile: CredentialProfile,
  probe?: (profile: CredentialProfile) => Promise<CredentialProfileStatus>,
): Promise<CredentialProfileStatus> {
  if (!probe) {
    return {
      profile_id: profile.profile_id,
      harness_id: profile.harness_id,
      availability: "unknown",
      verification: "not_run",
      verification_source: "local_store",
      detail: `harness "${profile.harness_id}" has no profile probe`,
      last_verified_at: null,
    };
  }
  try {
    const result = CredentialProfileStatusSchema.parse(await probe(profile));
    if (result.profile_id !== profile.profile_id || result.harness_id !== profile.harness_id) {
      throw new Error("profile readiness probe returned status for a different profile");
    }
    return {
      ...result,
      ...(result.detail === undefined ? {} : { detail: redactSecrets(result.detail) }),
    };
  } catch (error) {
    return {
      profile_id: profile.profile_id,
      harness_id: profile.harness_id,
      availability: "unknown",
      verification: "not_run",
      verification_source: "local_store",
      detail: `profile readiness probe failed: ${redactSecrets(
        error instanceof Error ? error.message : String(error),
      )}`,
      last_verified_at: null,
    };
  }
}

/** Same precedence used by run admission: the first explicit route wins;
 * `auto` means fall through rather than shadow a more general setting. */
export function effectiveAuthPreference(
  ...values: Array<AuthPreference | null | undefined>
): AuthPreference {
  return (
    values.find((value) => value !== undefined && value !== null && value !== "auto") ?? "auto"
  );
}

/** Fresh effective route for the unprofiled/default subject in Accounts. The
 * gateway status proves aggregate intent readiness; the schema auth estimator
 * then chooses the exact usable source under the same configured preference as
 * run admission. Returning the route (not merely a bool) keeps next_up labels
 * truthful when a native-capable harness falls back to an API key. */
export function defaultCredentialRoute(
  status: {
    status: "ok" | "degraded" | "unavailable";
    routableIntents: readonly unknown[];
    authSources: readonly AuthSourceReadiness[];
  },
  requested: AuthPreference,
): "local_session" | "api_key" | null {
  if (status.status !== "ok" || status.routableIntents.length === 0) return null;
  return estimateEffectiveAuthRoute(requested, status.authSources);
}

/** The informational identity an UNPINNED run of a harness would route to next
 * (INV-135 `next_up`) — the same routing owner that admits and rotates runs,
 * exposed for the accounts projection so no surface re-derives it. Never gates
 * routing: explicit control is a per-run `--profile` / per-thread pin.
 *
 * Semantics mirror run-time admission: an unpinned run's default subject is the
 * unprofiled/default credential when it participates in the ladder; enabled profiles route
 * only by explicit pin or, under `rotate`, as the quota-failover target when the
 * default subject is already over headroom. A disabled default leaves an
 * unpinned run with nothing routable. */
export type NextUpIdentity =
  | { kind: "profile"; profileId: string }
  | { kind: "native"; route: "local_session" | "api_key" }
  | { kind: "none"; reason: string };

export function nextUpIdentity(args: {
  registry: readonly CredentialProfile[];
  harnessId: string;
  policy: ProfilePolicy;
  snapshots: readonly QuotaSnapshot[];
  defaultEnabled: boolean;
  /** Fresh doctor/admission truth for the unprofiled default subject. */
  defaultReady: boolean;
  /** Effective source route of that default subject under configured auth preference. */
  defaultRoute: "local_session" | "api_key" | null;
  /** Profiles admitted by their fresh profile doctor probe in this snapshot. */
  readyProfileIds: ReadonlySet<string>;
  /** Known configured model, null for the native default, or omitted only when
   * this projection has no model context and must stay conservative. */
  model?: string | null;
}): NextUpIdentity {
  const {
    registry,
    harnessId,
    policy,
    snapshots,
    defaultEnabled,
    defaultReady,
    defaultRoute,
    readyProfileIds,
    model,
  } = args;
  if (!defaultEnabled) {
    return {
      kind: "none",
      reason: "the default credential is disabled; enable it or pin an account per-run (--profile)",
    };
  }
  if (!defaultReady) {
    return {
      kind: "none",
      reason: "the default credential is not ready; refresh Accounts or run `claudexor doctor`",
    };
  }
  // Under an EFFECTIVE `rotate` (explicit, or `auto` on a subscription route —
  // resolved by the SAME function admission uses, so next_up can never
  // disagree with the engine), a native/default subject already over its
  // headroom bound — or under an OBSERVED live quota block (A4: reactive
  // cooldown / spent window, stale-but-live included) — fails over to the next
  // eligible enabled profile BEFORE spawn — that is who an unpinned run routes
  // to next. Effective `ask`/`fail` proceed on the native default.
  if (effectiveLimitAction(policy, defaultRoute) === "rotate" && defaultRoute === "local_session") {
    const breach = profileHeadroomBreach(
      snapshots,
      harnessId,
      null,
      policy.headroom_threshold,
      model,
    );
    if (breach || profileQuotaBlock(snapshots, harnessId, null, model)) {
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
      if (next) return { kind: "profile", profileId: next.profile_id };
    }
  }
  if (!defaultRoute) {
    return {
      kind: "none",
      reason: "the default credential route is unknown; refresh Accounts or run `claudexor doctor`",
    };
  }
  return { kind: "native", route: defaultRoute };
}

/**
 * INV-135 at the engine boundary: a cached vendor session resumes ONLY under
 * exactly the profile it was recorded with (null-default equality included) —
 * regardless of what the caller's map claims. Preflight rotation changing the
 * profile therefore starts fresh.
 */
export function resumeSessionForProfile(
  cached: { sessionId: string; profileId: string | null } | undefined,
  profile: CredentialProfile | null,
): string | null {
  if (!cached) return null;
  return (cached.profileId ?? null) === (profile?.profile_id ?? null) ? cached.sessionId : null;
}

/**
 * Record a harness-emitted native session id for future thread resume; the
 * observer never fails the run. profileId is the adapter's per-event stamp —
 * the EFFECTIVE profile (rotation makes it differ from the requested id).
 */
export function observeNativeSessionEvent(
  input:
    | {
        onSessionObserved?: (
          harnessId: string,
          nativeSessionId: string,
          observedModel?: string | null,
          profileId?: string | null,
        ) => void;
      }
    | undefined,
  harnessId: string,
  ev: HarnessEvent,
): void {
  if (!input?.onSessionObserved || ev.type !== "started") return;
  const nid = ev.payload?.["native_session_id"];
  if (typeof nid === "string" && nid.length > 0) {
    try {
      input.onSessionObserved(
        harnessId,
        nid,
        ev.observed_model ?? null,
        ev.credential_profile_id ?? null,
      );
    } catch {
      /* observer errors must never fail the run */
    }
  }
}

import type {
  AuthPreference,
  AuthSourceReadiness,
  CredentialProfile,
  CredentialProfileStatus,
  HarnessEvent,
  QuotaSnapshot,
} from "@claudexor/schema";
import { redactSecrets } from "@claudexor/util";
import { estimateEffectiveAuthRoute } from "@claudexor/schema";
import {
  nextEligibleProfile,
  profileHeadroomBreach,
  type ProfilePolicy,
} from "./credential-profile-rotation.js";
export {
  nextEligibleProfile,
  planReactiveRotation,
  preflightCredentialProfile,
  preflightDefaultSubject,
  profileHeadroomBreach,
  rotateSpecOnTypedLimit,
  rotationRetryEligible,
  type HeadroomBreach,
  type ProfilePolicy,
} from "./credential-profile-rotation.js";

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
  probe?: (profile: CredentialProfile) => Promise<{
    availability: string;
    verification: string;
    detail?: string | null;
  }>;
}): Promise<string | null> {
  if (!input.profileId) return null;
  let profile: CredentialProfile;
  try {
    profile = resolveCredentialProfile(input.registry, input.profileId, input.harnessId);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  if (!input.probe) return `harness "${input.harnessId}" has no profile probe`;
  const result = await input.probe(profile);
  return profileStatusAdmits(profile, result)
    ? "available"
    : (result.detail ?? `${result.availability}/${result.verification}`);
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
      detail: `harness "${profile.harness_id}" has no profile probe`,
      last_verified_at: null,
    };
  }
  try {
    return await probe(profile);
  } catch (error) {
    return {
      profile_id: profile.profile_id,
      harness_id: profile.harness_id,
      availability: "unknown",
      verification: "not_run",
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
  // Under `rotate`, a native/default subject already over its headroom bound
  // fails over to the next eligible enabled profile BEFORE spawn — that is who
  // an unpinned run routes to next. `ask`/`fail` proceed on the native default.
  if (policy.limit_action === "rotate" && defaultRoute === "local_session") {
    const breach = profileHeadroomBreach(snapshots, harnessId, null, policy.headroom_threshold);
    if (breach) {
      const next = nextEligibleProfile(
        registry,
        harnessId,
        policy,
        null,
        snapshots,
        readyProfileIds,
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

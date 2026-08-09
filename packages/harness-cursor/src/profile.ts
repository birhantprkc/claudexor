import { join } from "node:path";
import {
  canonicalIsolationLocator,
  providerScrubEnv,
  type CredentialAccountProbeReceipt,
} from "@claudexor/core";
import type { AuthPreference, CredentialProfile, CredentialProfileStatus } from "@claudexor/schema";
import { CredentialProfileStatus as CredentialProfileStatusSchema } from "@claudexor/schema";
import { nowIso, redactSecrets } from "@claudexor/util";
import {
  cursorObservationAuthenticated,
  cursorObservationError,
  cursorObservationIdentity,
  cursorProfileKeyOrRefusal,
  probeCursorNativeAuth,
  type CursorAuthRoute,
  type CursorStatusObservation,
} from "./auth.js";
import type { CursorEventParser } from "./parse.js";

type EnvMap = Record<string, string | null | undefined>;

export interface CursorProfileRuntimeDeps {
  nativeAuthOk: typeof probeCursorNativeAuth;
  resolveProfileSecret: (ref: string) => string | null;
}

/** Canonical, Claudexor-owned HOME for one additive Cursor identity. */
export function canonicalCursorProfileHome(locator: string): string {
  return canonicalIsolationLocator(locator, "credential profile Cursor HOME");
}

/**
 * Cursor's vendor-supported file credential store is selected by HOME on
 * macOS, XDG_CONFIG_HOME on Linux, and APPDATA on Windows. Cursor's mutable
 * config/session data remains independently relocatable, so a run can keep
 * that state in its lane/envelope HOME while reading auth only from the named
 * profile HOME.
 */
export function cursorProfilePathEnv(
  profileHome: string,
  stateHome: string = profileHome,
): Record<string, string> {
  const home = canonicalCursorProfileHome(profileHome);
  const state = stateHome.trim() || home;
  return {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    XDG_CONFIG_HOME: join(home, ".config"),
    CURSOR_CONFIG_DIR: join(state, ".cursor"),
    CURSOR_DATA_DIR: join(state, ".cursor"),
    AGENT_CLI_CREDENTIAL_STORE: "file",
  };
}

/** Exact strict-profile run/probe environment; never bridges the host Keychain. */
export function cursorProfileRunEnv(profileHome: string, specEnv: EnvMap = {}): EnvMap {
  const stateHome = specEnv["HOME"] || profileHome;
  return {
    ...specEnv,
    ...providerScrubEnv(),
    ...cursorProfilePathEnv(profileHome, stateHome),
    CURSOR_API_KEY: null,
  };
}

export type CursorResolvedProfileRoute =
  { kind: "native"; env: EnvMap } | { kind: "api_key"; key: string } | { refusal: string };

/** Strict profile resolution: the named identity or a typed refusal, never default auth. */
export async function resolveCursorProfileRoute(
  profile: CredentialProfile,
  specEnv: EnvMap,
  runtime: CursorProfileRuntimeDeps,
  abortSignal?: AbortSignal,
): Promise<CursorResolvedProfileRoute> {
  if (profile.credential_kind === "config_dir_login") {
    try {
      const env = cursorProfileRunEnv(profile.isolation_locator ?? "", specEnv);
      const probe = await runtime.nativeAuthOk(env, abortSignal);
      if (cursorObservationAuthenticated(probe)) return { kind: "native", env };
      const probeError = cursorObservationError(probe);
      return {
        refusal: probeError
          ? `credential profile "${profile.profile_id}": Cursor status probe failed — ${probeError}`
          : `credential profile "${profile.profile_id}" has no Cursor login in its profile HOME (run the profile login first)`,
      };
    } catch (err) {
      return { refusal: err instanceof Error ? err.message : String(err) };
    }
  }
  const gate = cursorProfileKeyOrRefusal(profile, runtime.resolveProfileSecret);
  return "refusal" in gate ? gate : { kind: "api_key", key: gate.key };
}

/** The resolved auth route a cursor run executes with (profile or default ladder). */
export type CursorRunRoute = {
  route: CursorAuthRoute;
  env: EnvMap;
  key: string | null;
  nativeAuthed: boolean;
  scopedHome: boolean;
};

export type CursorDefaultRouteInput = {
  env: EnvMap;
  authPreference: AuthPreference;
  abortSignal: AbortSignal | undefined;
  bridgeNativeSession: boolean;
  /** Set only for API-key profiles: overrides the default key lookup (INV-062 transient). */
  cursorApiKey?: (env?: EnvMap) => string | null;
};

/**
 * INV-135 strict profile routing for a run: named native profiles use Cursor's
 * own file credential store; API-key profiles keep their existing smoked route.
 * Neither path receives the default host-Keychain bridge. Without a profile the
 * caller-supplied default resolver runs the engine-default credential ladder.
 */
export async function resolveCursorRunRoute(
  spec: {
    credential_profile: CredentialProfile | null;
    env: EnvMap;
    auth_preference: AuthPreference;
  },
  runtime: CursorProfileRuntimeDeps,
  resolveDefaultRoute: (input: CursorDefaultRouteInput) => Promise<CursorRunRoute>,
  abortSignal?: AbortSignal,
): Promise<CursorRunRoute | { refusal: string }> {
  const profile = spec.credential_profile;
  const profileRoute = profile
    ? await resolveCursorProfileRoute(profile, spec.env, runtime, abortSignal)
    : null;
  if (profileRoute && "refusal" in profileRoute) return profileRoute;
  if (profileRoute?.kind === "native")
    return {
      route: "local_session",
      env: profileRoute.env,
      key: null,
      nativeAuthed: true,
      scopedHome: Boolean(spec.env["HOME"]),
    };
  const keyOverride = profileRoute?.kind === "api_key" ? profileRoute.key : null;
  return resolveDefaultRoute({
    env: spec.env,
    authPreference: profile ? "api_key" : spec.auth_preference,
    abortSignal,
    bridgeNativeSession: profile === null,
    ...(keyOverride === null ? {} : { cursorApiKey: () => keyOverride }),
  });
}

/** INV-135 attribution: stamp every parsed run event with the profile that ran it. */
export function stampCursorProfileEvents(
  profile: CredentialProfile | null,
  parse: CursorEventParser,
): CursorEventParser {
  if (!profile) return parse;
  return (obj, sessionId) => {
    const out = parse(obj, sessionId);
    if (out) for (const ev of out) ev.credential_profile_id = profile.profile_id;
    return out;
  };
}

function cursorProfileNativeStatus(
  profile: CredentialProfile,
  probe: CursorStatusObservation,
): CredentialProfileStatus {
  const base = { profile_id: profile.profile_id, harness_id: "cursor" };
  if (cursorObservationAuthenticated(probe))
    return CredentialProfileStatusSchema.parse({
      ...base,
      availability: "available",
      verification: "passed",
      detail: "Cursor login verified in the profile HOME file store",
      last_verified_at: nowIso(),
    });
  const probeError = cursorObservationError(probe);
  if (probeError)
    return CredentialProfileStatusSchema.parse({
      ...base,
      availability: "unknown",
      verification: "not_run",
      detail: probeError,
    });
  return CredentialProfileStatusSchema.parse({
    ...base,
    availability: "unavailable",
    verification: "not_run",
    detail: "no Cursor login in the profile HOME (run the profile login)",
  });
}

/**
 * Doctor projection for one Cursor profile, using the same route resolver
 * facts. INV-135 (release wave round-15 #1): a valid cursor profile must admit
 * the route even when the default store is logged out — the orchestrator
 * consults THIS probe to override the default auth verdict.
 */
export async function probeCursorCredentialProfile(
  profile: CredentialProfile,
  runtime: CursorProfileRuntimeDeps,
  abortSignal?: AbortSignal,
): Promise<CredentialProfileStatus> {
  return (await probeCursorCredentialAccount(profile, runtime, abortSignal)).status;
}

/** Accounts-only rich probe: readiness and optional email share one status call. */
export async function probeCursorCredentialAccount(
  profile: CredentialProfile,
  runtime: CursorProfileRuntimeDeps,
  abortSignal?: AbortSignal,
): Promise<CredentialAccountProbeReceipt> {
  if (profile.credential_kind !== "config_dir_login") {
    const base = { profile_id: profile.profile_id, harness_id: "cursor" };
    try {
      const gate = cursorProfileKeyOrRefusal(profile, runtime.resolveProfileSecret);
      if ("refusal" in gate)
        return {
          status: CredentialProfileStatusSchema.parse({
            ...base,
            availability: "unavailable",
            verification: gate.reason === "missing_secret" ? "not_run" : "failed",
            detail: gate.refusal,
          }),
          identity: null,
        };
      return {
        status: CredentialProfileStatusSchema.parse({
          ...base,
          availability: "available",
          verification: "not_run",
          detail: `secret "${profile.secret_ref}" is stored`,
        }),
        identity: null,
      };
    } catch (err) {
      return {
        status: CredentialProfileStatusSchema.parse({
          ...base,
          availability: "unavailable",
          verification: "failed",
          detail: redactSecrets(err instanceof Error ? err.message : String(err)).slice(0, 300),
        }),
        identity: null,
      };
    }
  }
  try {
    const env = cursorProfileRunEnv(profile.isolation_locator ?? "");
    const observation = await runtime.nativeAuthOk(env, abortSignal);
    return {
      status: cursorProfileNativeStatus(profile, observation),
      identity: cursorObservationIdentity(observation),
    };
  } catch (err) {
    return {
      status: CredentialProfileStatusSchema.parse({
        profile_id: profile.profile_id,
        harness_id: "cursor",
        availability: "unavailable",
        verification: "failed",
        detail: redactSecrets(err instanceof Error ? err.message : String(err)).slice(0, 300),
      }),
      identity: null,
    };
  }
}

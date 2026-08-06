import { namespacedSecretRefBase, resolveSecret } from "@claudexor/secrets";
import type { AuthPreference } from "@claudexor/schema";
import { runCapture } from "@claudexor/core";
import { redactSecrets } from "@claudexor/util";

const BIN = process.env.CLAUDEXOR_CURSOR_BIN || "cursor-agent";
const CURSOR_LOGGED_OUT =
  /not logged in|not authenticated|unauthenticated|authentication required|no account|account\s*:\s*(?:none|unknown|not configured|-)(?:\s|$)|authenticated\s*:\s*(?:false|no|none|0)|logged in\s*:\s*(?:false|no|none|0)/i;

export interface CursorNativeAuthProbe {
  authed: boolean;
  probeError: string | null;
}

/** Probe only Cursor's vendor-owned native session in the supplied run env. */
export async function probeCursorNativeAuth(
  env?: Record<string, string | null | undefined>,
  abortSignal?: AbortSignal,
  capture: typeof runCapture = runCapture,
): Promise<CursorNativeAuthProbe> {
  try {
    const result = await capture(BIN, ["status"], {
      env,
      timeoutMs: 10_000,
      abortSignal,
      cancelSignal: "SIGTERM",
      cancelKillDelayMs: 0,
    });
    const text = `${result.stdout}\n${result.stderr}`;
    if (cursorStatusAuthenticated(result.code, text)) return { authed: true, probeError: null };
    if (cursorStatusLoggedOut(text)) return { authed: false, probeError: null };
    // Status output can contain the signed-in account principal. Unknown
    // output is not evidence and must not be copied into doctor/setup logs.
    const verdict = result.code === 0 ? "returned unrecognized output" : "failed";
    const detail = `cursor-agent status ${verdict} (${result.code ?? result.signal ?? "unknown result"})`;
    return { authed: false, probeError: detail };
  } catch (err) {
    return {
      authed: false,
      probeError: redactSecrets(err instanceof Error ? err.message : String(err)).slice(0, 500),
    };
  }
}

export function cursorStatusAuthenticated(code: number | null, text: string): boolean {
  if (code !== 0) return false;
  if (cursorStatusLoggedOut(text)) return false;
  // Accepted grammar is intentionally narrow and vendor-facing: an explicit
  // "logged in" / "authenticated" verdict, or an Account field containing an
  // email-shaped principal. Bare "account" prose is never readiness proof.
  return text
    .replaceAll("\r", "")
    .split("\n")
    .some((rawLine) => {
      const line = rawLine.trim().replace(/^✓\s+/, "");
      return (
        /^logged in(?:\s+as\s+\S+)?[.!]?$/i.test(line) ||
        /^authenticated[.!]?$/i.test(line) ||
        /^account\s*:\s*[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(line)
      );
    });
}

export function cursorStatusLoggedOut(text: string): boolean {
  return CURSOR_LOGGED_OUT.test(text);
}

export type CursorAuthRoute = "api_key" | "local_session" | "unavailable";

/** Explicit preferences are strict; auto is invariantly native-first. */
export function selectCursorAuthRoute(input: {
  authPreference: AuthPreference;
  hasKey: boolean;
  apiKeyReady: boolean;
  nativeAuthed: boolean;
  scopedHome: boolean;
}): CursorAuthRoute {
  const keyRouteReady = input.hasKey && input.apiKeyReady;
  if (input.authPreference === "api_key") return keyRouteReady ? "api_key" : "unavailable";
  if (input.authPreference === "subscription")
    return input.nativeAuthed ? "local_session" : "unavailable";
  if (input.nativeAuthed) return "local_session";
  return keyRouteReady ? "api_key" : "unavailable";
}

export function shouldDiscloseCursorAutoApiRoute(input: {
  authPreference: AuthPreference;
  route: CursorAuthRoute;
  nativeAuthed: boolean;
}): boolean {
  return input.authPreference === "auto" && input.route === "api_key";
}

/** A probe error is unknown, not proof that native is unavailable. */
export function shouldSmokeCursorApiKey(input: {
  hasKey: boolean;
  authPreference: AuthPreference;
  nativeAuthed: boolean;
  nativeProbeError: string | null;
}): boolean {
  if (!input.hasKey || input.authPreference === "subscription") return false;
  if (input.authPreference === "api_key") return true;
  return !input.nativeAuthed && input.nativeProbeError === null;
}

/**
 * INV-135: an API-key cursor profile is exactly its namespaced secret-ref key.
 * `config_dir_login` profiles are supported but resolved earlier by the
 * profile route owner (profile.ts), so this helper only ever sees the
 * remaining kinds: a non-api_key kind here (e.g. `oauth_token`), a
 * non-namespaced or foreign-slot ref (which would alias the engine default or
 * route another provider's key), and a missing secret are a typed refusal,
 * never the default ladder. ONE owner for the run route and the doctor probe.
 */
export function cursorProfileKeyOrRefusal(
  profile: {
    profile_id: string;
    credential_kind: string;
    secret_ref: string | null;
  },
  resolve: (ref: string) => string | null = resolveSecret,
): { key: string } | { refusal: string; reason: "misconfigured" | "missing_secret" } {
  if (profile.credential_kind !== "api_key")
    return {
      refusal: `credential profile "${profile.profile_id}": cursor credential kind "${profile.credential_kind}" is not supported (use api_key or config_dir_login)`,
      reason: "misconfigured",
    };
  const ref = profile.secret_ref ?? "";
  if (namespacedSecretRefBase(ref) !== "cursor")
    return {
      refusal: `credential profile "${profile.profile_id}": api_key secret_ref must use a namespaced cursor slot (base:profile, e.g. cursor:${profile.profile_id}; got "${ref}")`,
      reason: "misconfigured",
    };
  const key = resolve(ref);
  if (!key)
    return {
      refusal: `credential profile "${profile.profile_id}": secret "${ref}" is not stored`,
      reason: "missing_secret",
    };
  return { key };
}

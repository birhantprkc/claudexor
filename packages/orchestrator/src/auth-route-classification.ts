import type { AuthPreference } from "@claudexor/schema";

/**
 * Auth-mode classification for route ranking and billing evidence (#121
 * part 1). Two small total maps keep the ladder in `orderPool` /
 * `routeBillingKnowledge` honest: a lane's classification comes from the
 * FROZEN quota-admission credential route when one exists, else from the
 * RESOLVED auth preference (per-run > per-harness config > global config via
 * `authPreferenceForHarness`) — never from the raw run input, which reads
 * `auto` for every config-level preference user.
 */

/** The routing auth mode a frozen quota-admission credential route proves. */
export function authModeForCredentialRoute(
  route: "managed_api_key" | "vendor_native" | null,
): "api_key" | "local_session" | null {
  if (route === "managed_api_key") return "api_key";
  if (route === "vendor_native") return "local_session";
  return null;
}

/** The routing auth mode a RESOLVED preference claims; `auto` claims none
 * (the caller falls back to settled-metric/manifest evidence). */
export function authModeForPreference(
  preference: AuthPreference,
): "api_key" | "local_session" | null {
  if (preference === "api_key") return "api_key";
  if (preference === "subscription") return "local_session";
  return null;
}

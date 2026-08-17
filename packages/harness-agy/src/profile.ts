import { statSync } from "node:fs";
import { join } from "node:path";
import { canonicalIsolationLocator, providerScrubEnv, runCapture } from "@claudexor/core";
import type { CredentialProfile, CredentialProfileStatus } from "@claudexor/schema";
import { CredentialProfileStatus as CredentialProfileStatusSchema } from "@claudexor/schema";
import { nowIso, redactSecrets } from "@claudexor/util";

type EnvMap = Record<string, string | null | undefined>;

export const AGY_BIN = () => process.env.CLAUDEXOR_AGY_BIN || "agy";

/** Canonical, Claudexor-owned HOME for one named Antigravity identity. */
export function canonicalAgyProfileHome(locator: string): string {
  return canonicalIsolationLocator(locator, "credential profile Antigravity HOME");
}

/**
 * The vendor's file-based OAuth token inside a profile HOME. agy lands on
 * file storage because its keyring lookup FAILS in a scoped HOME (macOS: no
 * login keychain in `$HOME/Library/Keychains` → `falling back to file`); the
 * profile mechanism therefore REQUIRES that no keychain ever be created
 * inside the profile HOME. Live-proven on three separate Google accounts
 * (PLAN §1.2a-1.2c); re-proven per AGY_VENDOR_CLI_VERSION bump because the
 * fallback is a vendor error path, not a documented mode (R-2').
 */
export function agyTokenPath(profileHome: string): string {
  return join(profileHome, ".gemini", "antigravity-cli", "antigravity-oauth-token");
}

/** The token must be a regular FILE: a directory at that path is a malformed
 * profile, not a login, and must refuse rather than route (Ф0 review #11). */
export function agyTokenFilePresent(profileHome: string): boolean {
  try {
    return statSync(agyTokenPath(profileHome)).isFile();
  } catch {
    return false;
  }
}

/**
 * Exact strict-profile env: the profile HOME selects the vendor's whole
 * config root (`$HOME/.gemini/...`) — agy has no config-dir env var, HOME is
 * the single lever. `USERPROFILE` mirrors HOME for the win32 resolver, the
 * auto-updater is pinned off so the closed vendor binary cannot replace
 * itself mid-run, and the provider scrub drops every API-key route
 * (`GEMINI_API_KEY` included) so a native subscription run can never silently
 * turn metered (INV-061).
 *
 * Unlike Cursor — whose mutable state is separately relocatable via
 * `CURSOR_CONFIG_DIR`, so a run keeps state in its LANE home and reads auth
 * from the profile — agy has exactly one lever. Overriding HOME therefore
 * moves the vendor's conversations/brain/cache into the profile HOME too, and
 * the per-lane home is unused for agy runs. Deliberate, not an oversight: a
 * lane-scoped `.gemini` would be a dead directory the vendor never reads.
 * What holds today is per-lane RESUME: a lane replays its own vendor
 * conversation by id (`--conversation`, INV-137). Nothing scopes those
 * conversations to a lane yet — the vendor's project mechanism
 * (`--new-project`/`--project`, Л-19) is not wired here — so one profile HOME
 * accumulates every thread's vendor state, and conversations are NOT scoped per
 * chat thread.
 */
export function agyProfileRunEnv(profileHome: string, specEnv: EnvMap = {}): EnvMap {
  const home = canonicalAgyProfileHome(profileHome);
  return {
    ...specEnv,
    ...providerScrubEnv(),
    HOME: home,
    USERPROFILE: home,
    AGY_CLI_DISABLE_AUTO_UPDATE: "true",
  };
}

export type AgyResolvedProfileRoute = { home: string; env: EnvMap } | { refusal: string };

/**
 * INV-135 strict profile routing: an agy profile is exactly its
 * `config_dir_login` HOME with a present vendor token file, or a typed
 * refusal. There is NO engine-default agy credential (owner decision Л-4),
 * so no fallback ladder exists to fall into.
 */
export function resolveAgyProfileRoute(
  profile: Pick<CredentialProfile, "profile_id" | "credential_kind" | "isolation_locator">,
  specEnv: EnvMap = {},
): AgyResolvedProfileRoute {
  if (profile.credential_kind !== "config_dir_login")
    return {
      refusal: `credential profile "${profile.profile_id}": agy supports only the config_dir_login transport (a named profile HOME)`,
    };
  try {
    const home = canonicalAgyProfileHome(profile.isolation_locator ?? "");
    if (!agyTokenFilePresent(home))
      return {
        refusal: `credential profile "${profile.profile_id}" has no Antigravity login in its profile HOME (run \`claudexor profiles login agy ${profile.profile_id}\` first)`,
      };
    return { home, env: agyProfileRunEnv(home, specEnv) };
  } catch (err) {
    return { refusal: err instanceof Error ? err.message : String(err) };
  }
}

export interface AgyProfileProbeDeps {
  /** Injectable live probe (tests): print-mode `/model` under the profile env. */
  runModelProbe: (env: EnvMap, abortSignal?: AbortSignal) => Promise<AgyModelProbe>;
}

export type AgyModelProbe =
  | { kind: "authenticated"; modelId: string | null }
  | { kind: "unauthenticated"; detail: string }
  | { kind: "probe_failed"; detail: string };

/**
 * Quota-free liveness probe: `agy -p "/model" --output-format json` answers
 * from the CLI without spending a turn (vendor 1.1.11+ print-mode
 * slash-commands). SUCCESS proves the profile's token authenticates in the
 * exact env its runs will spawn with (INV-067); an auth error is an honest
 * logged-out/revoked verdict, and a spawn/parse failure stays `unknown`.
 */
export async function defaultAgyModelProbe(
  env: EnvMap,
  abortSignal?: AbortSignal,
): Promise<AgyModelProbe> {
  try {
    const r = await runCapture(AGY_BIN(), ["-p", "/model", "--output-format", "json"], {
      timeoutMs: 30_000,
      env,
      abortSignal,
      cancelSignal: "SIGTERM",
    });
    const parsed = JSON.parse(r.stdout.trim() || "{}");
    if (parsed?.status === "SUCCESS")
      return {
        kind: "authenticated",
        modelId: typeof parsed?.command?.data?.id === "string" ? parsed.command.data.id : null,
      };
    return {
      kind: "unauthenticated",
      detail: redactSecrets(String(parsed?.error ?? "authentication required")).slice(0, 300),
    };
  } catch (err) {
    return {
      kind: "probe_failed",
      detail: redactSecrets(err instanceof Error ? err.message : String(err)).slice(0, 300),
    };
  }
}

/**
 * Doctor projection for one agy profile (INV-135): the SAME route resolution
 * the run uses, then the quota-free live probe. A valid profile must admit
 * the route even though agy has no default store at all — the orchestrator
 * consults THIS probe for pinned routing.
 */
export async function probeAgyCredentialProfile(
  profile: CredentialProfile,
  deps: AgyProfileProbeDeps = { runModelProbe: defaultAgyModelProbe },
  abortSignal?: AbortSignal,
): Promise<CredentialProfileStatus> {
  const base = { profile_id: profile.profile_id, harness_id: "agy" };
  const route = resolveAgyProfileRoute(profile);
  if ("refusal" in route)
    return CredentialProfileStatusSchema.parse({
      ...base,
      availability: "unavailable",
      verification: "not_run",
      detail: route.refusal,
    });
  const probe = await deps.runModelProbe(route.env, abortSignal);
  if (probe.kind === "authenticated")
    return CredentialProfileStatusSchema.parse({
      ...base,
      availability: "available",
      verification: "passed",
      detail: `Antigravity login verified in the profile HOME${probe.modelId ? ` (model ${probe.modelId})` : ""}`,
      last_verified_at: nowIso(),
    });
  if (probe.kind === "unauthenticated")
    return CredentialProfileStatusSchema.parse({
      ...base,
      availability: "unavailable",
      verification: "failed",
      detail: `Antigravity token present but not accepted: ${probe.detail}`,
    });
  return CredentialProfileStatusSchema.parse({
    ...base,
    availability: "unknown",
    verification: "not_run",
    detail: probe.detail,
  });
}

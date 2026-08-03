/**
 * Per-harness ACCOUNTS AUTHORITY projection (INV-135): the native "CLI login"
 * pseudo-row state and the informational `next_up` identity (who an UNPINNED
 * run would route to next), built ONCE on the server so no surface (CLI, macOS)
 * re-derives the accounts symmetry. Native-login detection reads the cached
 * doctor status (a `native_session` source reported available); a probe failure
 * is an honest "not detected", never a thrown listing. `next_up` is computed by
 * the routing owner (`nextUpIdentity`) from enabled profiles + native readiness
 * + quota, so it can never disagree with run-time admission.
 */
import type {
  AccountIdentity,
  ControlHarnessAccounts,
  CredentialProfile,
  CredentialProfileStatus,
  QuotaSnapshot,
} from "@claudexor/schema";
import { loadConfig } from "@claudexor/config";
import {
  defaultCredentialRoute,
  effectiveAuthPreference,
  nextUpIdentity,
  probeCredentialProfileStatus,
  profileStatusAdmits,
} from "@claudexor/orchestrator";
import type { HarnessStatus } from "@claudexor/gateway";
import { codexAccountIdentity, defaultNativeCodexHome } from "@claudexor/harness-codex";
import { claudeAccountIdentity, defaultNativeClaudeConfigDir } from "@claudexor/harness-claude";
import { buildGateway, buildRegistry } from "./registry.js";

/**
 * Non-secret {email, plan} of a harness's NATIVE/CLI login, read daemon-side
 * from the Claudexor-owned native store (never the ordinary vendor home). Only
 * the config_dir_login families (codex, claude) have a readable native store;
 * every other harness projects no native identity.
 */
function nativeAccountIdentity(harnessId: string): AccountIdentity | null {
  if (harnessId === "codex") return codexAccountIdentity(defaultNativeCodexHome());
  if (harnessId === "claude") return claudeAccountIdentity(defaultNativeClaudeConfigDir());
  return null;
}

/**
 * Non-secret {email, plan} of a config_dir_login PROFILE, read daemon-side from
 * the profile's OWN isolation-locator store (INV-067) — never the ordinary
 * vendor home. Secret-ref profiles (no isolation_locator) and non-config_dir
 * families project no identity.
 */
export function profileAccountIdentity(profile: CredentialProfile): AccountIdentity | null {
  if (!profile.isolation_locator) return null;
  if (profile.harness_id === "codex") return codexAccountIdentity(profile.isolation_locator);
  if (profile.harness_id === "claude") return claudeAccountIdentity(profile.isolation_locator);
  return null;
}

/**
 * Doctor readiness projection for one credential profile (INV-135) — the ONE
 * live probe the accounts response and the profile mutation receipts share.
 * Adapters without profile support report an honest unknown.
 */
export async function profileDoctorStatus(
  profile: CredentialProfile,
): Promise<CredentialProfileStatus> {
  const adapter = buildRegistry().get(profile.harness_id);
  return probeCredentialProfileStatus(profile, adapter?.probeCredentialProfile?.bind(adapter));
}

export async function harnessAccountsProjection(
  repoRoot: string,
  quotaSnapshots: readonly QuotaSnapshot[] = [],
  snapshot?: {
    statuses?: readonly HarnessStatus[];
    profiles?: readonly { profile: CredentialProfile; status: CredentialProfileStatus }[];
  },
): Promise<ControlHarnessAccounts[]> {
  const cfg = loadConfig(repoRoot).global;
  const harnessIds = [...buildRegistry({ includeFakes: false }).keys()].sort();
  const nativeDetected = new Map<string, boolean>();
  let statuses: readonly HarnessStatus[] = snapshot?.statuses ?? [];
  if (!snapshot?.statuses) {
    try {
      statuses = await buildGateway({ includeFakes: false }).statusAll(
        { cwd: repoRoot, fresh: true },
        harnessIds,
      );
    } catch {
      statuses = [];
    }
  }
  const defaultRoutes = new Map<string, "local_session" | "api_key">();
  for (const s of statuses) {
    const native = s.authSources.find((source) => source.source === "native_session");
    const detected = native?.availability === "available";
    nativeDetected.set(s.id, detected);
    const harness = cfg.harnesses[s.id];
    const route = defaultCredentialRoute(
      s,
      effectiveAuthPreference(harness?.auth_preference, cfg.routing.auth_preference),
    );
    if (route) defaultRoutes.set(s.id, route);
  }
  const readyProfiles = new Map<string, Set<string>>();
  for (const entry of snapshot?.profiles ?? []) {
    if (!entry.profile.enabled || !profileStatusAdmits(entry.profile, entry.status)) continue;
    const ready = readyProfiles.get(entry.profile.harness_id) ?? new Set<string>();
    ready.add(entry.profile.profile_id);
    readyProfiles.set(entry.profile.harness_id, ready);
  }
  return harnessIds.map((harnessId): ControlHarnessAccounts => {
    const h = cfg.harnesses[harnessId];
    const nativeEnabled = h?.native_credentials_enabled ?? true;
    const defaultEnabled = (h?.enabled ?? true) && nativeEnabled;
    const defaultRoute = defaultRoutes.get(harnessId) ?? null;
    return {
      harness_id: harnessId,
      native_credentials_enabled: nativeEnabled,
      native_login_detected: nativeDetected.get(harnessId) ?? false,
      identity: nativeAccountIdentity(harnessId),
      // The routing owner computes who an unpinned run routes to next — the
      // accounts projection never re-derives it (INV-135).
      next_up: nextUpIdentity({
        registry: cfg.credential_profiles,
        harnessId,
        policy: h?.profile_policy ?? {
          limit_action: "fail",
          rotation_eligible: [],
          headroom_threshold: 0.9,
        },
        snapshots: quotaSnapshots,
        defaultEnabled,
        defaultReady: defaultRoute !== null,
        defaultRoute,
        readyProfileIds: readyProfiles.get(harnessId) ?? new Set(),
        model: h?.default_model ?? null,
      }),
    };
  });
}

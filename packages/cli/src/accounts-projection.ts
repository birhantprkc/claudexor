/**
 * Per-harness POOL AUTHORITY projection of the unified account model
 * (INV-135): every account is a named registry row; `accountPools` carries
 * the routing facts (who an UNPINNED run routes to next), computed ONCE on
 * the server by the same pool owner run admission uses so no surface
 * re-derives it. The legacy `harnessAccounts` carrier stays on the wire as
 * `[]` for strict old clients; its native "CLI login" pseudo-row is gone —
 * detected default-store logins are auto-registered as ordinary rows at
 * daemon start.
 */
import type {
  AccountIdentity,
  ControlHarnessAccountPool,
  CredentialProfile,
  CredentialProfileStatus,
  QuotaSnapshot,
} from "@claudexor/schema";
import {
  AccountIdentity as AccountIdentitySchema,
  estimateEffectiveAuthRoute,
} from "@claudexor/schema";
import { loadConfig } from "@claudexor/config";
import {
  effectiveAuthPreference,
  probeCredentialProfileStatus,
  profileStatusAdmits,
  selectFromAccountPool,
} from "@claudexor/orchestrator";
import type { HarnessStatus } from "@claudexor/gateway";
import { codexAccountIdentity } from "@claudexor/harness-codex";
import { claudeAccountIdentity } from "@claudexor/harness-claude";
import { buildGateway, buildRegistry } from "./registry.js";

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

/**
 * Accounts projection for one named profile. A rich adapter owns readiness and
 * identity in ONE call; adapters without it keep the existing doctor + owned-
 * store identity path. A malformed rich receipt loses identity and fails
 * closed through the shared readiness wrapper.
 */
export async function profileAccountProjection(profile: CredentialProfile): Promise<{
  profile: CredentialProfile;
  status: CredentialProfileStatus;
  identity: AccountIdentity | null;
}> {
  const adapter = buildRegistry().get(profile.harness_id);
  if (!adapter?.probeCredentialAccount) {
    return {
      profile,
      status: await probeCredentialProfileStatus(
        profile,
        adapter?.probeCredentialProfile?.bind(adapter),
      ),
      identity: profileAccountIdentity(profile),
    };
  }
  let identity: AccountIdentity | null = null;
  const status = await probeCredentialProfileStatus(profile, async (candidate) => {
    const receipt = await adapter.probeCredentialAccount!(candidate);
    if (
      receipt.status.profile_id !== candidate.profile_id ||
      receipt.status.harness_id !== candidate.harness_id
    ) {
      throw new Error("profile account probe returned a receipt for a different profile");
    }
    identity = receipt.identity === null ? null : AccountIdentitySchema.parse(receipt.identity);
    return receipt.status;
  });
  return { profile, status, identity };
}

/**
 * The per-harness pool routing verdict (`GET /v2/account-pools` and the
 * additive `accountPools` key of the credential-profiles response). Routing
 * facts ONLY — account facts live on the profile rows. The API-key ROUTE
 * appears exclusively here (`api_key_route`) so legacy strict `next_up`
 * decoders never see an unknown kind.
 */
export async function accountPoolsProjection(
  repoRoot: string,
  quotaSnapshots: readonly QuotaSnapshot[] = [],
  snapshot?: {
    statuses?: readonly HarnessStatus[];
    profiles?: readonly { profile: CredentialProfile; status: CredentialProfileStatus }[];
  },
): Promise<ControlHarnessAccountPool[]> {
  const cfg = loadConfig(repoRoot).global;
  const harnessIds = [...buildRegistry({ includeFakes: false }).keys()].sort();
  let statuses: readonly HarnessStatus[] = snapshot?.statuses ?? [];
  if (!snapshot?.statuses) {
    try {
      statuses = await buildGateway({ includeFakes: false }).statusAll(
        { cwd: repoRoot },
        harnessIds,
      );
    } catch {
      statuses = [];
    }
  }
  const statusById = new Map(statuses.map((status) => [status.id, status]));
  const readyProfiles = new Map<string, Set<string>>();
  for (const entry of snapshot?.profiles ?? []) {
    if (!entry.profile.enabled || !profileStatusAdmits(entry.profile, entry.status)) continue;
    const ready = readyProfiles.get(entry.profile.harness_id) ?? new Set<string>();
    ready.add(entry.profile.profile_id);
    readyProfiles.set(entry.profile.harness_id, ready);
  }
  return harnessIds.map((harnessId): ControlHarnessAccountPool => {
    const h = cfg.harnesses[harnessId];
    if (h?.enabled === false) {
      return {
        harness_id: harnessId,
        next_up: {
          kind: "none",
          reason: `harness is disabled in settings (harnesses.${harnessId}.enabled=false)`,
        },
      };
    }
    const selection = selectFromAccountPool({
      registry: cfg.credential_profiles,
      harnessId,
      snapshots: quotaSnapshots,
      readyProfileIds: readyProfiles.get(harnessId) ?? new Set(),
      headroomThreshold: h?.profile_policy?.headroom_threshold ?? 0.9,
      model: h?.default_model ?? null,
    });
    if (selection.outcome === "selected") {
      return {
        harness_id: harnessId,
        next_up: { kind: "profile", profileId: selection.candidate.profile.profile_id },
      };
    }
    // Pool exhaustion counts as unavailability for the policy-governed API-key
    // ROUTE fallback (INV-061, owner Q2=A) — a route, never an account row.
    const preference = effectiveAuthPreference(h?.auth_preference, cfg.routing.auth_preference);
    const status = statusById.get(harnessId);
    const keyRouteReady =
      preference !== "subscription" &&
      status !== undefined &&
      estimateEffectiveAuthRoute("api_key", status.authSources) === "api_key";
    if (keyRouteReady) {
      return { harness_id: harnessId, next_up: { kind: "api_key_route" } };
    }
    return {
      harness_id: harnessId,
      next_up: {
        kind: "none",
        reason:
          selection.outcome === "exhausted"
            ? `every enabled account is over its quota window${selection.resets_at ? ` (earliest reset ${selection.resets_at})` : ""} and no API-key route is available`
            : "no enabled account is signed in for this harness; connect an account or pin one per-run (--profile)",
      },
    };
  });
}

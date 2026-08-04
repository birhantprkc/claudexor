import { loadConfig } from "@claudexor/config";
import type { QuotaRegistry } from "@claudexor/daemon";
import { StatusProjectionCache, globalConfigVersion } from "./status-projection-cache.js";
import { normalizeReadiness, type HarnessStatus } from "@claudexor/gateway";
import { probeGitCapability } from "@claudexor/workspace";
import { noProjectRepoRoot } from "@claudexor/util";
import { validateModel } from "@claudexor/core";
import type {
  CredentialProfile,
  CredentialProfileStatus,
  QuotaAbsence,
  QuotaSnapshot,
} from "@claudexor/schema";
import { vendorVerifiedProfileStatus } from "@claudexor/orchestrator";
import {
  harnessAccountsProjection,
  profileAccountIdentity,
  profileDoctorStatus,
} from "./accounts-projection.js";
import { buildGateway, harnessModels } from "./registry.js";
import { delegationCapabilityFor } from "./delegation-capability.js";

const NO_PROJECT_ROOT = noProjectRepoRoot();

export type HarnessListInput = {
  fresh?: boolean;
  includeFakes?: boolean;
  harnessIds?: string[];
};

export async function projectHarnessStatuses(statuses: readonly HarnessStatus[]) {
  const cfg = loadConfig(NO_PROJECT_ROOT);
  return Promise.all(
    statuses.map(async (status) => {
      const configured = cfg.global.harnesses[status.id]?.default_model ?? null;
      let check: { status: "ok" | "rejected"; message?: string | null } | null = null;
      if (configured) {
        const truth = await harnessModels(status.id, NO_PROJECT_ROOT, true);
        check = validateModel(
          configured,
          truth.models.map((model) => model.id),
          truth.source === "api" ? "api" : "manifest",
        );
      }
      return {
        ...status,
        configuredModel: configured,
        configuredModelCheck: check,
        delegation: delegationCapabilityFor(status.manifest),
        readiness: normalizeReadiness({
          checks: status.checks,
          authSources: status.authSources,
          configuredModel: configured,
          configuredModelCheck: check,
        }),
      };
    }),
  );
}

/** One server-owned Accounts response builder. The opt-in form refreshes quota
 * first and then derives next_up from that exact returned response; no client
 * can accidentally pair a newer quota card with an older routing identity. */
export function createCredentialProfilesService(quotaRegistry: () => QuotaRegistry) {
  const projectProfiles = () => {
    const profiles = loadConfig(NO_PROJECT_ROOT).global.credential_profiles;
    return Promise.all(
      profiles.map(async (profile) => ({
        profile,
        status: await profileDoctorStatus(profile),
        identity: profileAccountIdentity(profile),
      })),
    );
  };
  // The plain (non-snapshot) form is the UI's poll target: without a cache it
  // ran a doctor probe per registered profile plus a full harness sweep
  // inside harnessAccountsProjection on EVERY tick — the daemon-starving load
  // behind the 2026-08-04 "Daemon unreachable: ReadTimeout" login failure.
  // The snapshot form stays fully fresh: it is the explicit refresh action,
  // not the poll path. A login/logout invalidates this cache immediately
  // (invalidateStatusProjections), so freshness lags at most the short TTL.
  const buildPollResponse = async () => {
    const quota = quotaRegistry().read();
    const out = withVendorVerification(await projectProfiles(), quota);
    return {
      profiles: out,
      harnessAccounts: await harnessAccountsProjection(NO_PROJECT_ROOT, quota.snapshots, {
        profiles: out,
      }),
    };
  };
  const pollCache = new StatusProjectionCache<Awaited<ReturnType<typeof buildPollResponse>>>({
    versionOf: globalConfigVersion,
  });
  return async (input?: { snapshot?: boolean }) => {
    if (input?.snapshot === true) {
      const [probed, statuses, git, fencedQuota] = await Promise.all([
        projectProfiles(),
        buildGateway({ includeFakes: false }).statusAll({ cwd: NO_PROJECT_ROOT, fresh: true }),
        probeGitCapability(),
        quotaRegistry().refreshWithCursor(),
      ]);
      const quota = fencedQuota.response;
      const out = withVendorVerification(probed, quota);
      // The explicit refresh proved the live state — re-prime the poll cache
      // with a projection derived from the same probes' moment.
      pollCache.invalidate();
      return {
        profiles: out,
        harnessAccounts: await harnessAccountsProjection(NO_PROJECT_ROOT, quota.snapshots, {
          profiles: out,
          statuses,
        }),
        harnesses: await projectHarnessStatuses(statuses),
        git,
        quota,
        quotaEventCursor: fencedQuota.quotaEventCursor,
      };
    }
    return pollCache.read(buildPollResponse);
  };
}

/**
 * Replace each profile's LOCAL verification verdict with the vendor's, wherever
 * the quota poller already has one. Applied before `harnessAccounts` is built
 * so the routing identity (`next_up`) and the listed status can never disagree:
 * a revoked profile must not be advertised as who the next run routes to.
 */
function withVendorVerification<
  T extends { profile: CredentialProfile; status: CredentialProfileStatus },
>(
  entries: T[],
  quota: { snapshots: readonly QuotaSnapshot[]; absences: readonly QuotaAbsence[] },
): T[] {
  return entries.map((entry) => ({
    ...entry,
    status: vendorVerifiedProfileStatus(entry.status, quota),
  }));
}

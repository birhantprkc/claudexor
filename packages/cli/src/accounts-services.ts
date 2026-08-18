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
import { withQuotaAvailability } from "@claudexor/schema";
import { vendorVerifiedProfileStatus } from "@claudexor/orchestrator";
import { accountPoolsProjection, profileAccountProjection } from "./accounts-projection.js";
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
 * can accidentally pair a newer quota card with an older routing identity.
 * Returns the listing service plus the pool-authority read
 * (`GET /v2/account-pools`) so both share one cached projection. */
export function createCredentialProfilesService(quotaRegistry: () => QuotaRegistry) {
  const projectProfiles = () => {
    const profiles = loadConfig(NO_PROJECT_ROOT).global.credential_profiles;
    return Promise.all(profiles.map(profileAccountProjection));
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
      // Unified account model: the legacy carrier stays PRESENT and empty for
      // strict old clients; routing facts ride accountPools.
      harnessAccounts: [],
      accountPools: await accountPoolsProjection(NO_PROJECT_ROOT, quota.snapshots, {
        profiles: out,
      }),
    };
  };
  const pollCache = new StatusProjectionCache<Awaited<ReturnType<typeof buildPollResponse>>>({
    versionOf: globalConfigVersion,
  });
  const credentialProfiles = async (input?: { snapshot?: boolean }) => {
    if (input?.snapshot === true) {
      const [probed, accountStatuses, git, fencedQuota] = await Promise.all([
        projectProfiles(),
        buildGateway({ includeFakes: false }).statusAllForAccounts({
          cwd: NO_PROJECT_ROOT,
          fresh: true,
        }),
        probeGitCapability(),
        quotaRegistry().refreshWithCursor(),
      ]);
      const statuses = accountStatuses.map((receipt) => receipt.status);
      const rawQuota = fencedQuota.response;
      const out = withVendorVerification(probed, rawQuota);
      // The explicit refresh proved the live state — drop the stale poll
      // cache so the next ordinary poll recomputes from it (re-priming with a
      // snapshot-derived projection was explicitly declined, wave-3 decision).
      pollCache.invalidate();
      return {
        profiles: out,
        harnessAccounts: [],
        accountPools: await accountPoolsProjection(NO_PROJECT_ROOT, rawQuota.snapshots, {
          profiles: out,
          statuses,
        }),
        harnesses: await projectHarnessStatuses(statuses),
        git,
        quota: withQuotaAvailability(rawQuota),
        quotaEventCursor: fencedQuota.quotaEventCursor,
      };
    }
    return pollCache.read(buildPollResponse);
  };
  const accountPools = async () => ({
    accountPools: (await pollCache.read(buildPollResponse)).accountPools,
  });
  return { credentialProfiles, accountPools };
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

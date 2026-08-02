import { loadConfig } from "@claudexor/config";
import type { QuotaRegistry } from "@claudexor/daemon";
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
import {
  vendorCredentialObservation,
  withVendorCredentialObservation,
} from "@claudexor/orchestrator";
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
  return async (input?: { snapshot?: boolean }) => {
    const profiles = loadConfig(NO_PROJECT_ROOT).global.credential_profiles;
    const projectedProfiles = Promise.all(
      profiles.map(async (profile) => ({
        profile,
        status: await profileDoctorStatus(profile),
        identity: profileAccountIdentity(profile),
      })),
    );
    if (input?.snapshot === true) {
      const [probed, statuses, git, fencedQuota] = await Promise.all([
        projectedProfiles,
        buildGateway({ includeFakes: false }).statusAll({ cwd: NO_PROJECT_ROOT, fresh: true }),
        probeGitCapability(),
        quotaRegistry().refreshWithCursor(),
      ]);
      const quota = fencedQuota.response;
      const out = withVendorVerification(probed, quota);
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
    const quota = quotaRegistry().read();
    const out = withVendorVerification(await projectedProfiles, quota);
    return {
      profiles: out,
      harnessAccounts: await harnessAccountsProjection(NO_PROJECT_ROOT, quota.snapshots, {
        profiles: out,
      }),
    };
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
    status: withVendorCredentialObservation(
      entry.status,
      vendorCredentialObservation(quota, entry.profile.harness_id, entry.profile.profile_id),
    ),
  }));
}

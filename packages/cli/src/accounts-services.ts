import { loadConfig } from "@claudexor/config";
import type { QuotaRegistry } from "@claudexor/daemon";
import { normalizeReadiness, type HarnessStatus } from "@claudexor/gateway";
import { probeGitCapability } from "@claudexor/workspace";
import { noProjectRepoRoot } from "@claudexor/util";
import { validateModel } from "@claudexor/core";
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
      const [out, statuses, git, fencedQuota] = await Promise.all([
        projectedProfiles,
        buildGateway({ includeFakes: false }).statusAll({ cwd: NO_PROJECT_ROOT, fresh: true }),
        probeGitCapability(),
        quotaRegistry().refreshWithCursor(),
      ]);
      const quota = fencedQuota.response;
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
    const out = await projectedProfiles;
    return {
      profiles: out,
      harnessAccounts: await harnessAccountsProjection(
        NO_PROJECT_ROOT,
        quotaRegistry().read().snapshots,
        { profiles: out },
      ),
    };
  };
}

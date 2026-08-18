/**
 * PATCH/DELETE credential-profile services (INV-135 unified account model),
 * extracted from control-services.ts (INV-124). One mutation owner each:
 * the Enabled toggle (with the deprecated `native_credentials_enabled`
 * downgrade-window mirror for the migrated row) and the PROVABLE removal
 * (D-U4: material cleanup BEFORE registry removal; a cleanup failure is a
 * typed retryable error, never a removed-with-warning receipt).
 */
import { existsSync, rmSync } from "node:fs";
import { join, sep } from "node:path";
import { loadConfig, updateGlobalConfig } from "@claudexor/config";
import { canonicalIsolationLocator, normalizeThroughExistingAncestor } from "@claudexor/core";
import type { SecretStore } from "@claudexor/secrets";
import type { ControlSetupJob, CredentialProfile } from "@claudexor/schema";
import { claudexorOwnedRoot, noProjectRepoRoot } from "@claudexor/util";
import { purgeProfileLanes } from "@claudexor/workspace";
import { vendorVerifiedProfileStatus } from "@claudexor/orchestrator";
import {
  locatorIsDefaultNativeStore,
  readAccountsMigrationFile,
  removeAccountsMigrationRecord,
} from "./accounts-unified-migration.js";
import { profileDoctorStatus } from "./accounts-projection.js";
import { canonicalProfileLoginDir, isConfigDirLoginHarness } from "./config-dir-login-harnesses.js";
import { assertCredentialProfileRegistered } from "./profile-compatibility.js";
import { removeProfileFromRegistry } from "./profile-registration.js";

const NO_PROJECT_ROOT = noProjectRepoRoot();

export interface CredentialProfileMutationDeps {
  threads: {
    invalidateCredentialProfile(harnessId: string, profileId: string): unknown;
    listThreads(): Array<{ repo?: { root: string } | null }>;
  };
  quotaRegistry: () => {
    removeSubject(harness: string, subjectId: string | null): number;
    read(): Parameters<typeof vendorVerifiedProfileStatus>[1];
  };
  secretStore: Pick<SecretStore, "delete">;
  bustStatusCaches: () => void;
  activeLoginJob: (harnessId: string, profileId: string) => ControlSetupJob | undefined;
}

export function credentialProfileMutations(deps: CredentialProfileMutationDeps) {
  return {
    // PATCH /credential-profiles/:harness/:id — the Enabled toggle of the
    // accounts symmetry (INV-135): one locked registry write, plus the
    // deprecated `native_credentials_enabled` downgrade-window mirror when the
    // row is the migrated one (a silent divergence would re-enable the
    // account after a downgrade).
    updateCredentialProfile: async (input: unknown) => {
      const p = (input ?? {}) as Record<string, unknown>;
      const harnessId = typeof p["harnessId"] === "string" ? p["harnessId"] : "";
      const profileId = typeof p["profileId"] === "string" ? p["profileId"] : "";
      const enabled = typeof p["enabled"] === "boolean" ? p["enabled"] : undefined;
      if (!harnessId || !profileId || enabled === undefined) {
        throw Object.assign(new Error("harnessId, profileId and enabled are required"), {
          status: 400,
        });
      }
      const registry = loadConfig(NO_PROJECT_ROOT).global.credential_profiles;
      assertCredentialProfileRegistered(registry, harnessId, profileId);
      // The downgrade-window mirror keys on the STRUCTURAL rule (the row's
      // locator IS the harness default store), not on migration-record
      // presence alone: a bootstrap row (ensureBootstrapProfile) sits at the
      // native dir before any record exists, and a silent mirror divergence
      // would re-enable that account after a downgrade — or let the legacy
      // default-subject ladder route back into a disabled row's store.
      const registryRow = registry.find(
        (row) => row.harness_id === harnessId && row.profile_id === profileId,
      );
      const mirrorsNativeKey =
        readAccountsMigrationFile()[harnessId]?.row_id === profileId ||
        locatorIsDefaultNativeStore(harnessId, registryRow?.isolation_locator ?? null);
      let updated: CredentialProfile | undefined;
      updateGlobalConfig((config) => ({
        ...config,
        ...(mirrorsNativeKey
          ? {
              harnesses: {
                ...config.harnesses,
                [harnessId]: {
                  ...config.harnesses[harnessId],
                  native_credentials_enabled: enabled,
                },
              },
            }
          : {}),
        credential_profiles: config.credential_profiles.map((profile) => {
          if (profile.harness_id !== harnessId || profile.profile_id !== profileId) return profile;
          updated = { ...profile, enabled };
          return updated;
        }),
      }));
      if (!updated) {
        throw Object.assign(new Error("profile update did not persist"), { status: 500 });
      }
      deps.bustStatusCaches();
      return {
        profile: updated,
        // Same vendor overlay the listing applies: a single-profile response
        // must not re-declare a revoked credential `passed` (INV-135 honesty).
        status: vendorVerifiedProfileStatus(
          await profileDoctorStatus(updated),
          deps.quotaRegistry().read(),
        ),
      };
    },
    // DELETE /credential-profiles/:harness/:id — provable removal (D-U4).
    deleteCredentialProfile: async (input: unknown) => {
      const p = (input ?? {}) as Record<string, unknown>;
      const harnessId = typeof p["harnessId"] === "string" ? p["harnessId"] : "";
      const profileId = typeof p["profileId"] === "string" ? p["profileId"] : "";
      if (!harnessId || !profileId) {
        throw Object.assign(new Error("harnessId and profileId are required"), { status: 400 });
      }
      const activeLogin = deps.activeLoginJob(harnessId, profileId);
      if (activeLogin) {
        throw Object.assign(
          new Error(
            `a login for this account is in progress (${activeLogin.jobId}); cancel it before removing the account`,
          ),
          { status: 409 },
        );
      }
      assertCredentialProfileRegistered(
        loadConfig(NO_PROJECT_ROOT).global.credential_profiles,
        harnessId,
        profileId,
      );
      deps.threads.invalidateCredentialProfile(harnessId, profileId);
      // INV-034 lifecycle owner (b): the deleted account's durable per-lane
      // read-only homes must not survive to be resumed. Sweep them across every
      // project a live thread anchors to (plus the no-project partition).
      const laneRoots = new Set<string>([NO_PROJECT_ROOT]);
      for (const thread of deps.threads.listThreads()) {
        if (thread.repo?.root) laneRoots.add(thread.repo.root);
      }
      for (const root of laneRoots) purgeProfileLanes(root, harnessId, profileId);
      deps.quotaRegistry().removeSubject(harnessId, profileId);
      // Unified account model: deleting a MIGRATED row retires the canonical
      // id PLUS its legacy aliases (the null engine-default subject and its
      // `<harness>-default` lane homes) in the SAME lifecycle operation — a
      // dangling alias could resume the deleted credential's session or keep
      // charging its quota subject.
      const migrationRecord = readAccountsMigrationFile()[harnessId];
      const registryEntry = loadConfig(NO_PROJECT_ROOT).global.credential_profiles.find(
        (row) => row.harness_id === harnessId && row.profile_id === profileId,
      );
      const migratedRow = migrationRecord?.row_id === profileId;
      if (migratedRow) {
        deps.quotaRegistry().removeSubject(harnessId, null);
        for (const root of laneRoots) purgeProfileLanes(root, harnessId, "default");
      }
      // D-U4 failure contract: `removed: true` ONLY when the row AND its
      // credential material are provably gone. Material cleanup therefore runs
      // BEFORE registry removal: a cleanup failure is a typed RETRYABLE error
      // that leaves the row registered (a retry finishes the job) — never a
      // `removed: true` with a warning, which the startup auto-registration
      // would resurrect from the surviving material on the next start.
      let credentialCleanup: "config_dir_removed" | "secret_deleted" | "none" = "none";
      try {
        if (
          registryEntry?.credential_kind === "config_dir_login" &&
          registryEntry.isolation_locator
        ) {
          // Each member resolves through its OWN canonicalizer (the ladder
          // this used to hand-write let cursor and agy fall through to the
          // generic one, so a member whose canonicalizer adds a rule would
          // silently delete against a different path than its login wrote to).
          const dir = isConfigDirLoginHarness(harnessId)
            ? canonicalProfileLoginDir(harnessId, registryEntry.isolation_locator)
            : canonicalIsolationLocator(registryEntry.isolation_locator, "credential profile dir");
          // Recursive deletion is fenced to a strict descendant of the
          // profiles tree — PLUS exactly the harness's own default native
          // store dir (an exact-path allowlist, never a general "anything
          // under native/" deletion class — K.3). The structural rule covers
          // both the migrated row (whose record holds that locator) and a
          // bootstrap row registered at the native dir BEFORE any migration
          // record exists (a cancelled login must stay removable — K.4).
          const profilesRoot = normalizeThroughExistingAncestor(
            join(claudexorOwnedRoot(), "profiles"),
          );
          const legacyAllowlisted =
            (migratedRow &&
              migrationRecord !== undefined &&
              dir === normalizeThroughExistingAncestor(migrationRecord.locator)) ||
            locatorIsDefaultNativeStore(harnessId, dir);
          if (!dir.startsWith(profilesRoot + sep) && !legacyAllowlisted) {
            throw new Error(
              `refusing to delete "${dir}": not inside the profiles tree ${profilesRoot} and not the migrated row's recorded legacy locator`,
            );
          }
          if (existsSync(dir)) {
            rmSync(dir, { recursive: true, force: true });
            credentialCleanup = "config_dir_removed";
          }
        } else if (registryEntry?.secret_ref) {
          deps.secretStore.delete(registryEntry.secret_ref);
          credentialCleanup = "secret_deleted";
        }
      } catch (err) {
        deps.bustStatusCaches();
        throw Object.assign(
          new Error(
            `credential cleanup failed; the account is still registered — retry the removal: ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
          { status: 503, code: "credential_cleanup_failed", retryable: true },
        );
      }
      const entry = removeProfileFromRegistry(harnessId, profileId);
      if (migratedRow) {
        // The migration record dies with its row: the material is gone, so a
        // later start detects no legacy login and fabricates nothing.
        removeAccountsMigrationRecord(harnessId);
      }
      deps.bustStatusCaches();
      return {
        profile: entry,
        removed: true,
        credentialCleanup,
      };
    },
  };
}

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  configDirLoginHarnessList,
  isConfigDirLoginHarness,
} from "./config-dir-login-harnesses.js";
import { loadConfig, updateGlobalConfig } from "@claudexor/config";
import { normalizeThroughExistingAncestor } from "@claudexor/core";
import { defaultNativeClaudeConfigDir } from "@claudexor/harness-claude";
import { defaultNativeCodexHome } from "@claudexor/harness-codex";
import { harnessSupportsBootstrapLogin, type CredentialProfile } from "@claudexor/schema";
import { claudexorOwnedRoot, noProjectRepoRoot, nowIso } from "@claudexor/util";

/**
 * The ONE owner of config-dir credential-profile registration (INV-135),
 * shared by `claudexor profiles add` and POST /v2/credential-profiles: a
 * locked, schema-validated global-config write (duplicate ids refused by the
 * registry schema), with the login dir created under the engine's confinement
 * root. Never a raw YAML append — that can duplicate the top-level key and
 * brick the config.
 */

const PROFILE_ID_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface RegisterProfileInput {
  harnessId: string;
  profileId: string;
  displayName?: string;
}

export function registerConfigDirProfile(input: RegisterProfileInput): {
  profile: CredentialProfile;
  configPath: string;
} {
  const { harnessId, profileId } = input;
  if (!isConfigDirLoginHarness(harnessId)) {
    throw Object.assign(
      new Error(
        `harness "${harnessId}" has no isolated config-dir login; register ${configDirLoginHarnessList()} profiles here (secret-ref profiles for other harnesses are hand-registered in the global config)`,
      ),
      { status: 400 },
    );
  }
  if (!PROFILE_ID_SLUG.test(profileId)) {
    throw Object.assign(
      new Error(`profile id "${profileId}" must be a bounded slug ([a-z0-9][a-z0-9_-]{0,63})`),
      { status: 400 },
    );
  }
  // Reserved: the unpinned lane segment is laneProfileSegment(null) =
  // "default", so a literal "default" row would collide with the
  // <harness>-default lane the unified-accounts migration and deletion act
  // on — the row's lanes could be renamed or purged as legacy state.
  if (profileId === "default") {
    throw Object.assign(
      new Error(
        `profile id "default" is reserved for the engine's unpinned lane; pick another id (the bootstrap login row is "${harnessId}-default")`,
      ),
      { status: 400 },
    );
  }
  const locator = join(claudexorOwnedRoot(), "profiles", `${harnessId}-${profileId}`);
  mkdirSync(locator, { recursive: true });
  const entry: CredentialProfile = {
    profile_id: profileId,
    harness_id: harnessId,
    display_name: input.displayName?.trim() || profileId,
    credential_kind: "config_dir_login",
    isolation_locator: locator,
    secret_ref: null,
    enabled: true,
    created_at: nowIso(),
  };
  try {
    const { path } = updateGlobalConfig((config) => ({
      ...config,
      credential_profiles: [...config.credential_profiles, entry],
    }));
    return { profile: entry, configPath: path };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw Object.assign(new Error(`could not register the profile: ${message}`), {
      status: /duplicate/i.test(message) ? 409 : 400,
    });
  }
}

/**
 * The BOOTSTRAP row `claudexor auth login <harness>` (and a profile-less
 * login-job request) signs into (unified account model, K.4): claude/codex
 * bootstrap onto their Claudexor-owned native dir (the same locator the
 * startup migration registers, so a later migration pass reuses this row);
 * cursor bootstraps onto an isolated file-store dir (owner decision D-U3 —
 * the host Keychain is never read). Idempotent: an existing row holding the
 * locator is returned as-is; a cancelled/failed login keeps the cold row with
 * its "Sign in" affordance (the recovery path always exists). The bootstrap
 * row has NO routing privilege — it is an ordinary pool row.
 */
export function ensureBootstrapProfile(harnessId: string): CredentialProfile {
  if (harnessId === "agy" || !harnessSupportsBootstrapLogin(harnessId)) {
    throw Object.assign(
      new Error(
        `harness "${harnessId}" has no bootstrap login: sign in from a named account (owner decision Л-4)`,
      ),
      { status: 400 },
    );
  }
  if (!isConfigDirLoginHarness(harnessId)) {
    throw Object.assign(new Error(`harness "${harnessId}" has no isolated config-dir login`), {
      status: 400,
    });
  }
  const locator =
    harnessId === "claude"
      ? defaultNativeClaudeConfigDir()
      : harnessId === "codex"
        ? defaultNativeCodexHome()
        : join(claudexorOwnedRoot(), "profiles", `${harnessId}-default`);
  const norm = (dir: string): string => {
    try {
      return normalizeThroughExistingAncestor(dir);
    } catch {
      return dir;
    }
  };
  const registry = loadConfig(noProjectRepoRoot()).global.credential_profiles;
  const existing = registry.find(
    (p) =>
      p.harness_id === harnessId &&
      p.isolation_locator &&
      norm(p.isolation_locator) === norm(locator),
  );
  if (existing) return existing;
  // Reserved machine id, cross-harness unique with a deterministic suffix —
  // the same policy the startup migration uses (§L.3).
  const base = `${harnessId}-default`;
  let profileId = base;
  for (let i = 2; registry.some((p) => p.profile_id === profileId); i += 1) {
    profileId = `${base}-${i}`;
  }
  mkdirSync(locator, { recursive: true });
  const entry: CredentialProfile = {
    profile_id: profileId,
    harness_id: harnessId,
    display_name: `${harnessId} default login`,
    credential_kind: "config_dir_login",
    isolation_locator: locator,
    secret_ref: null,
    enabled: true,
    created_at: nowIso(),
  };
  updateGlobalConfig((config) => ({
    ...config,
    credential_profiles: [...config.credential_profiles, entry],
  }));
  return entry;
}

/** The ONE owner of registry removal (mirror of registerConfigDirProfile):
 * locked global-config write returning the removed entry; unknown ids refuse
 * with a typed 404. Credential-material cleanup stays with the caller. */
export function removeProfileFromRegistry(harnessId: string, profileId: string): CredentialProfile {
  let removed: CredentialProfile | undefined;
  updateGlobalConfig((config) => {
    removed = config.credential_profiles.find(
      (profile) => profile.harness_id === harnessId && profile.profile_id === profileId,
    );
    if (!removed) {
      throw Object.assign(
        new Error(`no credential profile "${profileId}" for harness "${harnessId}"`),
        { status: 404 },
      );
    }
    // INV-135 durable-pin invalidation: a deleted account must not dangle as a
    // harness's `rotation_eligible` entry (rotation would then target a
    // removed profile). Clear it in the SAME locked write.
    const harnesses = Object.fromEntries(
      Object.entries(config.harnesses).map(([id, h]) => [
        id,
        {
          ...h,
          profile_policy: {
            ...h.profile_policy,
            rotation_eligible:
              id === harnessId
                ? h.profile_policy.rotation_eligible.filter((rid) => rid !== profileId)
                : h.profile_policy.rotation_eligible,
          },
        },
      ]),
    );
    return {
      ...config,
      harnesses,
      credential_profiles: config.credential_profiles.filter(
        (profile) => !(profile.harness_id === harnessId && profile.profile_id === profileId),
      ),
    };
  });
  if (!removed) {
    throw Object.assign(new Error("profile removal did not persist"), { status: 500 });
  }
  return removed;
}

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, updateGlobalConfig } from "@claudexor/config";
import { noProjectRepoRoot } from "@claudexor/util";
import {
  ControlQuotaResponse,
  ControlCredentialProfilesResponse,
  ControlCredentialProfilesSnapshotResponse,
  ControlCredentialProfileUpdateResponse,
  type QuotaSnapshot,
} from "@claudexor/schema";
import { controlServices } from "./control-services.js";
import { credentialUnusableLedger } from "./run-orchestrator.js";
import { registerConfigDirProfile } from "./profile-registration.js";

const gatewayMock = vi.hoisted(() => ({
  statuses: [] as unknown[],
  calls: [] as Array<{ fresh?: boolean }>,
  accountIdentities: {} as Record<string, { email?: string; plan?: string } | null>,
  profileIdentities: {} as Record<string, { email?: string; plan?: string } | null>,
  profileReadiness: {
    availability: "unknown",
    verification: "not_run",
  } as {
    availability: "available" | "unavailable" | "unknown";
    verification: "passed" | "failed" | "not_run";
  },
  profileReadinessById: {} as Record<
    string,
    {
      availability: "available" | "unavailable" | "unknown";
      verification: "passed" | "failed" | "not_run";
    }
  >,
}));
const noteCredentialChange = vi.fn();

vi.mock("./registry.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./registry.js")>();
  return {
    ...original,
    buildRegistry: (options?: Parameters<typeof original.buildRegistry>[0]) => {
      const registry = original.buildRegistry(options);
      for (const [id, adapter] of registry) {
        if (!adapter.probeCredentialProfile && !adapter.probeCredentialAccount) continue;
        const statusFor = (profile: { profile_id: string; harness_id: string }) => {
          const readiness =
            gatewayMock.profileReadinessById[profile.profile_id] ?? gatewayMock.profileReadiness;
          return {
            profile_id: profile.profile_id,
            harness_id: profile.harness_id,
            availability: readiness.availability,
            verification: readiness.verification,
            verification_source: "local_store" as const,
            detail: "live profile probe disabled in projection unit test",
            last_verified_at: null,
          };
        };
        registry.set(id, {
          ...adapter,
          ...(adapter.probeCredentialProfile
            ? { probeCredentialProfile: async (profile) => statusFor(profile) }
            : {}),
          ...(adapter.probeCredentialAccount
            ? {
                probeCredentialAccount: async (profile) => ({
                  status: statusFor(profile),
                  identity: gatewayMock.profileIdentities[profile.profile_id] ?? null,
                }),
              }
            : {}),
        });
      }
      return registry;
    },
    buildGateway: () => ({
      statusAll: async (input: { fresh?: boolean }) => {
        gatewayMock.calls.push(input);
        return gatewayMock.statuses;
      },
      statusAllForAccounts: async (input: { fresh?: boolean }) => {
        gatewayMock.calls.push(input);
        return gatewayMock.statuses.map((status) => ({
          status,
          identity: gatewayMock.accountIdentities[(status as { id: string }).id] ?? null,
        }));
      },
    }),
  };
});

vi.mock("@claudexor/workspace", async (importOriginal) => {
  const original = await importOriginal<typeof import("@claudexor/workspace")>();
  return {
    ...original,
    probeGitCapability: async () => ({
      status: "missing",
      version: null,
      detail: "No executable named git was found on PATH.",
      remediation: "Install Git and make it available on PATH, then retry.",
    }),
  };
});

// PATCH /credential-profiles/:harness/:id (the Enabled toggle of the accounts
// symmetry, INV-135) + the per-harness accounts-authority projection served on
// the listing so no surface re-derives Active/native truth.

function quotaSnapshot(subjectId: string | null, usedRatio: number): QuotaSnapshot {
  return {
    subject: {
      harness: "claude",
      credential_route: "vendor_native",
      plan_label: null,
      subject_id: subjectId,
    },
    constraints: [
      {
        id: "five_hour",
        label: "5 hour",
        used_ratio: usedRatio,
        window_seconds: 18_000,
        resets_at: null,
        cooldown_until: null,
      },
    ],
    source: "claude_oauth_usage",
    observed_at: "2026-07-28T00:00:00Z",
    freshness: "fresh",
  };
}

function services(
  options: {
    refreshedQuota?: ControlQuotaResponse;
    refreshError?: Error;
    quotaEventCursor?: string;
  } = {},
) {
  const threads = {
    invalidateCredentialProfile: () => ({ clearedThreads: 0, invalidatedSessions: 0 }),
    listThreads: () => [] as unknown[],
  };
  const emptyQuota = ControlQuotaResponse.parse({
    snapshots: [],
    absences: [],
    refreshed_at: null,
  });
  const refreshQuota = async () => {
    if (options.refreshError) throw options.refreshError;
    return (
      options.refreshedQuota ?? {
        ...emptyQuota,
        refreshed_at: "2026-07-28T00:00:00Z",
      }
    );
  };
  const quota = {
    removeSubject: () => 0,
    noteCredentialChange,
    read: () => emptyQuota,
    refresh: refreshQuota,
    refreshWithCursor: async () => ({
      response: await refreshQuota(),
      quotaEventCursor: options.quotaEventCursor ?? "quota-fence-default",
    }),
  };
  return controlServices(
    undefined as never,
    undefined as never,
    threads as never,
    { current: () => ({ list: () => [] }) } as never,
    undefined as never,
    undefined as never,
    undefined as never,
    (() => quota) as never,
    async () => [],
  );
}

describe("updateCredentialProfile (INV-135 Enabled toggle) + accounts projection", () => {
  let dir: string;
  let prev: string | undefined;
  let prevPath: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudexor-profile-update-"));
    prev = process.env.CLAUDEXOR_CONFIG_DIR;
    prevPath = process.env.PATH;
    process.env.CLAUDEXOR_CONFIG_DIR = dir;
    // These are projection tests, not live harness integration tests. Keep
    // them hermetic even when the developer machine has vendor CLIs installed.
    process.env.PATH = dir;
    gatewayMock.calls = [];
    gatewayMock.accountIdentities = {};
    gatewayMock.profileIdentities = {};
    noteCredentialChange.mockClear();
    gatewayMock.profileReadiness = { availability: "unknown", verification: "not_run" };
    gatewayMock.profileReadinessById = {};
    gatewayMock.statuses = [
      {
        id: "claude",
        available: true,
        status: "ok",
        manifest: null,
        authSources: [
          { source: "native_session", availability: "available", verification: "passed" },
        ],
        enabledIntents: ["explain", "implement"],
        routableIntents: ["explain", "implement"],
        disabledIntents: [],
        checks: [],
        reasons: [],
      },
    ];
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
    else process.env.CLAUDEXOR_CONFIG_DIR = prev;
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("flips the profile's durable enabled flag and returns the receipt", async () => {
    registerConfigDirProfile({ harnessId: "claude", profileId: "work" });
    const svc = services();
    const off = ControlCredentialProfileUpdateResponse.parse(
      await svc.updateCredentialProfile({ harnessId: "claude", profileId: "work", enabled: false }),
    );
    expect(off.profile.enabled).toBe(false);
    expect(loadConfig(noProjectRepoRoot()).global.credential_profiles[0]?.enabled).toBe(false);
    const on = ControlCredentialProfileUpdateResponse.parse(
      await svc.updateCredentialProfile({ harnessId: "claude", profileId: "work", enabled: true }),
    );
    expect(on.profile.enabled).toBe(true);
    expect(noteCredentialChange).toHaveBeenCalledTimes(2);
  });

  it("mirrors native_credentials_enabled for ANY row at the harness default store — migration record or not", async () => {
    // A bootstrap row (ensureBootstrapProfile) sits at the exact default
    // native dir BEFORE any migration record exists. Disabling it must update
    // the deprecated downgrade-window mirror too, or the legacy
    // default-subject ladder (and a downgraded 3.5.0 engine) would silently
    // route back into the same account's store.
    const { ensureBootstrapProfile } = await import("./profile-registration.js");
    const { readAccountsMigrationFile } = await import("./accounts-unified-migration.js");
    const row = ensureBootstrapProfile("codex");
    expect(readAccountsMigrationFile()["codex"]).toBeUndefined();
    const svc = services();
    await svc.updateCredentialProfile({
      harnessId: "codex",
      profileId: row.profile_id,
      enabled: false,
    });
    const cfg = loadConfig(noProjectRepoRoot()).global;
    expect(cfg.harnesses["codex"]?.native_credentials_enabled).toBe(false);
    expect(cfg.credential_profiles.find((p) => p.profile_id === row.profile_id)?.enabled).toBe(
      false,
    );
    // An ordinary profiles-tree row never touches the mirror.
    registerConfigDirProfile({ harnessId: "claude", profileId: "work" });
    await svc.updateCredentialProfile({ harnessId: "claude", profileId: "work", enabled: false });
    expect(
      loadConfig(noProjectRepoRoot()).global.harnesses["claude"]?.native_credentials_enabled,
    ).not.toBe(false);
  });

  it("re-arms quota polling after profile creation and quota-relevant settings", async () => {
    const svc = services();
    await svc.createCredentialProfile({ harnessId: "claude", profileId: "new-account" });
    expect(noteCredentialChange).toHaveBeenCalledOnce();

    await svc.updateSettings({
      harnesses: { claude: { nativeCredentialsEnabled: false } },
    });
    expect(noteCredentialChange).toHaveBeenCalledTimes(2);

    // All settings mutations ride the same cache-bust/reset owner; use a
    // harness-independent field so this projection test never needs a vendor CLI.
    await svc.updateSettings({ interactionTimeoutMs: 60_000 });
    expect(noteCredentialChange).toHaveBeenCalledTimes(3);
  });

  it("refuses an unknown id with a typed 404 and a missing enabled with a 400", async () => {
    const svc = services();
    await expect(
      svc.updateCredentialProfile({ harnessId: "claude", profileId: "ghost", enabled: true }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      svc.updateCredentialProfile({ harnessId: "claude", profileId: "work" }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("projects the pool verdict per harness: ready row selected, disabled row none, legacy carrier empty (unified model)", async () => {
    registerConfigDirProfile({ harnessId: "claude", profileId: "work" });
    const svc = services();

    // Row registered but not yet ready (probe unknown) → nothing routable and
    // no API-key route → none. The legacy harnessAccounts carrier stays
    // PRESENT and EMPTY for strict old clients.
    const base = ControlCredentialProfilesResponse.parse(await svc.credentialProfiles());
    expect(base.harnessAccounts).toEqual([]);
    const claudeBase = base.accountPools.find((pool) => pool.harness_id === "claude");
    expect(claudeBase?.next_up.kind).toBe("none");

    // A ready enabled row IS the unpinned route (unified model: unpinned
    // routing = quota-aware pool; there is no separate native default).
    gatewayMock.profileReadiness = { availability: "available", verification: "passed" };
    updateGlobalConfig((config) => ({ ...config })); // bump the projection cache version
    const ready = ControlCredentialProfilesResponse.parse(await svc.credentialProfiles());
    expect(ready.accountPools.find((pool) => pool.harness_id === "claude")?.next_up).toEqual({
      kind: "profile",
      profileId: "work",
    });

    // Disabling the row (the only routing control) empties the pool → none.
    await svc.updateCredentialProfile({ harnessId: "claude", profileId: "work", enabled: false });
    const none = ControlCredentialProfilesResponse.parse(await svc.credentialProfiles());
    expect(none.accountPools.find((pool) => pool.harness_id === "claude")?.next_up.kind).toBe(
      "none",
    );
  });

  it("projects none when no account row exists, regardless of default-store doctor truth", async () => {
    gatewayMock.statuses = [
      {
        id: "claude",
        status: "unavailable",
        authSources: [
          { source: "native_session", availability: "unknown", verification: "not_run" },
        ],
        enabledIntents: [],
        routableIntents: [],
      },
    ];
    const listing = ControlCredentialProfilesResponse.parse(await services().credentialProfiles());
    expect(listing.harnessAccounts).toEqual([]);
    const claude = listing.accountPools.find((value) => value.harness_id === "claude");
    expect(claude?.next_up).toMatchObject({ kind: "none" });
  });

  it("returns one opt-in snapshot whose rows and pool verdict share one fresh doctor read", async () => {
    gatewayMock.calls = [];
    const snapshot = ControlCredentialProfilesSnapshotResponse.parse(
      await services().credentialProfiles({ snapshot: true }),
    );
    expect(gatewayMock.calls).toEqual([{ cwd: noProjectRepoRoot(), fresh: true }]);
    expect(snapshot.harnesses.map((status) => status.id)).toEqual(["claude"]);
    expect(snapshot.harnessAccounts).toEqual([]);
    expect(
      snapshot.accountPools.find((value) => value.harness_id === "claude")?.next_up,
    ).toMatchObject({ kind: "none" });
    expect(snapshot.git.status).toBe("missing");
    expect(snapshot.quota.refreshed_at).toBe("2026-07-28T00:00:00Z");
    const { quotaEventCursor, ...unfenced } = snapshot;
    expect(quotaEventCursor).toBe("quota-fence-default");
    expect(() => ControlCredentialProfilesSnapshotResponse.parse(unfenced)).toThrow();
    // Old-wire bodies without accountPools still parse (additive default []).
    expect(ControlCredentialProfilesResponse.parse({ profiles: [], harnessAccounts: [] })).toEqual({
      profiles: [],
      harnessAccounts: [],
      accountPools: [],
    });
  });

  it("projects the API-key ROUTE when the pool is empty and a key route is available (Q2=A)", async () => {
    gatewayMock.statuses = [
      {
        id: "claude",
        available: true,
        status: "ok",
        manifest: null,
        authSources: [
          { source: "native_session", availability: "unavailable", verification: "failed" },
          { source: "api_key_env", availability: "available", verification: "passed" },
        ],
        enabledIntents: ["explain", "implement"],
        routableIntents: ["explain", "implement"],
        disabledIntents: [],
        checks: [],
        reasons: [],
      },
    ];
    const listing = ControlCredentialProfilesResponse.parse(await services().credentialProfiles());
    const claude = listing.accountPools.find((value) => value.harness_id === "claude");
    expect(claude?.next_up).toEqual({ kind: "api_key_route" });
  });

  it("derives next_up and returns quota from one refreshed snapshot epoch", async () => {
    registerConfigDirProfile({ harnessId: "claude", profileId: "work" });
    gatewayMock.profileReadiness = { availability: "available", verification: "passed" };
    updateGlobalConfig((config) => ({
      ...config,
      harnesses: {
        ...config.harnesses,
        claude: {
          ...(config.harnesses.claude ?? {}),
          profile_policy: {
            limit_action: "rotate",
            rotation_eligible: ["work"],
            headroom_threshold: 0.9,
          },
        },
      },
    }));
    const refreshedQuota = ControlQuotaResponse.parse({
      snapshots: [quotaSnapshot(null, 0.95), quotaSnapshot("work", 0.1)],
      absences: [],
      refreshed_at: "2026-07-28T01:02:03Z",
    });
    const snapshot = ControlCredentialProfilesSnapshotResponse.parse(
      await services({ refreshedQuota, quotaEventCursor: "quota-fence-exact" }).credentialProfiles({
        snapshot: true,
      }),
    );
    expect(snapshot.quota.snapshots).toEqual(
      refreshedQuota.snapshots.map((quota) => ({
        ...quota,
        availability: {
          state: "available",
          blocking_constraints: [],
          resets_at: null,
          model_scoped_exhaustions: [],
        },
      })),
    );
    expect(snapshot.quota.absences).toEqual(refreshedQuota.absences);
    expect(snapshot.quota.refreshed_at).toBe(refreshedQuota.refreshed_at);
    expect(refreshedQuota.snapshots.every((quota) => !("availability" in quota))).toBe(true);
    expect(snapshot.quotaEventCursor).toBe("quota-fence-exact");
    expect(snapshot.accountPools.find((value) => value.harness_id === "claude")?.next_up).toEqual({
      kind: "profile",
      profileId: "work",
    });
  });

  it("pool selection skips an unready row and picks the next ready one", async () => {
    registerConfigDirProfile({ harnessId: "claude", profileId: "work" });
    registerConfigDirProfile({ harnessId: "claude", profileId: "spare" });
    gatewayMock.profileReadinessById = {
      work: { availability: "unavailable", verification: "failed" },
      spare: { availability: "available", verification: "passed" },
    };
    updateGlobalConfig((config) => ({
      ...config,
      harnesses: {
        ...config.harnesses,
        claude: {
          ...(config.harnesses.claude ?? {}),
          profile_policy: {
            limit_action: "rotate",
            rotation_eligible: ["work", "spare"],
            headroom_threshold: 0.9,
          },
        },
      },
    }));
    const refreshedQuota = ControlQuotaResponse.parse({
      snapshots: [quotaSnapshot(null, 0.95)],
      absences: [],
      refreshed_at: "2026-07-28T01:02:03Z",
    });

    const snapshot = ControlCredentialProfilesSnapshotResponse.parse(
      await services({ refreshedQuota }).credentialProfiles({ snapshot: true }),
    );
    expect(snapshot.accountPools.find((value) => value.harness_id === "claude")?.next_up).toEqual({
      kind: "profile",
      profileId: "spare",
    });
  });

  it("projects the API-key ROUTE when every ready row is exhausted (pool exhaustion = unavailability)", async () => {
    registerConfigDirProfile({ harnessId: "claude", profileId: "work" });
    gatewayMock.profileReadiness = { availability: "available", verification: "passed" };
    gatewayMock.statuses = [
      {
        id: "claude",
        available: true,
        status: "ok",
        manifest: null,
        authSources: [
          { source: "native_session", availability: "unavailable", verification: "failed" },
          { source: "api_key_env", availability: "available", verification: "passed" },
        ],
        enabledIntents: ["explain", "implement"],
        routableIntents: ["explain", "implement"],
        disabledIntents: [],
        checks: [],
        reasons: [],
      },
    ];
    const refreshedQuota = ControlQuotaResponse.parse({
      snapshots: [quotaSnapshot("work", 0.95)],
      absences: [],
      refreshed_at: "2026-07-28T01:02:03Z",
    });

    const snapshot = ControlCredentialProfilesSnapshotResponse.parse(
      await services({ refreshedQuota }).credentialProfiles({ snapshot: true }),
    );
    expect(snapshot.accountPools.find((value) => value.harness_id === "claude")?.next_up).toEqual({
      kind: "api_key_route",
    });
  });

  it("fails the complete snapshot when its quota epoch cannot refresh", async () => {
    const error = Object.assign(new Error("quota refresh unavailable"), {
      code: "quota_refresh_unavailable",
      status: 503,
    });
    await expect(
      services({ refreshError: error }).credentialProfiles({ snapshot: true }),
    ).rejects.toBe(error);
  });

  it("projects the non-secret {email, plan} identity from each row's OWN owned store (INV-067)", async () => {
    const { profile } = registerConfigDirProfile({ harnessId: "claude", profileId: "work" });
    const svc = services();
    // The profile's OWN isolation-locator store discloses its identity.
    writeFileSync(
      join(profile.isolation_locator ?? "", ".claude.json"),
      JSON.stringify({
        oauthAccount: { emailAddress: "work@example.test", organizationType: "claude_max" },
      }),
    );

    const listing = ControlCredentialProfilesResponse.parse(await svc.credentialProfiles());

    const profileEntry = listing.profiles.find((p) => p.profile.profile_id === "work");
    expect(profileEntry?.identity).toEqual({ email: "work@example.test", plan: "claude_max" });
  });

  it("projects named Cursor emails from the Accounts-only probe receipts", async () => {
    registerConfigDirProfile({ harnessId: "cursor", profileId: "work" });
    gatewayMock.profileReadiness = { availability: "available", verification: "passed" };
    gatewayMock.profileIdentities = { work: { email: "work-cursor@example.test" } };
    gatewayMock.statuses = [
      {
        id: "cursor",
        available: true,
        status: "ok",
        manifest: null,
        authSources: [
          { source: "native_session", availability: "available", verification: "passed" },
        ],
        enabledIntents: ["explain", "implement"],
        routableIntents: ["explain", "implement"],
        disabledIntents: [],
        checks: [],
        reasons: [],
      },
    ];

    const listing = ControlCredentialProfilesResponse.parse(await services().credentialProfiles());
    expect(listing.profiles.find((entry) => entry.profile.profile_id === "work")?.identity).toEqual(
      { email: "work-cursor@example.test" },
    );
  });

  it("keeps Cursor identity beside a vendor readiness error instead of hiding either", async () => {
    registerConfigDirProfile({ harnessId: "cursor", profileId: "work" });
    gatewayMock.profileReadiness = { availability: "available", verification: "passed" };
    gatewayMock.profileIdentities = { work: { email: "work-cursor@example.test" } };
    const refreshedQuota = ControlQuotaResponse.parse({
      snapshots: [],
      absences: [
        {
          subject: {
            harness: "cursor",
            credential_route: "vendor_native",
            plan_label: null,
            subject_id: "work",
          },
          reason: "auth_revoked",
          detail: "vendor rejected the profile credential",
          observed_at: "2026-08-09T00:00:00Z",
        },
      ],
      refreshed_at: "2026-08-09T00:00:00Z",
    });

    const snapshot = ControlCredentialProfilesSnapshotResponse.parse(
      await services({ refreshedQuota }).credentialProfiles({ snapshot: true }),
    );
    const entry = snapshot.profiles.find((candidate) => candidate.profile.profile_id === "work");
    expect(entry?.identity).toEqual({ email: "work-cursor@example.test" });
    expect(entry?.status).toMatchObject({
      availability: "available",
      verification: "failed",
      verification_source: "vendor",
      detail: "vendor rejected the profile credential",
    });
  });

  it("never lets a token-bearing store leak beyond {email, plan}", async () => {
    const { profile } = registerConfigDirProfile({ harnessId: "claude", profileId: "work" });
    const svc = services();
    writeFileSync(
      join(profile.isolation_locator ?? "", ".claude.json"),
      JSON.stringify({
        oauthAccount: {
          emailAddress: "work@example.test",
          organizationType: "claude_max",
          accountUuid: "uuid-secret-do-not-leak",
        },
        oauthToken: "sk-ant-" + "secret-do-not-leak",
      }),
    );
    const listing = ControlCredentialProfilesResponse.parse(await svc.credentialProfiles());
    const serialized = JSON.stringify(listing);
    expect(serialized).not.toContain("uuid-secret-do-not-leak");
    expect(serialized).not.toContain("sk-ant-" + "secret-do-not-leak");
    const entry = listing.profiles.find((p) => p.profile.profile_id === "work");
    expect(Object.keys(entry?.identity ?? {}).sort()).toEqual(["email", "plan"]);
  });
});

describe("A7 per-subject unusable-ledger clearing on control-API credential mutations", () => {
  let dir: string;
  let prev: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudexor-ledger-clear-"));
    prev = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = dir;
    credentialUnusableLedger.noteCredentialChange();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
    else process.env.CLAUDEXOR_CONFIG_DIR = prev;
    credentialUnusableLedger.noteCredentialChange();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  const observation = (harnessId: string, profileId: string | null) => ({
    harness_id: harnessId,
    profile_id: profileId,
    model: null,
    code: "auth_revoked" as const,
    source: "attempt_stream" as const,
    detail: null,
    observed_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  });

  it("setSecret clears exactly the subject whose profile secret_ref it rewrote", async () => {
    updateGlobalConfig((cfg) => ({
      ...cfg,
      credential_profiles: [
        {
          profile_id: "solo",
          harness_id: "codex",
          display_name: "Solo",
          credential_kind: "api_key",
          isolation_locator: null,
          secret_ref: "openai:solo",
          enabled: true,
          created_at: null,
        },
      ],
    }));
    credentialUnusableLedger.record(observation("codex", "solo"));
    credentialUnusableLedger.record(observation("claude", "other"));
    const svc = services();
    await svc.setSecret({ name: "openai:solo", value: "sk-new" });
    const live = credentialUnusableLedger.live();
    // The rewritten credential's verdict is void; an unrelated subject's is not.
    expect(live.find((o) => o.harness_id === "codex" && o.profile_id === "solo")).toBeUndefined();
    expect(live.find((o) => o.harness_id === "claude" && o.profile_id === "other")).toBeTruthy();
  });

  it("a bare managed name voids every DEFAULT subject's verdict (fail-open), named profiles keep theirs", async () => {
    credentialUnusableLedger.record(observation("cursor", null));
    credentialUnusableLedger.record(observation("codex", null));
    credentialUnusableLedger.record(observation("claude", "work"));
    const svc = services();
    await svc.setSecret({ name: "cursor", value: "key" });
    const live = credentialUnusableLedger.live();
    expect(live.filter((o) => o.profile_id === null)).toEqual([]);
    expect(live.find((o) => o.profile_id === "work")).toBeTruthy();
  });

  it("deleteSecret clears the referencing profile's subject too", async () => {
    updateGlobalConfig((cfg) => ({
      ...cfg,
      credential_profiles: [
        {
          profile_id: "solo",
          harness_id: "codex",
          display_name: "Solo",
          credential_kind: "api_key",
          isolation_locator: null,
          secret_ref: "openai:solo",
          enabled: true,
          created_at: null,
        },
      ],
    }));
    credentialUnusableLedger.record(observation("codex", "solo"));
    const svc = services();
    await svc.deleteSecret("openai:solo");
    expect(credentialUnusableLedger.live()).toEqual([]);
  });
});

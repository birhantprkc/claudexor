import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { registerConfigDirProfile } from "./profile-registration.js";

const gatewayMock = vi.hoisted(() => ({
  statuses: [] as unknown[],
  calls: [] as Array<{ fresh?: boolean }>,
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

vi.mock("./registry.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./registry.js")>();
  return {
    ...original,
    buildRegistry: (options?: Parameters<typeof original.buildRegistry>[0]) => {
      const registry = original.buildRegistry(options);
      for (const [id, adapter] of registry) {
        if (!adapter.probeCredentialProfile) continue;
        registry.set(id, {
          ...adapter,
          probeCredentialProfile: async (profile) => {
            const readiness =
              gatewayMock.profileReadinessById[profile.profile_id] ?? gatewayMock.profileReadiness;
            return {
              profile_id: profile.profile_id,
              harness_id: profile.harness_id,
              availability: readiness.availability,
              verification: readiness.verification,
              detail: "live profile probe disabled in projection unit test",
              last_verified_at: null,
            };
          },
        });
      }
      return registry;
    },
    buildGateway: () => ({
      statusAll: async (input: { fresh?: boolean }) => {
        gatewayMock.calls.push(input);
        return gatewayMock.statuses;
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

  it("projects per-harness accounts authority: next_up native default, enabled profile still native, disabled-CLI-login none (F1)", async () => {
    registerConfigDirProfile({ harnessId: "claude", profileId: "work" });
    const svc = services();

    // Default: CLI login enabled, no quota breach → an unpinned run routes to
    // the native login, so next_up is native. Active is gone; the field is
    // purely informational.
    const base = ControlCredentialProfilesResponse.parse(await svc.credentialProfiles());
    const claudeBase = base.harnessAccounts.find((h) => h.harness_id === "claude");
    expect(claudeBase).toBeDefined();
    expect(claudeBase).not.toHaveProperty("active_profile_id");
    expect(claudeBase).not.toHaveProperty("active_identity");
    expect(claudeBase?.native_credentials_enabled).toBe(true);
    expect(claudeBase?.next_up).toEqual({ kind: "native", route: "local_session" });
    expect(gatewayMock.calls.at(-1)?.fresh).toBe(true);

    // An enabled profile does NOT become an auto-default: unpinned runs still
    // route to the native login (profiles route only by explicit pin / rotation).
    const withProfile = ControlCredentialProfilesResponse.parse(await svc.credentialProfiles());
    expect(withProfile.harnessAccounts.find((h) => h.harness_id === "claude")?.next_up).toEqual({
      kind: "native",
      route: "local_session",
    });

    // Disable the CLI login → an unpinned run has nothing routable (next_up none).
    updateGlobalConfig((config) => ({
      ...config,
      harnesses: {
        claude: {
          ...(config.harnesses.claude ?? {}),
          native_credentials_enabled: false,
        },
      } as never,
    }));
    const none = ControlCredentialProfilesResponse.parse(await svc.credentialProfiles());
    const claudeNone = none.harnessAccounts.find((h) => h.harness_id === "claude");
    expect(claudeNone?.native_credentials_enabled).toBe(false);
    expect(claudeNone?.next_up.kind).toBe("none");
  });

  it("does not project an enabled default as next_up when fresh doctor truth is unavailable", async () => {
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
    const claude = listing.harnessAccounts.find((value) => value.harness_id === "claude");
    expect(claude?.native_credentials_enabled).toBe(true);
    expect(claude?.native_login_detected).toBe(false);
    expect(claude?.next_up).toMatchObject({ kind: "none" });
  });

  it("returns one opt-in snapshot whose rows and next_up share one fresh doctor read", async () => {
    gatewayMock.calls = [];
    const snapshot = ControlCredentialProfilesSnapshotResponse.parse(
      await services().credentialProfiles({ snapshot: true }),
    );
    expect(gatewayMock.calls).toEqual([{ cwd: noProjectRepoRoot(), fresh: true }]);
    expect(snapshot.harnesses.map((status) => status.id)).toEqual(["claude"]);
    expect(
      snapshot.harnessAccounts.find((value) => value.harness_id === "claude")?.next_up,
    ).toEqual({ kind: "native", route: "local_session" });
    expect(snapshot.git.status).toBe("missing");
    expect(snapshot.quota.refreshed_at).toBe("2026-07-28T00:00:00Z");
    const { quotaEventCursor, ...unfenced } = snapshot;
    expect(quotaEventCursor).toBe("quota-fence-default");
    expect(() => ControlCredentialProfilesSnapshotResponse.parse(unfenced)).toThrow();
    expect(ControlCredentialProfilesResponse.parse({ profiles: [], harnessAccounts: [] })).toEqual({
      profiles: [],
      harnessAccounts: [],
    });
  });

  it("projects the API-key fallback route instead of naming an unavailable CLI login", async () => {
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
    const claude = listing.harnessAccounts.find((value) => value.harness_id === "claude");
    expect(claude?.native_login_detected).toBe(false);
    expect(claude?.next_up).toEqual({ kind: "native", route: "api_key" });
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
    expect(snapshot.quota).toEqual(refreshedQuota);
    expect(snapshot.quotaEventCursor).toBe("quota-fence-exact");
    expect(
      snapshot.harnessAccounts.find((value) => value.harness_id === "claude")?.next_up,
    ).toEqual({ kind: "profile", profileId: "work" });
  });

  it("next_up skips an unready rotation target and matches the next ready profile", async () => {
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
    expect(
      snapshot.harnessAccounts.find((value) => value.harness_id === "claude")?.next_up,
    ).toEqual({ kind: "profile", profileId: "spare" });
  });

  it("keeps an API-key default on quota breach instead of changing payment class", async () => {
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
      snapshots: [quotaSnapshot(null, 0.95)],
      absences: [],
      refreshed_at: "2026-07-28T01:02:03Z",
    });

    const snapshot = ControlCredentialProfilesSnapshotResponse.parse(
      await services({ refreshedQuota }).credentialProfiles({ snapshot: true }),
    );
    expect(
      snapshot.harnessAccounts.find((value) => value.harness_id === "claude")?.next_up,
    ).toEqual({ kind: "native", route: "api_key" });
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

  it("projects the non-secret {email, plan} identity from each account's OWN owned store (INV-067)", async () => {
    const { profile } = registerConfigDirProfile({ harnessId: "claude", profileId: "work" });
    const svc = services();
    // The profile's OWN isolation-locator store discloses one identity …
    writeFileSync(
      join(profile.isolation_locator ?? "", ".claude.json"),
      JSON.stringify({
        oauthAccount: { emailAddress: "work@example.test", organizationType: "claude_max" },
      }),
    );
    // … and the Claudexor-owned NATIVE claude store discloses another.
    const nativeDir = join(dir, "native", "claude", "default");
    mkdirSync(nativeDir, { recursive: true });
    writeFileSync(
      join(nativeDir, ".claude.json"),
      JSON.stringify({
        oauthAccount: { emailAddress: "native@example.test", organizationType: "claude_pro" },
      }),
    );

    const listing = ControlCredentialProfilesResponse.parse(await svc.credentialProfiles());

    const profileEntry = listing.profiles.find((p) => p.profile.profile_id === "work");
    expect(profileEntry?.identity).toEqual({ email: "work@example.test", plan: "claude_max" });

    const claudeAccounts = listing.harnessAccounts.find((h) => h.harness_id === "claude");
    expect(claudeAccounts?.identity).toEqual({ email: "native@example.test", plan: "claude_pro" });

    // A harness with no readable native store projects null, never an error.
    const codexAccounts = listing.harnessAccounts.find((h) => h.harness_id === "codex");
    expect(codexAccounts?.identity ?? null).toBeNull();
  });

  it("never lets a token-bearing native store leak beyond {email, plan}", async () => {
    const svc = services();
    const nativeDir = join(dir, "native", "claude", "default");
    mkdirSync(nativeDir, { recursive: true });
    writeFileSync(
      join(nativeDir, ".claude.json"),
      JSON.stringify({
        oauthAccount: {
          emailAddress: "native@example.test",
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
    const claudeAccounts = listing.harnessAccounts.find((h) => h.harness_id === "claude");
    expect(Object.keys(claudeAccounts?.identity ?? {}).sort()).toEqual(["email", "plan"]);
  });
});

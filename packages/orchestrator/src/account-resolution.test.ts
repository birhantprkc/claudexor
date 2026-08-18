/**
 * The account-resolution owner's ladder predicate (INV-135 unified account
 * model): the legacy default-subject ladder serves ONLY harnesses with no
 * REGISTERED subscription rows. A harness whose rows are all DISABLED must
 * refuse typed (or take the disclosed paid route) — never silently spawn back
 * into the same account through the default store the owner just toggled off.
 */
import { describe, expect, it } from "vitest";
import type { CredentialProfile } from "@claudexor/schema";
import { resolveAccountForRun, type AccountResolutionContext } from "./account-resolution.js";

function profileRow(overrides: Partial<CredentialProfile> = {}): CredentialProfile {
  return {
    profile_id: "claude-default",
    harness_id: "claude",
    display_name: "claude default login",
    credential_kind: "config_dir_login",
    isolation_locator: "/tmp/claudexor-test/native/claude/default",
    secret_ref: null,
    enabled: true,
    created_at: null,
    ...overrides,
  };
}

function ctx(overrides: Partial<AccountResolutionContext> = {}): AccountResolutionContext & {
  events: Array<{ type: string; payload: Record<string, unknown> }>;
  apiKeyRouteNoted: () => boolean;
} {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  let noted = false;
  return {
    harnessId: "claude",
    registry: [],
    policy: { limit_action: "fail", rotation_eligible: [], headroom_threshold: 0.9 },
    snapshots: [],
    quota: { snapshots: [], absences: [] },
    unusable: [],
    probe: async (profile) => ({
      profile_id: profile.profile_id,
      harness_id: profile.harness_id,
      availability: "available",
      verification: "passed",
      verification_source: "local_store",
      detail: "test probe",
      last_verified_at: null,
    }),
    pinnedProfile: null,
    boundProfileId: null,
    threadId: null,
    model: null,
    defaultRoute: "local_session",
    nativeCredentialsDisabled: false,
    authPreference: "subscription",
    notePoolApiKeyRoute: () => {
      noted = true;
    },
    emit: (type, payload) => events.push({ type, payload }),
    ...overrides,
    events,
    apiKeyRouteNoted: () => noted,
  };
}

describe("resolveAccountForRun ladder predicate (Enabled-toggle bypass fix)", () => {
  it("all-rows-disabled refuses typed under subscription — never the legacy ladder", async () => {
    const context = ctx({ registry: [profileRow({ enabled: false })] });
    await expect(resolveAccountForRun(context)).rejects.toMatchObject({
      code: "credential_pool_exhausted",
      category: "harness_unavailable",
    });
    expect(context.events.map((event) => event.type)).toContain("route.account.pool_exhausted");
    expect(context.apiKeyRouteNoted()).toBe(false);
  });

  it("all-rows-disabled refuses typed under AUTO too — the paid route is never a silent fallback (Q3=A)", async () => {
    const context = ctx({
      registry: [profileRow({ enabled: false })],
      authPreference: "auto",
    });
    await expect(resolveAccountForRun(context)).rejects.toMatchObject({
      code: "credential_pool_exhausted",
      category: "harness_unavailable",
    });
    expect(context.apiKeyRouteNoted()).toBe(false);
    const exhausted = context.events.find((event) => event.type === "route.account.pool_exhausted");
    expect(exhausted?.payload["fallback"]).toBeNull();
  });

  it("the EXPLICIT api_key preference opts the exhausted pool onto the DISCLOSED paid route", async () => {
    const context = ctx({
      registry: [profileRow({ enabled: false })],
      authPreference: "api_key",
    });
    await expect(resolveAccountForRun(context)).resolves.toBeNull();
    expect(context.apiKeyRouteNoted()).toBe(true);
    const exhausted = context.events.find((event) => event.type === "route.account.pool_exhausted");
    expect(exhausted?.payload["fallback"]).toBe("api_key_route");
  });

  it("a harness with NO registered rows keeps the legacy default-subject ladder", async () => {
    const context = ctx({ registry: [] });
    await expect(resolveAccountForRun(context)).resolves.toBeNull();
    // The ladder path: no pool event, no paid-route note — the default
    // subject serves (unmigrated store).
    expect(context.apiKeyRouteNoted()).toBe(false);
    expect(context.events.map((event) => event.type)).not.toContain("route.account.pool_exhausted");
  });

  it("an api_key row alone does not evict the ladder (the pool holds subscription rows only)", async () => {
    const context = ctx({
      registry: [
        profileRow({ profile_id: "paid", credential_kind: "api_key", secret_ref: "openai:paid" }),
      ],
    });
    await expect(resolveAccountForRun(context)).resolves.toBeNull();
    expect(context.events.map((event) => event.type)).not.toContain("route.account.pool_exhausted");
  });
});

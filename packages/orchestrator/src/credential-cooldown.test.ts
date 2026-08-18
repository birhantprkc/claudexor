import { describe, expect, it } from "vitest";
import type { CredentialProfile, QuotaConstraint, QuotaSnapshot } from "@claudexor/schema";
import { profileQuotaBlock } from "./credential-cooldown.js";
import {
  nextEligibleProfile,
  nextUpIdentity,
  preflightCredentialProfile,
  type ProfilePolicy,
} from "./credential-profiles.js";

const FUTURE = "2099-01-01T00:00:00.000Z";
const PAST = "2020-01-01T00:00:00.000Z";

function profile(id: string): CredentialProfile {
  return {
    profile_id: id,
    harness_id: "cursor",
    display_name: id,
    credential_kind: "config_dir_login",
    isolation_locator: `/tmp/p/${id}`,
    secret_ref: null,
    enabled: true,
    created_at: null,
  };
}

function cooldownSnapshot(
  subjectId: string | null,
  constraint: Partial<QuotaConstraint> = {},
): QuotaSnapshot {
  return {
    subject: {
      harness: "cursor",
      credential_route: "vendor_native",
      plan_label: null,
      subject_id: subjectId,
    },
    constraints: [
      {
        id: "cooldown",
        label: "Cooldown",
        used_ratio: null,
        window_seconds: null,
        resets_at: null,
        cooldown_until: FUTURE,
        ...constraint,
      } as QuotaConstraint,
    ],
    source: "cursor_rate_limit",
    // STALE on purpose: the registry keeps an aged snapshot alive exactly
    // because its cooldown still extends into the future.
    observed_at: "2026-08-17T00:00:00.000Z",
    freshness: "stale",
  };
}

const policy: ProfilePolicy = {
  limit_action: "rotate",
  rotation_eligible: [],
  headroom_threshold: 0.9,
};

describe("profileQuotaBlock (A4 cooldown reader)", () => {
  it("a STALE snapshot with a live cooldown blocks, with typed evidence", () => {
    expect(profileQuotaBlock([cooldownSnapshot("a")], "cursor", "a")).toEqual({
      blocked: true,
      constraint_id: "cooldown",
      resets_at: FUTURE,
      kind: "cooldown",
    });
  });

  it("an expired cooldown never blocks", () => {
    expect(
      profileQuotaBlock([cooldownSnapshot("a", { cooldown_until: PAST })], "cursor", "a"),
    ).toBeNull();
  });

  it("a spent window with a known future reset blocks as exhausted; unknown reset never blocks", () => {
    expect(
      profileQuotaBlock(
        [cooldownSnapshot("a", { cooldown_until: null, used_ratio: 1, resets_at: FUTURE })],
        "cursor",
        "a",
      ),
    ).toMatchObject({ kind: "exhausted", resets_at: FUTURE });
    expect(
      profileQuotaBlock(
        [cooldownSnapshot("a", { cooldown_until: null, used_ratio: 1, resets_at: null })],
        "cursor",
        "a",
      ),
    ).toBeNull();
  });

  it("blocks only the snapshot's own subject — never a sibling or the default", () => {
    const snapshots = [cooldownSnapshot("a")];
    expect(profileQuotaBlock(snapshots, "cursor", "a")).not.toBeNull();
    expect(profileQuotaBlock(snapshots, "cursor", "b")).toBeNull();
    expect(profileQuotaBlock(snapshots, "cursor", null)).toBeNull();
    expect(profileQuotaBlock(snapshots, "codex", "a")).toBeNull();
  });

  it("a Gemini-scoped cooldown never cools the grok lane on the same account", () => {
    const scoped = [cooldownSnapshot("a", { applies_to_models: ["Gemini 3.7 Flash High"] })];
    expect(profileQuotaBlock(scoped, "cursor", "a", "grok-4.6")).toBeNull();
    expect(profileQuotaBlock(scoped, "cursor", "a", "Gemini 3.7 Flash High")).not.toBeNull();
  });

  it("fails OPEN when a display label cannot be proven to cover the routed slug", () => {
    // The init frame reports "Gemini 3.7 Flash High"; the router spends by
    // slug. Unprovable coverage must leave the subject spendable, never cool
    // every model on the account.
    const scoped = [cooldownSnapshot("a", { applies_to_models: ["Gemini 3.7 Flash High"] })];
    expect(profileQuotaBlock(scoped, "cursor", "a", "gemini-3.7-flash")).toBeNull();
    // Provable containment still blocks (alias ⊂ slug).
    const alias = [cooldownSnapshot("a", { applies_to_models: ["gemini"] })];
    expect(profileQuotaBlock(alias, "cursor", "a", "gemini-3.7-flash")).not.toBeNull();
  });

  it("with no model context a scoped window blocks only when it governs the unspecified route", () => {
    const scoped = [cooldownSnapshot("a", { applies_to_models: ["Gemini 3.7 Flash High"] })];
    expect(profileQuotaBlock(scoped, "cursor", "a", null)).toBeNull();
    const governing = [
      cooldownSnapshot("a", {
        applies_to_models: ["Gemini 3.7 Flash High"],
        applies_to_unspecified_model: true,
      }),
    ];
    expect(profileQuotaBlock(governing, "cursor", "a", null)).not.toBeNull();
  });
});

describe("A4 wiring: rotation and preflight see observed live blocks", () => {
  const a = profile("a");
  const b = profile("b");
  const ready = (...ids: string[]): ReadonlySet<string> => new Set(ids);

  it("nextEligibleProfile skips a candidate whose own windows are still cooling", () => {
    expect(
      nextEligibleProfile([a, b], "cursor", policy, a, [cooldownSnapshot("b")], ready("b")),
    ).toBeNull();
    expect(
      nextEligibleProfile(
        [a, b],
        "cursor",
        policy,
        a,
        [cooldownSnapshot("b", { cooldown_until: PAST })],
        ready("b"),
      )?.profile_id,
    ).toBe("b");
  });

  it("preflight rotates a pinned profile away from its live cooldown with provenance", () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const next = preflightCredentialProfile({
      profile: a,
      harnessId: "cursor",
      policy,
      registry: [a, b],
      snapshots: [cooldownSnapshot("a")],
      readyProfileIds: ready("b"),
      emit: (type, payload) => events.push({ type, payload }),
    });
    expect(next.profile_id).toBe("b");
    expect(events.map((e) => e.type)).toEqual([
      "route.profile.headroom_exceeded",
      "route.profile.rotated",
    ]);
    expect(events[0]?.payload).toMatchObject({
      profile_id: "a",
      used_ratio: null,
      constraint_id: "cooldown",
      resets_at: FUTURE,
    });
    expect(events[1]?.payload).toMatchObject({ to_profile_id: "b", resets_at: FUTURE });
  });

  it("preflight under FAIL refuses a live cooldown before spawn, machine-readably", () => {
    try {
      preflightCredentialProfile({
        profile: a,
        harnessId: "cursor",
        policy: { ...policy, limit_action: "fail" },
        registry: [a],
        snapshots: [cooldownSnapshot("a")],
        readyProfileIds: ready(),
        emit: () => {},
      });
      expect.unreachable("a live cooldown under fail must refuse before spawn");
    } catch (error) {
      expect(error).toMatchObject({
        code: "subscription_window_exhausted",
        category: "harness_unavailable",
        resetsAt: FUTURE,
      });
    }
  });

  it("rotation_exhausted names a cooling candidate `cooldown` with its release instant, then refuses TYPED (A5)", () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    // The pinned subject's own live block + a fully-blocked pool is hard
    // evidence (A5 preflight split): the refusal happens BEFORE spawn instead
    // of proceeding into a certain vendor rejection.
    expect(() =>
      preflightCredentialProfile({
        profile: a,
        harnessId: "cursor",
        policy,
        registry: [a, b],
        snapshots: [cooldownSnapshot("a"), cooldownSnapshot("b")],
        readyProfileIds: ready("b"),
        emit: (type, payload) => events.push({ type, payload }),
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "credential_pool_exhausted",
        category: "harness_unavailable",
        resetsAt: FUTURE,
      }),
    );
    const exhausted = events.find((e) => e.type === "route.profile.rotation_exhausted");
    const candidates = exhausted?.payload["candidates"] as Array<Record<string, unknown>>;
    expect(candidates.find((c) => c["profile_id"] === "b")).toMatchObject({
      rejected: "cooldown",
      resets_at: FUTURE,
      cooldown: { kind: "cooldown", resets_at: FUTURE },
    });
  });

  it("next_up fails the DEFAULT subject over to a profile when its own windows are cooling", () => {
    expect(
      nextUpIdentity({
        registry: [b],
        harnessId: "cursor",
        policy,
        snapshots: [cooldownSnapshot(null)],
        defaultEnabled: true,
        defaultReady: true,
        defaultRoute: "local_session",
        readyProfileIds: ready("b"),
        model: null,
      }),
    ).toEqual({ kind: "profile", profileId: "b" });
  });
});

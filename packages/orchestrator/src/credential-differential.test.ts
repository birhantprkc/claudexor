import { describe, expect, it } from "vitest";
import type {
  CredentialProfile,
  CredentialProfileStatus,
  CredentialUnusableObservation,
} from "@claudexor/schema";
import {
  currentSubjectProber,
  differentialSubjectVerdict,
  readyProfilesForRotation,
} from "./credential-differential.js";
import { liveUnusableFor } from "./credential-cooldown.js";
import type { TransientFailureObservation } from "./transientClassify.js";

const work: CredentialProfile = {
  profile_id: "work",
  harness_id: "claude",
  display_name: "Work",
  credential_kind: "config_dir_login",
  isolation_locator: "/tmp/p/work",
  secret_ref: null,
  enabled: true,
  created_at: null,
};

const emptyQuota = { snapshots: [], absences: [] };

function transient(
  category: TransientFailureObservation["category"],
  retryable: boolean,
): TransientFailureObservation {
  return {
    kind: "unknown",
    category,
    retryable,
    retryDelayMs: null,
    httpStatus: null,
    signal: null,
    adapterCode: category === "capability_refused" ? "oauth_org_not_allowed" : null,
  };
}

function passingProbe(profile: CredentialProfile): Promise<CredentialProfileStatus> {
  return Promise.resolve({
    profile_id: profile.profile_id,
    harness_id: profile.harness_id,
    availability: "available",
    verification: "passed",
    verification_source: "local_store",
    last_verified_at: null,
  });
}

function obs(over: Partial<CredentialUnusableObservation>): CredentialUnusableObservation {
  return {
    harness_id: "claude",
    profile_id: "work",
    model: null,
    code: "auth_revoked",
    source: "vendor_poller",
    detail: null,
    observed_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    ...over,
  };
}

describe("differentialSubjectVerdict (A7 — dead credential vs spent quota)", () => {
  it("a typed NON-RETRYABLE entitlement refusal on the attempt stream is the strongest evidence, scoped to the attempt's model", async () => {
    const verdict = await differentialSubjectVerdict({
      harnessId: "claude",
      profile: work,
      model: "opus",
      quota: emptyQuota,
      transients: [transient("capability_refused", false)],
      probe: passingProbe,
    });
    expect(verdict).toMatchObject({
      code: "capability_refused",
      source: "attempt_stream",
      model: "opus",
      profile_id: "work",
      detail: "oauth_org_not_allowed",
    });
  });

  it("a typed auth_failed refusal condemns the credential for EVERY model", async () => {
    const verdict = await differentialSubjectVerdict({
      harnessId: "claude",
      profile: work,
      model: "opus",
      quota: emptyQuota,
      transients: [transient("auth_failed", false)],
    });
    expect(verdict).toMatchObject({ code: "auth_revoked", source: "attempt_stream", model: null });
  });

  it("a RETRYABLE rate limit is quota's story, never a dead-credential verdict", async () => {
    const verdict = await differentialSubjectVerdict({
      harnessId: "claude",
      profile: work,
      model: null,
      quota: emptyQuota,
      transients: [transient("rate_limited", true)],
      probe: passingProbe,
    });
    expect(verdict).toBeNull();
  });

  it("the poller's typed auth_revoked absence condemns the subject — default subject included", async () => {
    const quota = {
      snapshots: [],
      absences: [
        {
          subject: {
            harness: "claude",
            credential_route: "vendor_native" as const,
            plan_label: null,
            subject_id: null,
          },
          reason: "auth_revoked" as const,
          detail: "vendor rejected the token",
          observed_at: new Date().toISOString(),
        },
      ],
    };
    const verdict = await differentialSubjectVerdict({
      harnessId: "claude",
      profile: null,
      model: null,
      quota,
      transients: [],
    });
    expect(verdict).toMatchObject({
      code: "auth_revoked",
      source: "vendor_poller",
      profile_id: null,
      detail: "vendor rejected the token",
    });
  });

  it("a FAILED local doctor verification is a dead-credential fact (pinned profiles only)", async () => {
    const verdict = await differentialSubjectVerdict({
      harnessId: "claude",
      profile: work,
      model: null,
      quota: emptyQuota,
      transients: [],
      probe: (profile) =>
        Promise.resolve({
          profile_id: profile.profile_id,
          harness_id: profile.harness_id,
          availability: "unavailable",
          verification: "failed",
          verification_source: "local_store",
          detail: "profile login expired",
          last_verified_at: null,
        }),
    });
    expect(verdict).toMatchObject({ code: "verification_failed", source: "local_probe" });
    // The default subject has no per-profile probe surface: no evidence, no verdict.
    await expect(
      differentialSubjectVerdict({
        harnessId: "claude",
        profile: null,
        model: null,
        quota: emptyQuota,
        transients: [],
      }),
    ).resolves.toBeNull();
  });

  it("every observation self-expires within the 24h bound", async () => {
    const now = new Date();
    const verdict = await differentialSubjectVerdict({
      harnessId: "claude",
      profile: work,
      model: null,
      quota: emptyQuota,
      transients: [transient("auth_failed", false)],
      now,
    });
    const ttl = Date.parse(verdict!.expires_at) - now.getTime();
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(24 * 60 * 60_000);
  });
});

describe("currentSubjectProber (the sibling probe — NEVER a mini-run)", () => {
  it("records the verdict through the sink and survives a throwing sink", async () => {
    const recorded: CredentialUnusableObservation[] = [];
    const prober = currentSubjectProber({
      harnessId: "claude",
      profile: work,
      model: null,
      quota: emptyQuota,
      transients: [transient("auth_failed", false)],
      record: (o) => {
        recorded.push(o);
        throw new Error("sink exploded");
      },
    });
    const verdict = await prober();
    expect(verdict?.code).toBe("auth_revoked");
    expect(recorded).toHaveLength(1);
  });

  it("spends NO quota: the probe path can only reach the doctor probe, never run()", async () => {
    // The design essay's line: a config-dir login has no cheaper liveness test
    // than spending quota on a mini-run — so the prober is handed ONLY the
    // doctor probe. A full adapter proves the boundary: run() must stay cold.
    const calls: string[] = [];
    const adapter = {
      probeCredentialProfile(profile: CredentialProfile) {
        calls.push(`probe:${profile.profile_id}`);
        return passingProbe(profile);
      },
      run() {
        calls.push("run");
        throw new Error("the differential probe must never spawn an attempt");
      },
    };
    const prober = currentSubjectProber({
      harnessId: "claude",
      profile: work,
      model: null,
      quota: emptyQuota,
      transients: [],
      probe: adapter.probeCredentialProfile.bind(adapter),
    });
    await expect(prober()).resolves.toBeNull();
    expect(calls).toEqual(["probe:work"]);
  });
});

describe("readyProfilesForRotation (A7 live-observation refusal at the ONE composition point)", () => {
  const policy = {
    limit_action: "rotate" as const,
    rotation_eligible: [],
    headroom_threshold: 0.9,
  };
  const other = { ...work, profile_id: "other", isolation_locator: "/tmp/p/other" };

  async function readyWith(unusable: readonly CredentialUnusableObservation[], model?: string) {
    return readyProfilesForRotation({
      registry: [work, other],
      harnessId: "claude",
      policy,
      current: work,
      probe: passingProbe,
      quota: emptyQuota,
      unusable,
      model: model ?? null,
    });
  }

  it("a LIVE credential_unusable observation refuses the candidate", async () => {
    expect(await readyWith([])).toEqual(new Set(["other"]));
    expect(await readyWith([obs({ profile_id: "other" })])).toEqual(new Set());
  });

  it("an EXPIRED observation is ignored (clearing contract: self-expiry)", async () => {
    const expired = obs({
      profile_id: "other",
      expires_at: new Date(Date.now() - 1_000).toISOString(),
    });
    expect(await readyWith([expired])).toEqual(new Set(["other"]));
  });

  it("a MODEL-SCOPED observation refuses only its own model", async () => {
    const scoped = obs({ profile_id: "other", code: "capability_refused", model: "opus" });
    expect(await readyWith([scoped], "opus")).toEqual(new Set());
    expect(await readyWith([scoped], "sonnet")).toEqual(new Set(["other"]));
  });
});

describe("liveUnusableFor (the one matcher)", () => {
  it("matches subject + model + liveness exactly", () => {
    const wide = obs({});
    expect(liveUnusableFor([wide], "claude", "work")).toBe(wide);
    expect(liveUnusableFor([wide], "claude", "work", "opus")).toBe(wide);
    expect(liveUnusableFor([wide], "claude", null)).toBeNull();
    expect(liveUnusableFor([wide], "codex", "work")).toBeNull();
    const scoped = obs({ model: "opus" });
    expect(liveUnusableFor([scoped], "claude", "work", "opus")).toBe(scoped);
    expect(liveUnusableFor([scoped], "claude", "work")).toBeNull();
    expect(liveUnusableFor([scoped], "claude", "work", "sonnet")).toBeNull();
  });
});

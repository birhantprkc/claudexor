import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultNativeCodexHome } from "@claudexor/harness-codex";
import {
  codexQuotaInvocation,
  parseCodexRateLimitsResponse,
  refreshCodexQuota,
} from "./codex-quota-source.js";

describe("Codex app-server quota source", () => {
  it("keeps every bucket/window and vendor metadata without an aggregate", () => {
    const [snapshot] = parseCodexRateLimitsResponse(
      {
        rateLimits: { planType: "plus", limitId: "codex" },
        rateLimitsByLimitId: {
          codex: {
            limitId: "codex",
            limitName: "Codex",
            primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1782368577 },
            secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1782387153 },
            burst: { usedPercent: 5, windowDurationMins: 15, resetsAt: 1782351000 },
            metadata: { display: "not a window" },
          },
          review: {
            limitId: "review",
            limitName: "Review",
            primary: { usedPercent: 10, windowDurationMins: 60, resetsAt: 1782360000 },
          },
        },
      },
      new Date("2026-07-15T12:00:00.000Z"),
    );
    expect(snapshot?.subject.plan_label).toBe("plus");
    expect(snapshot?.constraints.map((item) => [item.id, item.used_ratio])).toEqual([
      ["codex:primary", 0.2],
      ["codex:secondary", 0.4],
      ["codex:burst", 0.05],
      ["review:primary", 0.1],
    ]);
  });

  it("defaults quota reads to the Claudexor-owned native home and scrubs provider secrets", () => {
    const invocation = codexQuotaInvocation({
      PATH: "/bin",
      HOME: "/operator",
      CODEX_HOME: "/operator/.codex",
      OPENAI_API_KEY: "secret",
      ANTHROPIC_API_KEY: "other-secret",
      OPENAI_API_BASE: "https://redirect.invalid",
    });

    expect(invocation.args).toEqual([
      "-c",
      'cli_auth_credentials_store="file"',
      "app-server",
      "--stdio",
    ]);
    expect(invocation.env.CODEX_HOME).toBe(defaultNativeCodexHome());
    expect(invocation.env.OPENAI_API_KEY).toBeUndefined();
    expect(invocation.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(invocation.env.OPENAI_API_BASE).toBeUndefined();
    expect(invocation.env.HOME).toBe("/operator");
  });

  it("honors an explicit CODEX_HOME (per-profile quota reads bind to the profile home)", () => {
    const invocation = codexQuotaInvocation(
      { PATH: "/bin", HOME: "/operator" },
      "/scoped/work-home",
    );
    expect(invocation.env.CODEX_HOME).toBe("/scoped/work-home");
    expect(invocation.env.HOME).toBe("/operator");
  });

  it("stamps subject_id onto the snapshot for a profiled candidate", () => {
    const [snapshot] = parseCodexRateLimitsResponse(
      {
        rateLimits: {
          limitId: "codex",
          primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1782360000 },
        },
      },
      new Date("2026-07-15T12:00:00.000Z"),
      "work",
    );
    expect(snapshot?.subject.subject_id).toBe("work");
  });

  it("a logged-out native home yields a not_logged_in absence WITHOUT spawning the binary", async () => {
    // No auth.json in the hermetic native home: even a "binary" that would
    // explode on spawn must never be reached (v3.0.3 S8 precheck).
    const result = await refreshCodexQuota({ bin: "/definitely/missing/claudexor-codex" });
    expect(result.snapshots).toEqual([]);
    const nativeAbsence = result.absences?.find((a) => a.subject.subject_id === null);
    expect(nativeAbsence?.subject.harness).toBe("codex");
    expect(nativeAbsence?.reason).toBe("not_logged_in");
    expect(nativeAbsence?.detail).toContain("auth login codex");
  });

  it("a post-migration refresh cycle carries no null candidate — the row alone covers the migrated home", async () => {
    // With a completed codex migration record, the retired null subject must
    // not resurrect: only the row candidate observes the (shared) store, so
    // one refresh cycle never double-probes it. Logged-out rows make the
    // observation cheap (typed absence, no binary spawn).
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "claudexor-codex-mig-"));
    const prev = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = dir;
    try {
      const { accountsMigrationFilePath } = await import("./accounts-unified-migration.js");
      const { updateGlobalConfig } = await import("@claudexor/config");
      const home = defaultNativeCodexHome();
      mkdirSync(home, { recursive: true });
      mkdirSync(join(accountsMigrationFilePath(), ".."), { recursive: true });
      writeFileSync(
        accountsMigrationFilePath(),
        JSON.stringify({
          codex: {
            phase: "completed",
            row_id: "codex-default",
            legacy_aliases: [null],
            locator: home,
            backup_ref: null,
          },
        }),
      );
      updateGlobalConfig((config) => ({
        ...config,
        credential_profiles: [
          {
            profile_id: "codex-default",
            harness_id: "codex",
            display_name: "migrated",
            credential_kind: "config_dir_login",
            isolation_locator: home,
            secret_ref: null,
            enabled: true,
            created_at: null,
          },
        ],
      }));
      const result = await refreshCodexQuota({ bin: "/definitely/missing/claudexor-codex" });
      expect(result.snapshots).toEqual([]);
      // Exactly one observation of the store — the row's; never {codex, null}.
      expect(result.absences?.map((a) => a.subject.subject_id)).toEqual(["codex-default"]);
      expect(result.absences?.some((a) => a.subject.subject_id === null)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a missing Codex binary yields a transport absence claim, not a throw", async () => {
    const home = defaultNativeCodexHome();
    mkdirSync(home, { recursive: true });
    const authPath = join(home, "auth.json");
    writeFileSync(authPath, "{}\n");
    try {
      const result = await refreshCodexQuota({ bin: "/definitely/missing/claudexor-codex" });
      expect(result.snapshots).toEqual([]);
      const nativeAbsence = result.absences?.find((a) => a.subject.subject_id === null);
      expect(nativeAbsence?.subject.harness).toBe("codex");
      expect(nativeAbsence?.reason).toBe("transport_unavailable");
      expect(nativeAbsence?.detail).toContain("Codex app-server quota refresh failed");
    } finally {
      rmSync(authPath, { force: true });
    }
  });
});

describe("codex rateLimitResetCredits (W5.3 mini-gap, live-verified shape)", () => {
  const base = {
    rateLimits: {
      limitId: "codex",
      primary: { usedPercent: 63, windowDurationMins: 10080, resetsAt: 1784822659 },
      planType: "pro",
    },
  };

  it("surfaces a positive credit balance as a visible fact row", () => {
    const [snapshot] = parseCodexRateLimitsResponse(
      { ...base, rateLimitResetCredits: { availableCount: 3, credits: [] } },
      new Date("2026-07-17T12:00:00Z"),
    );
    expect(snapshot?.constraints.some((c) => c.id === "reset_credits")).toBe(true);
    expect(snapshot?.constraints.find((c) => c.id === "reset_credits")?.label).toBe(
      "3 reset credits available",
    );
  });

  it("stays silent on the live zero-balance shape", () => {
    const [snapshot] = parseCodexRateLimitsResponse(
      { ...base, rateLimitResetCredits: { availableCount: 0, credits: [] } },
      new Date("2026-07-17T12:00:00Z"),
    );
    expect(snapshot?.constraints.some((c) => c.id === "reset_credits")).toBe(false);
  });
});

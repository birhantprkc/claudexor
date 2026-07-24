import { describe, expect, it } from "vitest";
import type { HarnessRunSpec } from "@claudexor/schema";
import { effortLevelsForModel } from "@claudexor/schema";
import { resolveEffort } from "@claudexor/core";
import { clearCodexEffortCache, createCodexAdapter } from "./index.js";
import { codexExecArgs } from "./index.js";
import {
  CODEX_EFFORT_SNAPSHOT,
  codexEffortsForEnv,
  probeCodexEfforts,
  readModelListEfforts,
  unionEffortLevels,
  type CodexEffortCapability,
} from "./effort-probe.js";

const base = {
  access: "workspace_write" as const,
  model_hint: null,
  effort_hint: null,
  external_context_policy: "auto" as const,
  prompt: "hello",
  instructions: undefined,
  attachments: [],
  browser: null,
} satisfies Parameters<typeof codexExecArgs>[0];

/** The `-c model_reasoning_effort="X"` value the args carry, or null. */
function emittedEffort(args: string[]): string | null {
  const hit = args.find((a) => a.startsWith("model_reasoning_effort="));
  return hit ? (/"([^"]*)"/.exec(hit)?.[1] ?? null) : null;
}

describe("codex effort is resolved per MODEL, not per harness", () => {
  it("accepts ultra for gpt-5.6-sol (live-verified: sol advertises ultra)", () => {
    const args = codexExecArgs({ ...base, model_hint: "gpt-5.6-sol", effort_hint: "ultra" });
    expect(emittedEffort(args)).toBe("ultra");
  });

  it("does NOT send ultra to gpt-5.4, which stops at xhigh — the ceiling belongs to the model", () => {
    const args = codexExecArgs({ ...base, model_hint: "gpt-5.4", effort_hint: "ultra" });
    // ultra is rankable, so it clamps onto gpt-5.4's real ceiling instead of
    // being forwarded to die as an opaque vendor `unsupported_value`.
    expect(emittedEffort(args)).toBe("xhigh");
  });

  it("refuses ultra for gpt-5.4 with an error naming what IS advertised, on a surface that can talk back", () => {
    const advertised = effortLevelsForModel(
      {
        effort_levels: unionEffortLevels(CODEX_EFFORT_SNAPSHOT),
        model_effort_levels: CODEX_EFFORT_SNAPSHOT,
      },
      "gpt-5.4",
    );
    expect([...advertised]).toEqual(["low", "medium", "high", "xhigh"]);
    // The same pairing accepts it on sol, which is exactly the per-model point.
    const onSol = effortLevelsForModel(
      {
        effort_levels: unionEffortLevels(CODEX_EFFORT_SNAPSHOT),
        model_effort_levels: CODEX_EFFORT_SNAPSHOT,
      },
      "gpt-5.6-sol",
    );
    expect(resolveEffort("ultra", onSol)).toEqual({
      status: "ok",
      effort: "ultra",
      clamped: false,
    });
    const refusal = resolveEffort("hyperdrive", advertised);
    expect(refusal.status).toBe("rejected");
    if (refusal.status !== "rejected") throw new Error("expected a rejection");
    expect(refusal.message).toContain("low, medium, high, xhigh");
  });

  it("max reaches gpt-5.6-luna (advertised) but clamps on gpt-5.5 (not advertised)", () => {
    expect(
      emittedEffort(codexExecArgs({ ...base, model_hint: "gpt-5.6-luna", effort_hint: "max" })),
    ).toBe("max");
    expect(
      emittedEffort(codexExecArgs({ ...base, model_hint: "gpt-5.5", effort_hint: "max" })),
    ).toBe("xhigh");
  });

  it("passes a level the rank table has never heard of straight through when the model advertises it", () => {
    // A future codex release adding a level must work with NO change here.
    const future: CodexEffortCapability = {
      "gpt-9": { levels: ["low", "high", "hyperdrive"], default: "high" },
    };
    const args = codexExecArgs(
      { ...base, model_hint: "gpt-9", effort_hint: "hyperdrive" },
      { effortCapability: future },
    );
    expect(emittedEffort(args)).toBe("hyperdrive");
  });

  it("falls back to the harness-wide union when the model is unknown to the probe", () => {
    const args = codexExecArgs({ ...base, model_hint: "gpt-brand-new", effort_hint: "ultra" });
    expect(emittedEffort(args)).toBe("ultra");
  });

  it("sends no effort flag when none was requested", () => {
    expect(emittedEffort(codexExecArgs({ ...base, model_hint: "gpt-5.4" }))).toBeNull();
  });

  it("resolves effort on the resume path too, not just a fresh exec", () => {
    const args = codexExecArgs({
      ...base,
      resume_session_id: "s1",
      model_hint: "gpt-5.4",
      effort_hint: "ultra",
    });
    expect(emittedEffort(args)).toBe("xhigh");
  });
});

describe("codex effort probe degrades gracefully", () => {
  it("returns null instead of throwing when the binary does not exist", async () => {
    expect(await probeCodexEfforts("claudexor-no-such-codex-binary")).toBeNull();
  });

  it("returns null when the app-server never answers, bounded by the timeout", async () => {
    // `sleep` speaks no JSON-RPC: the probe must time out, not hang the run.
    expect(await probeCodexEfforts("sleep", { timeoutMs: 250 })).toBeNull();
  });

  it("arg building keeps working on the snapshot when the probe cannot answer", () => {
    // No capability passed = exactly the state after a failed probe.
    const args = codexExecArgs({ ...base, model_hint: "gpt-5.6-sol", effort_hint: "max" });
    expect(emittedEffort(args)).toBe("max");
  });

  it("the recorded snapshot matches the live model/list capture it was taken from", () => {
    expect(Object.keys(CODEX_EFFORT_SNAPSHOT).sort()).toEqual([
      "gpt-5.3-codex-spark",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.5",
      "gpt-5.6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
    ]);
    expect(unionEffortLevels(CODEX_EFFORT_SNAPSHOT)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
  });
});

// Type-level guard: the arg builder's spec shape stays assignable from a real spec.
export type _CodexEffortSpecShape = Pick<HarnessRunSpec, "effort_hint" | "model_hint">;

describe("the effort probe is cached, not re-spawned per call", () => {
  /** Adapter wired to a stub vendor so discovery runs without a real codex. */
  function stubAdapter(probeEfforts: () => Promise<CodexEffortCapability | null>, nowMs = () => 0) {
    let calls = 0;
    const adapter = createCodexAdapter({
      detectVersion: async () => "codex-cli 0.144.1",
      probeLogin: async () => ({ authed: true, method: "chatgpt", probeError: null }),
      hasApiKey: () => false,
      probeEfforts: async () => {
        calls += 1;
        return await probeEfforts();
      },
      nowMs,
    });
    return { adapter, calls: () => calls };
  }

  it("probes once and serves later discoveries from the TTL cache", async () => {
    clearCodexEffortCache();
    const { adapter, calls } = stubAdapter(async () => ({
      "gpt-9": { levels: ["low", "high"], default: "high" },
    }));
    const first = await adapter.discover();
    const second = await adapter.discover();
    expect(calls()).toBe(1);
    expect(first.capabilities.effort_levels).toEqual(["low", "high"]);
    expect(second.capabilities.model_effort_levels["gpt-9"]?.levels).toEqual(["low", "high"]);
    clearCodexEffortCache();
  });

  it("falls back to the snapshot WITHOUT failing discovery when the probe cannot answer", async () => {
    clearCodexEffortCache();
    const { adapter } = stubAdapter(async () => null);
    const manifest = await adapter.discover();
    // The run is fully usable: real ladders, and a stamp that says the snapshot
    // answered rather than the installed CLI, so the freshness gate can warn.
    expect(manifest.capabilities.model_effort_levels["gpt-5.6-sol"]?.levels).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
    expect(manifest.capabilities.effort_levels_verified_against).toBe("0.144.1");
    clearCodexEffortCache();
  });

  it("stamps the INSTALLED version when the live probe answered", async () => {
    clearCodexEffortCache();
    const { adapter } = stubAdapter(async () => CODEX_EFFORT_SNAPSHOT);
    const manifest = await adapter.discover();
    expect(manifest.capabilities.effort_levels_verified_against).toBe("codex-cli 0.144.1");
    clearCodexEffortCache();
  });
});

describe("the effort cache is keyed by the codex IDENTITY, not just the binary", () => {
  /** Two accounts, one binary — exactly the credential-profile / api-key shape. */
  const CATALOGS: Record<string, CodexEffortCapability> = {
    "/tmp/claudexor-profile-a": { "gpt-9": { levels: ["low", "high"], default: "high" } },
    "/tmp/claudexor-profile-b": {
      "gpt-9": { levels: ["low", "medium", "high", "ultra"], default: "low" },
    },
  };

  function envProbe() {
    const homes: Array<string | undefined> = [];
    const probeEfforts = async (_bin: string, env?: NodeJS.ProcessEnv) => {
      homes.push(env?.["CODEX_HOME"]);
      return CATALOGS[env?.["CODEX_HOME"] ?? ""] ?? null;
    };
    return { deps: { probeEfforts, nowMs: () => 0 }, homes };
  }

  it("probes each CODEX_HOME separately instead of serving one account another's catalog", async () => {
    clearCodexEffortCache();
    const { deps, homes } = envProbe();
    const a = await codexEffortsForEnv(deps, { CODEX_HOME: "/tmp/claudexor-profile-a" });
    const b = await codexEffortsForEnv(deps, { CODEX_HOME: "/tmp/claudexor-profile-b" });
    // Keyed by the binary alone, profile B was served A's ladder for the whole
    // TTL — omitting `ultra`, which B genuinely advertises.
    expect(homes).toEqual(["/tmp/claudexor-profile-a", "/tmp/claudexor-profile-b"]);
    expect(a.capability["gpt-9"]?.levels).toEqual(["low", "high"]);
    expect(b.capability["gpt-9"]?.levels).toEqual(["low", "medium", "high", "ultra"]);
    clearCodexEffortCache();
  });

  it("keeps an independent cache entry per home, so neither profile evicts the other", async () => {
    clearCodexEffortCache();
    const { deps, homes } = envProbe();
    await codexEffortsForEnv(deps, { CODEX_HOME: "/tmp/claudexor-profile-a" });
    await codexEffortsForEnv(deps, { CODEX_HOME: "/tmp/claudexor-profile-b" });
    const aAgain = await codexEffortsForEnv(deps, { CODEX_HOME: "/tmp/claudexor-profile-a" });
    const bAgain = await codexEffortsForEnv(deps, { CODEX_HOME: "/tmp/claudexor-profile-b" });
    // Two probes total: each home was cached under its own key and both hit.
    expect(homes).toHaveLength(2);
    expect(aAgain.capability["gpt-9"]?.levels).toEqual(["low", "high"]);
    expect(bAgain.capability["gpt-9"]?.levels).toEqual(["low", "medium", "high", "ultra"]);
    clearCodexEffortCache();
  });

  it("a home with no live answer falls back to the snapshot without poisoning another home", async () => {
    clearCodexEffortCache();
    const { deps } = envProbe();
    const unknown = await codexEffortsForEnv(deps, { CODEX_HOME: "/tmp/claudexor-profile-none" });
    expect(unknown.live).toBe(false);
    expect(unknown.capability).toBe(CODEX_EFFORT_SNAPSHOT);
    const a = await codexEffortsForEnv(deps, { CODEX_HOME: "/tmp/claudexor-profile-a" });
    expect(a.live).toBe(true);
    expect(a.capability["gpt-9"]?.levels).toEqual(["low", "high"]);
    clearCodexEffortCache();
  });
});

describe("a malformed model/list is a FAILED probe, not a narrowed ladder", () => {
  /** One `model/list` payload; `fallback` omitted = no `defaultReasoningEffort` key. */
  const entry = (levels: unknown[], ...fallback: unknown[]) => [
    {
      id: "gpt-9",
      ...(fallback.length > 0 ? { defaultReasoningEffort: fallback[0] } : {}),
      supportedReasoningEfforts: levels.map((reasoningEffort) => ({ reasoningEffort })),
    },
  ];

  it("accepts a well-formed payload, including a level the rank table never heard of", () => {
    expect(readModelListEfforts(entry(["low", "high", "hyperdrive"], "low"))).toEqual({
      "gpt-9": { levels: ["low", "high", "hyperdrive"], default: "low" },
    });
  });

  it("refuses a level with invalid characters instead of publishing it as live", () => {
    // `HIGH!` passes "non-empty string" but fails the EffortHint contract, so it
    // would later blow up HarnessManifest.parse — breaking discovery rather than
    // degrading it. Returning null degrades to the snapshot, as promised.
    expect(readModelListEfforts(entry(["low", "HIGH!"]))).toBeNull();
    expect(readModelListEfforts(entry(["low", "very high"]))).toBeNull();
    expect(readModelListEfforts(entry(["low", "-low"]))).toBeNull();
  });

  it("refuses an over-long level rather than truncating or dropping it", () => {
    expect(readModelListEfforts(entry(["low", "x".repeat(33)]))).toBeNull();
    // One character under the bound is a legitimate (if odd) vendor level.
    expect(readModelListEfforts(entry(["low", "x".repeat(32)]))?.["gpt-9"]?.levels).toEqual([
      "low",
      "x".repeat(32),
    ]);
  });

  it("refuses a malformed DEFAULT even when every level is fine", () => {
    expect(readModelListEfforts(entry(["low", "high"], "HIGH!"))).toBeNull();
    expect(readModelListEfforts(entry(["low", "high"], 3))).toBeNull();
    // An ABSENT default is ordinary vendor output, not malformed.
    expect(readModelListEfforts(entry(["low", "high"]))).toEqual({
      "gpt-9": { levels: ["low", "high"], default: null },
    });
    expect(readModelListEfforts(entry(["low", "high"], ""))?.["gpt-9"]?.default).toBeNull();
  });

  it("discards the WHOLE catalog when one model is malformed — no half-live ladder", () => {
    const payload = [
      { id: "gpt-8", supportedReasoningEfforts: [{ reasoningEffort: "low" }] },
      { id: "gpt-9", supportedReasoningEfforts: [{ reasoningEffort: "ULTRA" }] },
    ];
    expect(readModelListEfforts(payload)).toBeNull();
  });

  it("still SKIPS mere absence: a model advertising no effort surface is normal", () => {
    const payload = [
      { id: "gpt-8" },
      { id: "", supportedReasoningEfforts: [{ reasoningEffort: "low" }] },
      { id: "gpt-9", supportedReasoningEfforts: [] },
      { id: "gpt-7", supportedReasoningEfforts: [{}, { reasoningEffort: "high" }] },
    ];
    expect(readModelListEfforts(payload)).toEqual({
      "gpt-7": { levels: ["high"], default: null },
    });
  });

  it("returns null for a non-array payload and for an all-empty one", () => {
    expect(readModelListEfforts(undefined)).toBeNull();
    expect(readModelListEfforts({ data: [] })).toBeNull();
    expect(readModelListEfforts([])).toBeNull();
  });
});

describe("the advertised union is RANKED, not probe-ordered", () => {
  it("sorts weakest to strongest however the vendor listed its models", () => {
    // `capabilities.effort_levels` promises weakest→strongest; the vendor listing
    // its strongest model first must not invert the published ladder.
    const capability: CodexEffortCapability = {
      "gpt-strong": { levels: ["ultra", "max"], default: "max" },
      "gpt-weak": { levels: ["low", "medium"], default: "low" },
    };
    expect(unionEffortLevels(capability)).toEqual(["low", "medium", "max", "ultra"]);
  });

  it("keeps unranked vendor levels at the tail (the Swift EffortRanking tail rule)", () => {
    const capability: CodexEffortCapability = {
      "gpt-9": { levels: ["zesty", "high", "hyperdrive", "low"], default: "low" },
    };
    expect(unionEffortLevels(capability)).toEqual(["low", "high", "hyperdrive", "zesty"]);
  });
});

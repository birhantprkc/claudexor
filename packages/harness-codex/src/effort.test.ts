import { describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessRunSpec } from "@claudexor/schema";
import { effortLevelsForModel } from "@claudexor/schema";
import { resolveEffort } from "@claudexor/core";
import { clearCodexEffortCache, createCodexAdapter } from "./index.js";
import { codexExecArgs } from "./index.js";
import {
  CODEX_EFFORT_SNAPSHOT,
  codexEffortCacheSize,
  codexEffortCapability,
  codexEffortsForEnv,
  probeCodexEfforts,
  readModelListEfforts,
  unionEffortLevels,
  type CodexEffortCapability,
} from "./effort-probe.js";
import { rmSync as __rmSyncReap } from "node:fs";
import { afterAll as __afterAllReap } from "vitest";

// W-h: reap every temp dir this suite creates so the gate stops leaking tmpdirs.
const __reapDirs: string[] = [];
function reapMk(...args: Parameters<typeof mkdtempSync>): string {
  const dir = mkdtempSync(...args);
  __reapDirs.push(dir);
  return dir;
}
__afterAllReap(() => {
  for (const dir of __reapDirs.splice(0)) __rmSyncReap(dir, { recursive: true, force: true });
});

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
    // The merged codex ladder places ultra above xhigh (sol's own advertised
    // order), so it clamps onto gpt-5.4's real ceiling instead of being
    // forwarded to die as an opaque vendor `unsupported_value`.
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

  it("passes a level this repo has never heard of straight through when the model advertises it", () => {
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

  it("returns null — and raises NO unhandled error — when the child dies mid-handshake", async () => {
    // The regression: a broken pipe is delivered on the stream's `error` event,
    // NOT thrown out of `write()`, so the probe's try/catch could not see it and
    // the EPIPE escaped as an UNCAUGHT EXCEPTION that failed the whole test run.
    // This stub accepts the `initialize` frame and exits immediately, so the two
    // follow-up frames are written into a pipe with no reader left — the exact
    // shape that appears wherever codex is absent or refuses to serve.
    const dir = reapMk(join(tmpdir(), "claudexor-codex-dies-"));
    const bin = join(dir, "codex");
    writeFileSync(bin, '#!/bin/sh\nprintf \'{"jsonrpc":"2.0","id":1,"result":{}}\\n\'\nexit 0\n');
    chmodSync(bin, 0o755);

    const escaped: unknown[] = [];
    const collect = (error: unknown): void => void escaped.push(error);
    process.on("uncaughtException", collect);
    try {
      // Three rounds: the break lands in a short window between the child's exit
      // and node tearing the stream down, so repeating removes the last doubt
      // that a pass is just a lucky miss.
      for (let round = 0; round < 3; round += 1) {
        expect(await probeCodexEfforts(bin, { timeoutMs: 5_000 })).toBeNull();
      }
      // The EPIPE surfaces a tick after the write, so let the loop turn over
      // before judging: settling first and crashing second is the whole bug.
      await new Promise((resolve) => setTimeout(resolve, 250));
    } finally {
      process.off("uncaughtException", collect);
    }
    expect(escaped).toEqual([]);
  }, 30_000);

  it("keeps the live catalog when the app-server answers and exits IMMEDIATELY", async () => {
    // The regression: the probe settled on the child's `exit`, which fires when
    // the process is reaped and can beat the buffered stdout reaching the `data`
    // handler. A well-behaved app-server that answers `model/list` and exits at
    // once was then recorded as a FAILED probe, silently degrading a good live
    // catalog to the recorded snapshot. `close` waits for the stdio streams.
    const dir = reapMk(join(tmpdir(), "claudexor-codex-fast-"));
    const bin = join(dir, "codex");
    const answer =
      '{"jsonrpc":"2.0","id":2,"result":{"data":[' +
      '{"id":"gpt-9","defaultReasoningEffort":"high",' +
      '"supportedReasoningEfforts":[{"reasoningEffort":"low"},{"reasoningEffort":"high"}]}' +
      "]}}";
    // The stub accepts the handshake, hands the `model/list` answer to a writer
    // that INHERITS its stdout, and exits at once. `exit` therefore fires with the
    // answer still in flight — the hazard in its deterministic form.
    //
    // `exec 3<&0` first: POSIX sh points a background job's stdin at /dev/null,
    // which would drop the pipe's READ end the moment the parent exits and EPIPE
    // our follow-up frames, settling the probe through the stdin error path
    // instead. Holding a dup on fd 3 keeps this a pure exit-vs-output test; the
    // EPIPE shape has its own case above.
    writeFileSync(
      bin,
      `#!/bin/sh\nexec 3<&0\nprintf '{"jsonrpc":"2.0","id":1,"result":{}}\\n'\n` +
        `( sleep 0.3; printf '${answer}\\n' ) &\nexit 0\n`,
    );
    chmodSync(bin, 0o755);

    for (let round = 0; round < 3; round += 1) {
      const probed = await probeCodexEfforts(bin, { timeoutMs: 5_000 });
      expect(probed).not.toBeNull();
      expect(probed?.["gpt-9"]?.levels).toEqual(["low", "high"]);
      expect(probed?.["gpt-9"]?.default).toBe("high");
    }
  }, 30_000);

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

  it("stays bounded across repeated EPHEMERAL homes instead of leaking one entry per run", async () => {
    // The leak: an API-key route mints a fresh `mkdtemp` CODEX_HOME per run, so
    // every run inserts a key nothing will ever read again. Expiry cannot collect
    // them (it is only consulted on a later read of the SAME key), so in a
    // long-lived daemon the map grew for the life of the process.
    clearCodexEffortCache();
    const probe = async (): Promise<CodexEffortCapability> => ({
      "gpt-9": { levels: ["low", "high"], default: "high" },
    });
    // A FROZEN clock: nothing can expire, so only the entry cap can bound this.
    // Without it the map would hold all 500 keys.
    for (let run = 0; run < 500; run += 1) {
      await codexEffortCapability(probe, () => 0, "codex", {
        CODEX_HOME: `/tmp/claudexor-ephemeral-${run}`,
      });
    }
    expect(codexEffortCacheSize()).toBeLessThanOrEqual(64);
    clearCodexEffortCache();
    expect(codexEffortCacheSize()).toBe(0);
  });

  it("still serves a stable home from cache while ephemeral homes churn past it", async () => {
    clearCodexEffortCache();
    let calls = 0;
    const probe = async (): Promise<CodexEffortCapability> => {
      calls += 1;
      return { "gpt-9": { levels: ["low", "high"], default: "high" } };
    };
    const stable = { CODEX_HOME: "/tmp/claudexor-native-home" };
    await codexEffortCapability(probe, () => 0, "codex", stable);
    expect(calls).toBe(1);
    // Well inside the cap: the stable entry must survive ordinary churn.
    for (let run = 0; run < 10; run += 1) {
      await codexEffortCapability(probe, () => 0, "codex", {
        CODEX_HOME: `/tmp/claudexor-ephemeral-churn-${run}`,
      });
    }
    await codexEffortCapability(probe, () => 0, "codex", stable);
    expect(calls).toBe(11); // 1 stable + 10 ephemeral; the stable read was cached.
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

describe("the harness ladder is the positional MERGE of the vendor's own per-model orders", () => {
  it("merges subset lists into the longest vendor ladder (the real catalog shape)", () => {
    const capability: CodexEffortCapability = {
      "gpt-mid": { levels: ["low", "medium", "high", "xhigh"], default: "medium" },
      "gpt-top": { levels: ["low", "medium", "high", "xhigh", "max", "ultra"], default: "low" },
      "gpt-small": { levels: ["low", "medium"], default: "low" },
    };
    expect(unionEffortLevels(capability)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
  });

  it("a new vendor level ('hyper') sorts by its vendor POSITION and hosts clamps there", () => {
    // The generalization proof end to end: nothing in this repo knows `hyper`,
    // yet it merges between xhigh and max because that is where the vendor put
    // it — and a model that lacks it clamps a `hyper` request onto its own
    // ceiling along that merged order.
    const capability: CodexEffortCapability = {
      "gpt-hyper": { levels: ["low", "medium", "high", "xhigh", "hyper", "max"], default: "low" },
      "gpt-plain": { levels: ["low", "medium", "high", "xhigh"], default: "medium" },
    };
    expect(unionEffortLevels(capability)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "hyper",
      "max",
    ]);
    expect(
      emittedEffort(
        codexExecArgs(
          { ...base, model_hint: "gpt-hyper", effort_hint: "hyper" },
          { effortCapability: capability },
        ),
      ),
    ).toBe("hyper");
    expect(
      emittedEffort(
        codexExecArgs(
          { ...base, model_hint: "gpt-plain", effort_hint: "hyper" },
          { effortCapability: capability },
        ),
      ),
    ).toBe("xhigh");
  });

  it("REFUSES cross-model clamping when two vendor orders genuinely contradict each other", () => {
    // No vendor does this today. If one ever does, there is no honest merged
    // rank for the pair — so an unadvertised level sends NO flag (disclosed
    // upstream) instead of clamping along an order this repo would have had to
    // invent. Advertised levels still pass through verbatim.
    const capability: CodexEffortCapability = {
      "gpt-a": { levels: ["low", "high"], default: "low" },
      "gpt-b": { levels: ["high", "low"], default: "high" },
    };
    expect(
      emittedEffort(
        codexExecArgs(
          { ...base, model_hint: "gpt-a", effort_hint: "medium" },
          { effortCapability: capability },
        ),
      ),
    ).toBeNull();
    expect(
      emittedEffort(
        codexExecArgs(
          { ...base, model_hint: "gpt-a", effort_hint: "high" },
          { effortCapability: capability },
        ),
      ),
    ).toBe("high");
  });
});

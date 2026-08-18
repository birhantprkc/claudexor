import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ControlSettingsUpdateRequest, GlobalConfig } from "@claudexor/schema";
import type { GlobalConfig as GlobalConfigT } from "@claudexor/schema";
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

// HERMETIC codex stub: the adapter resolves its binary (CLAUDEXOR_CODEX_BIN)
// at MODULE LOAD, and codex discover() hard-requires `--version` to answer.
// Without this stub the suite silently depended on a real codex install —
// green on dev machines, red on CI runners. The manifest truth source
// (static known_models) is what these tests exercise; the stub only answers
// the liveness probes. Env is set BEFORE the dynamic import below so the
// adapter picks it up.
const stubDir = reapMk(join(tmpdir(), "claudexor-codex-stub-"));
const stubBin = join(stubDir, "codex");
writeFileSync(
  stubBin,
  '#!/bin/sh\ncase "$1" in\n  --version) echo "codex-cli 0.0.0-stub" ;;\n  *) exit 1 ;;\nesac\n',
);
chmodSync(stubBin, 0o755);
process.env["CLAUDEXOR_CODEX_BIN"] = stubBin;
const {
  applyHarnessSettingsPatches,
  assertSettingsPatchValid,
  assertRoutingGoalTiersConsistent,
  commitSettingsUpdate,
  mergeSettingsPatch,
} = await import("./settings-service.js");
const { loadConfig, updateGlobalConfig } = await import("@claudexor/config");

describe("interaction timeout patch presence", () => {
  it("keeps an omitted value but persists explicit null", () => {
    const finite = GlobalConfig.parse({ interaction_timeout_ms: 123_000 });
    expect(
      mergeSettingsPatch(finite, ControlSettingsUpdateRequest.parse({})).interaction_timeout_ms,
    ).toBe(123_000);
    expect(
      mergeSettingsPatch(finite, ControlSettingsUpdateRequest.parse({ interactionTimeoutMs: null }))
        .interaction_timeout_ms,
    ).toBeNull();

    const disabled = GlobalConfig.parse({ interaction_timeout_ms: null });
    expect(
      mergeSettingsPatch(disabled, ControlSettingsUpdateRequest.parse({})).interaction_timeout_ms,
    ).toBeNull();
  });
});

/** The daemon POST /settings validation core, tested offline
 * against the codex manifest truth source (static known_models). */
describe("assertSettingsPatchValid", () => {
  // `current` is REQUIRED now (a caller can no longer opt out of the D-9 fence);
  // an `auto` goal with no tiers never trips the invariant, so these patch-local
  // truth checks (harness ids / models / effort) reach their throw as before.
  // Empty stored harnesses = every per-harness default (null model, null effort).
  const AUTO_NO_TIERS = { goal: "auto" as const, qualityTiers: {}, harnesses: {} };

  /** Stored per-harness settings for codex, built through the real merge path. */
  const storedCodex = (settings: { defaultModel?: string | null; effort?: string | null }) =>
    applyHarnessSettingsPatches(
      {},
      ControlSettingsUpdateRequest.parse({ harnesses: { codex: settings } }).harnesses!,
    );
  const patchCodex = (settings: Record<string, unknown>) =>
    ControlSettingsUpdateRequest.parse({ harnesses: { codex: settings } });

  it("rejects fake harness ids everywhere they could persist", async () => {
    await expect(
      assertSettingsPatchValid(
        ControlSettingsUpdateRequest.parse({ primaryHarness: "fake-success" }),
        AUTO_NO_TIERS,
      ),
    ).rejects.toThrow(/not a real registered harness/);
    await expect(
      assertSettingsPatchValid(
        ControlSettingsUpdateRequest.parse({ eligibleHarnesses: ["codex", "fake-implement"] }),
        AUTO_NO_TIERS,
      ),
    ).rejects.toThrow(/not a real registered harness/);
    await expect(
      assertSettingsPatchValid(
        ControlSettingsUpdateRequest.parse({
          harnesses: { "fake-success": { defaultModel: "fake-model" } },
        }),
        AUTO_NO_TIERS,
      ),
    ).rejects.toThrow(/not persistable/);
  });

  it("refuses a model outside the harness truth source with the actionable message (HTTP 400 path)", async () => {
    await expect(
      assertSettingsPatchValid(
        ControlSettingsUpdateRequest.parse({
          harnesses: { codex: { defaultModel: "ghost-model-9000" } },
        }),
        AUTO_NO_TIERS,
      ),
    ).rejects.toThrow(/refused defaultModel 'ghost-model-9000'.*truth source: manifest/s);
    // A truth-listed model passes.
    await expect(
      assertSettingsPatchValid(
        ControlSettingsUpdateRequest.parse({ harnesses: { codex: { defaultModel: "gpt-5.5" } } }),
        AUTO_NO_TIERS,
      ),
    ).resolves.toBeDefined();
  }, 30_000); // codex discover() spawns the vendor CLI; its startup latency is environmental

  it("refuses an effort outside the declared ladder", async () => {
    // raw-api discovers without a vendor binary and declares NO effort ladder;
    // its discover() only checks key PRESENCE, so a dummy keeps this hermetic.
    const prev = process.env["OPENAI_API_KEY"];
    process.env["OPENAI_API_KEY"] = "sk-test-canary-dummy";
    try {
      await expect(
        assertSettingsPatchValid(
          ControlSettingsUpdateRequest.parse({ harnesses: { "raw-api": { effort: "high" } } }),
          AUTO_NO_TIERS,
        ),
      ).rejects.toThrow(/declares no effort ladder/);
    } finally {
      if (prev === undefined) delete process.env["OPENAI_API_KEY"];
      else process.env["OPENAI_API_KEY"] = prev;
    }
  });

  // INV-104 pairing: the effort ladder belongs to the MODEL, and a settings write
  // may carry either half of the pair alone — so only the MERGED pair can be
  // judged. The codex manifest (snapshot fallback under the stub) gives the
  // asymmetry these need: gpt-5.5 stops at `xhigh` while the harness-wide union
  // reaches `ultra` because gpt-5.6-sol advertises it.
  // One `it` per patch shape, so a regression names the shape it broke instead of
  // stopping at whichever assertion happened to come first.
  // codex discover() spawns the (stubbed) vendor CLI, so each gets the same
  // environmental-latency budget as the other manifest-backed cases.
  it("shape 1: effort-only patch refused when the STORED model's ladder is narrower", async () => {
    // `ultra` IS on the harness-wide union, so judging the patch against the union
    // (or against a null model, which is what an absent patch.defaultModel means)
    // accepted a value gpt-5.5 rejects.
    await expect(
      assertSettingsPatchValid(patchCodex({ effort: "ultra" }), {
        ...AUTO_NO_TIERS,
        harnesses: storedCodex({ defaultModel: "gpt-5.5" }),
      }),
    ).rejects.toThrow(/harness 'codex' model 'gpt-5\.5' does not accept effort 'ultra'/);
  }, 30_000);

  it("shape 2: effort-only patch accepted when it is inside the STORED model's ladder", async () => {
    await expect(
      assertSettingsPatchValid(patchCodex({ effort: "xhigh" }), {
        ...AUTO_NO_TIERS,
        harnesses: storedCodex({ defaultModel: "gpt-5.5" }),
      }),
    ).resolves.toBeDefined();
  }, 30_000);

  it("shape 3: defaultModel-only patch refused when the STORED effort is unsupported", async () => {
    // The patch carries no effort at all, so effort validation used to be skipped
    // entirely and the stored `ultra` silently became unsupported for the new model.
    await expect(
      assertSettingsPatchValid(patchCodex({ defaultModel: "gpt-5.5" }), {
        ...AUTO_NO_TIERS,
        harnesses: storedCodex({ defaultModel: "gpt-5.6-sol", effort: "ultra" }),
      }),
    ).rejects.toThrow(/harness 'codex' model 'gpt-5\.5' does not accept effort 'ultra'/);
    // …and the same patch is fine once the stored effort fits the new model.
    await expect(
      assertSettingsPatchValid(patchCodex({ defaultModel: "gpt-5.5" }), {
        ...AUTO_NO_TIERS,
        harnesses: storedCodex({ defaultModel: "gpt-5.6-sol", effort: "high" }),
      }),
    ).resolves.toBeDefined();
  }, 30_000);

  it("shape 4: both-fields patch behaves as before — the patch pair wins over stored", async () => {
    await expect(
      assertSettingsPatchValid(patchCodex({ defaultModel: "gpt-5.6-sol", effort: "ultra" }), {
        ...AUTO_NO_TIERS,
        harnesses: storedCodex({ defaultModel: "gpt-5.5", effort: "xhigh" }),
      }),
    ).resolves.toBeDefined();
    await expect(
      assertSettingsPatchValid(patchCodex({ defaultModel: "gpt-5.5", effort: "ultra" }), {
        ...AUTO_NO_TIERS,
        harnesses: storedCodex({ defaultModel: "gpt-5.6-sol", effort: "ultra" }),
      }),
    ).rejects.toThrow(/harness 'codex' model 'gpt-5\.5' does not accept effort 'ultra'/);
  }, 30_000);

  it("an effective model the manifest records no ladder for keeps the harness-wide union", async () => {
    // Deliberately NOT a hard refusal: `effortLevelsForModel` falls back to the
    // union for a model with no recorded per-model vocabulary, and the pair check
    // must stay consistent with that owner rather than inventing a stricter rule.
    // `gpt-5.6` is a known model with no snapshot entry; a stale stored id that
    // left `known_models` entirely takes the same path, so a vendor retiring a
    // model can never turn an unrelated effort write into a 400.
    for (const defaultModel of ["gpt-5.6", "retired-model-from-a-past-release"]) {
      await expect(
        assertSettingsPatchValid(patchCodex({ effort: "ultra" }), {
          ...AUTO_NO_TIERS,
          harnesses: storedCodex({ defaultModel }),
        }),
      ).resolves.toBeDefined();
    }
    // A null effective model (nothing stored, nothing patched) keeps the union too.
    await expect(
      assertSettingsPatchValid(patchCodex({ effort: "ultra" }), AUTO_NO_TIERS),
    ).resolves.toBeDefined();
  }, 30_000);

  it("leaves a harness alone when the write touches neither half of the pair", async () => {
    // A stored pair can go stale on its own (a vendor narrows a ladder under a
    // value saved long ago). An unrelated write must not become a hard refusal
    // for it — this validates settings honesty, it does not audit stored drift.
    await expect(
      assertSettingsPatchValid(patchCodex({ enabled: false }), {
        ...AUTO_NO_TIERS,
        harnesses: storedCodex({ defaultModel: "gpt-5.5", effort: "ultra" }),
      }),
    ).resolves.toBeDefined();
    // Clearing the effort while narrowing the model is also fine: the effective
    // effort is null, so there is no pair left to violate.
    await expect(
      assertSettingsPatchValid(patchCodex({ defaultModel: "gpt-5.5", effort: null }), {
        ...AUTO_NO_TIERS,
        harnesses: storedCodex({ defaultModel: "gpt-5.6-sol", effort: "ultra" }),
      }),
    ).resolves.toBeDefined();
  }, 30_000);

  it("D-9/#22: merged-effective quality routing with zero tiers is a 4xx config_error at write", async () => {
    const emptyTiers = ControlSettingsUpdateRequest.parse({}).qualityTiers ?? {};
    // (a) Patch flips the goal to quality over empty stored tiers → refused.
    await expect(
      assertSettingsPatchValid(ControlSettingsUpdateRequest.parse({ routingGoal: "quality" }), {
        goal: "auto",
        qualityTiers: emptyTiers,
        harnesses: {},
      }),
    ).rejects.toMatchObject({ status: 400, code: "config_error" });
    // (b) Clearing the tiers while quality is already active → refused.
    const oneTier = ControlSettingsUpdateRequest.parse({
      qualityTiers: { implement: [[{ harness: "codex", model: "gpt-5.5", effort: "high" }]] },
    }).qualityTiers!;
    await expect(
      assertSettingsPatchValid(ControlSettingsUpdateRequest.parse({ qualityTiers: {} }), {
        goal: "quality",
        qualityTiers: oneTier,
        harnesses: {},
      }),
    ).rejects.toMatchObject({ status: 400, code: "config_error" });
    // (c) A valid tier set with a quality goal is accepted.
    await expect(
      assertSettingsPatchValid(
        ControlSettingsUpdateRequest.parse({
          routingGoal: "quality",
          qualityTiers: { implement: [[{ harness: "codex", model: "gpt-5.5", effort: "high" }]] },
        }),
        { goal: "auto", qualityTiers: emptyTiers, harnesses: {} },
      ),
    ).resolves.toBeDefined();
    // (d) The stored tiers carry the goal even when the patch omits them.
    await expect(
      assertSettingsPatchValid(ControlSettingsUpdateRequest.parse({ routingGoal: "quality" }), {
        goal: "auto",
        qualityTiers: oneTier,
        harnesses: {},
      }),
    ).resolves.toBeDefined();
  }, 30_000); // codex discover() spawns the vendor CLI to validate the tier route

  it("assertRoutingGoalTiersConsistent discriminates the unroutable quality/zero-tier combo", () => {
    const oneTier = ControlSettingsUpdateRequest.parse({
      qualityTiers: { implement: [[{ harness: "codex", model: "gpt-5.5", effort: "high" }]] },
    }).qualityTiers!;
    const emptyTiers = ControlSettingsUpdateRequest.parse({}).qualityTiers ?? {};
    expect(() => assertRoutingGoalTiersConsistent("quality", emptyTiers)).toThrow(
      /quality routing requires at least one configured quality tier/,
    );
    expect(() => assertRoutingGoalTiersConsistent("quality", oneTier)).not.toThrow();
    expect(() => assertRoutingGoalTiersConsistent("auto", emptyTiers)).not.toThrow();
  });

  it("rejects the retired Active-account patch key at the strict schema (F1: Active removed)", () => {
    // The Active account concept is gone: the per-harness patch no longer
    // accepts activeProfileId, so a strict parse 400s rather than persisting it.
    expect(() =>
      ControlSettingsUpdateRequest.parse({
        harnesses: { codex: { activeProfileId: "ghost-account" } },
      }),
    ).toThrow();
  });
});

describe("applyHarnessSettingsPatches", () => {
  it("merges real-harness patches and rejects unknown/fake ids", () => {
    const merged = applyHarnessSettingsPatches(
      {},
      {
        codex: ControlSettingsUpdateRequest.parse({ harnesses: { codex: { enabled: false } } })
          .harnesses!["codex"]!,
      },
    );
    expect(merged["codex"]?.enabled).toBe(false);
    expect(() => applyHarnessSettingsPatches({}, { "fake-success": { enabled: false } })).toThrow(
      /unknown harness id 'fake-success'/,
    );
  });
});

describe("profileLimitAction (INV-135 auto-switch toggle)", () => {
  it("patches only profile_policy.limit_action and preserves rotation order + headroom", () => {
    const current = {
      codex: {
        ...applyHarnessSettingsPatches({}, { codex: { enabled: true } })["codex"]!,
        profile_policy: {
          limit_action: "fail" as const,
          rotation_eligible: ["work", "personal"],
          headroom_threshold: 0.8,
        },
      },
    };
    const merged = applyHarnessSettingsPatches(current, {
      codex: ControlSettingsUpdateRequest.parse({
        harnesses: { codex: { profileLimitAction: "rotate" } },
      }).harnesses!["codex"]!,
    });
    expect(merged["codex"]?.profile_policy).toEqual({
      limit_action: "rotate",
      rotation_eligible: ["work", "personal"],
      headroom_threshold: 0.8,
    });
    // Absent field keeps the stored action untouched.
    const untouched = applyHarnessSettingsPatches(merged, {
      codex: ControlSettingsUpdateRequest.parse({
        harnesses: { codex: { enabled: false } },
      }).harnesses!["codex"]!,
    });
    expect(untouched["codex"]?.profile_policy.limit_action).toBe("rotate");
  });

  it("the wire accepts 'auto' (the A6 tri-state control's middle position) and it lands verbatim", () => {
    const current = {
      codex: {
        ...applyHarnessSettingsPatches({}, { codex: { enabled: true } })["codex"]!,
        profile_policy: {
          limit_action: "rotate" as const,
          rotation_eligible: ["work"],
          headroom_threshold: 0.8,
        },
      },
    };
    const merged = applyHarnessSettingsPatches(current, {
      codex: ControlSettingsUpdateRequest.parse({
        harnesses: { codex: { profileLimitAction: "auto" } },
      }).harnesses!["codex"]!,
    });
    expect(merged["codex"]?.profile_policy).toEqual({
      limit_action: "auto",
      rotation_eligible: ["work"],
      headroom_threshold: 0.8,
    });
  });

  it("an EXPLICITLY persisted fail survives unrelated patches — A6 never reinterprets stored values (3=A)", () => {
    const current = {
      codex: {
        ...applyHarnessSettingsPatches({}, { codex: { enabled: true } })["codex"]!,
        profile_policy: {
          limit_action: "fail" as const,
          rotation_eligible: [],
          headroom_threshold: 0.9,
        },
      },
    };
    const merged = applyHarnessSettingsPatches(current, {
      codex: ControlSettingsUpdateRequest.parse({
        harnesses: { codex: { enabled: false } },
      }).harnesses!["codex"]!,
    });
    expect(merged["codex"]?.profile_policy.limit_action).toBe("fail");
  });
});

describe("commitSettingsUpdate atomic validate+write (A-1 TOCTOU race)", () => {
  const oneTierPatch = () =>
    ControlSettingsUpdateRequest.parse({
      qualityTiers: { implement: [[{ harness: "codex", model: "gpt-5.5", effort: "high" }]] },
    });

  /** Run `fn` against a FRESH isolated config dir seeded with `seedRouting`
   * (and, optionally, a stored per-harness model/effort pair). */
  async function withSeededConfig(
    seedRouting: {
      goal: "auto" | "economy" | "quality";
      qualityTiers: unknown;
      harnesses?: GlobalConfigT["harnesses"];
    },
    fn: (root: string) => Promise<void>,
  ): Promise<void> {
    const prev = process.env.CLAUDEXOR_CONFIG_DIR;
    const dir = reapMk(join(tmpdir(), "claudexor-settings-race-"));
    process.env.CLAUDEXOR_CONFIG_DIR = dir;
    try {
      updateGlobalConfig((cfg) => ({
        ...cfg,
        harnesses: seedRouting.harnesses ?? cfg.harnesses,
        routing: {
          ...cfg.routing,
          goal: seedRouting.goal,
          quality_tiers: seedRouting.qualityTiers as typeof cfg.routing.quality_tiers,
        },
      }));
      // The repo root only supplies (absent) project config; global config lives
      // in the isolated dir above.
      await fn(dir);
    } finally {
      if (prev === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = prev;
    }
  }

  it("two concurrent writes can never persist quality-with-zero-tiers", async () => {
    await withSeededConfig(
      { goal: "auto", qualityTiers: oneTierPatch().qualityTiers },
      async (root) => {
        // A flips the goal to quality (valid against the seed: the tier is still
        // present). B clears the tiers (valid against the seed: the goal is still
        // auto). Fired together, B validates the STALE auto snapshot but commits
        // AFTER A — the exact A-1 interleaving. Before the fix this persisted
        // quality-with-zero-tiers; the under-lock re-validation now refuses it.
        const results = await Promise.allSettled([
          commitSettingsUpdate(
            root,
            ControlSettingsUpdateRequest.parse({ routingGoal: "quality" }),
          ),
          commitSettingsUpdate(root, ControlSettingsUpdateRequest.parse({ qualityTiers: {} })),
        ]);
        const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
        // Exactly one writer is refused — the one whose commit would have left the
        // invalid final combination — with the typed config_error.
        expect(rejected).toHaveLength(1);
        expect(rejected[0]!.reason).toMatchObject({ status: 400, code: "config_error" });
        // The persisted config is ALWAYS a valid combination.
        const final = loadConfig(root).global.routing;
        const tierCount = Object.values(final.quality_tiers).reduce(
          (n, list) => n + (list?.length ?? 0),
          0,
        );
        expect(final.goal === "quality" && tierCount === 0).toBe(false);
      },
    );
  });

  it("a lone valid write still persists (fix does not over-refuse)", async () => {
    // Seed already carries a tier, so flipping the goal to quality is valid and
    // must persist — the atomic re-check must not reject a legitimate write.
    await withSeededConfig(
      { goal: "auto", qualityTiers: oneTierPatch().qualityTiers },
      async (root) => {
        await commitSettingsUpdate(
          root,
          ControlSettingsUpdateRequest.parse({ routingGoal: "quality" }),
        );
        const final = loadConfig(root).global.routing;
        expect(final.goal).toBe("quality");
        expect(Object.keys(final.quality_tiers)).toContain("implement");
      },
    );
  });

  it("an effort-only write is judged against the PERSISTED default model", async () => {
    // End-to-end proof that the stored per-harness settings actually reach the
    // validator: a unit test on `assertSettingsPatchValid` alone would still pass
    // if `commitSettingsUpdate` handed it an empty harnesses map.
    await withSeededConfig(
      { goal: "auto", qualityTiers: oneTierPatch().qualityTiers },
      async (root) => {
        await commitSettingsUpdate(
          root,
          ControlSettingsUpdateRequest.parse({ harnesses: { codex: { defaultModel: "gpt-5.5" } } }),
        );
        expect(loadConfig(root).global.harnesses["codex"]?.default_model).toBe("gpt-5.5");
        // gpt-5.5 stops at xhigh; `ultra` only exists on the harness-wide union.
        await expect(
          commitSettingsUpdate(
            root,
            ControlSettingsUpdateRequest.parse({ harnesses: { codex: { effort: "ultra" } } }),
          ),
        ).rejects.toThrow(/model 'gpt-5\.5' does not accept effort 'ultra'/);
        expect(loadConfig(root).global.harnesses["codex"]?.effort).toBeNull();
        // The same write against a model that advertises `ultra` persists.
        await commitSettingsUpdate(
          root,
          ControlSettingsUpdateRequest.parse({
            harnesses: { codex: { defaultModel: "gpt-5.6-sol", effort: "ultra" } },
          }),
        );
        expect(loadConfig(root).global.harnesses["codex"]?.effort).toBe("ultra");
      },
    );
  }, 30_000); // codex discover() spawns the vendor CLI; its startup latency is environmental

  it("two concurrent writes can never persist a stranded model/effort pair", async () => {
    // The pair is merged-effective too, so it needs the SAME under-lock re-check the
    // goal/tiers invariant gets. A narrows the model (valid against the seed: the
    // stored `high` is fine for gpt-5.5); B raises the effort (valid against the
    // seed: gpt-5.6-sol accepts `ultra`). Committed in either order the final pair
    // would be (gpt-5.5, ultra), which gpt-5.5 rejects.
    await withSeededConfig(
      {
        goal: "auto",
        qualityTiers: oneTierPatch().qualityTiers,
        harnesses: applyHarnessSettingsPatches(
          {},
          ControlSettingsUpdateRequest.parse({
            harnesses: { codex: { defaultModel: "gpt-5.6-sol", effort: "high" } },
          }).harnesses!,
        ),
      },
      async (root) => {
        const results = await Promise.allSettled([
          commitSettingsUpdate(
            root,
            ControlSettingsUpdateRequest.parse({
              harnesses: { codex: { defaultModel: "gpt-5.5" } },
            }),
          ),
          commitSettingsUpdate(
            root,
            ControlSettingsUpdateRequest.parse({ harnesses: { codex: { effort: "ultra" } } }),
          ),
        ]);
        expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
        // Whichever writer landed second is refused, so the persisted pair is
        // always one the model actually accepts.
        const stored = loadConfig(root).global.harnesses["codex"];
        expect(stored?.default_model === "gpt-5.5" && stored?.effort === "ultra").toBe(false);
      },
    );
  }, 30_000);
});

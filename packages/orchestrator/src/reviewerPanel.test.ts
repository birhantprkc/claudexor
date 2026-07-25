import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { HarnessAdapter } from "@claudexor/core";
import { HarnessUnavailableError } from "@claudexor/core";
import { ConformanceReport, HarnessManifest, type ProviderFamily } from "@claudexor/schema";
import { resolveAutoReviewerPanel, resolveExplicitReviewerPanel } from "./reviewerPanel.js";

/**
 * The reviewer effort gate. `reviewerEfforts` and `reviewerPanel[].effort` are
 * OPEN slugs on the wire (a level only means something per harness+model), so the
 * boundary can only refuse a malformed shape. These pin the layer that refuses an
 * unsupported LEVEL: without it an unadvertised effort is dropped by the adapter's
 * normalizer while the review artifact still records it as requested.
 */
function reviewerAdapter(
  id: string,
  family: ProviderFamily,
  effortLevels: readonly string[],
  extras: {
    modelEffortLevels?: Record<string, { levels: string[]; default: string | null }>;
    knownModels?: string[];
  } = {},
): HarnessAdapter {
  return {
    id,
    async discover() {
      return HarnessManifest.parse({
        id,
        display_name: id,
        kind: "local_cli",
        provider_family: family,
        access_profiles_supported: ["readonly", "workspace_write"],
        capabilities: {
          review: true,
          effort_levels: [...effortLevels],
          ...(extras.modelEffortLevels ? { model_effort_levels: extras.modelEffortLevels } : {}),
          ...(extras.knownModels ? { known_models: extras.knownModels } : {}),
        },
      });
    },
    async doctor() {
      return ConformanceReport.parse({ harness_id: id, status: "ok", enabled_intents: ["review"] });
    },
    // eslint-disable-next-line require-yield
    async *run() {
      throw new Error("not used in panel resolution");
    },
  };
}

const deps = (adapters: HarnessAdapter[]) => ({
  cwd: mkdtempSync(join(tmpdir(), "clawdexor-panel-")),
  registry: new Map(adapters.map((a) => [a.id, a])),
  harnessSettings: {},
  authPreferenceFor: () => "auto" as const,
});

describe("reviewer effort gate", () => {
  const claude = () => reviewerAdapter("claude", "anthropic", ["low", "medium", "high", "max"]);
  const cursor = () => reviewerAdapter("cursor", "cursor", ["low", "medium", "high"]);

  it("refuses a legacy reviewerEfforts level the auto-selected reviewer does not advertise", async () => {
    // The hole this closes: `reviewerEfforts` was an enum on the wire, so a typo
    // was a 400. With an open vocabulary the boundary cannot judge the level, and
    // the auto panel forwarded it unchecked.
    await expect(
      resolveAutoReviewerPanel(deps([claude()]), { reviewerEfforts: { anthropic: "banana" } }),
    ).rejects.toThrow(HarnessUnavailableError);

    await expect(
      resolveAutoReviewerPanel(deps([claude()]), { reviewerEfforts: { anthropic: "banana" } }),
    ).rejects.toThrow(
      /does not support requested effort 'banana'.*harness-wide advertised ladder.*low, medium, high, max/,
    );
  });

  it("refuses a well-known vendor level this reviewer's ladder does not advertise", async () => {
    // `ultra` is real elsewhere (codex sol models), just not on this reviewer's
    // advertised ladder. Silently dropping it is the exact failure the gate
    // exists to prevent.
    await expect(
      resolveAutoReviewerPanel(deps([claude()]), { reviewerEfforts: { anthropic: "ultra" } }),
    ).rejects.toThrow(/does not support requested effort 'ultra'/);
  });

  it("accepts a legacy reviewer effort the reviewer advertises", async () => {
    const specs = await resolveAutoReviewerPanel(deps([claude()]), {
      reviewerEfforts: { anthropic: "max" },
    });
    expect(specs).toHaveLength(1);
    expect(specs[0]?.requestedEffort).toBe("max");
  });

  it("leaves the reviewer effort unset when no override was given", async () => {
    const specs = await resolveAutoReviewerPanel(deps([claude()]), {});
    expect(specs[0]?.requestedEffort).toBeNull();
  });

  it("refuses an explicit reviewerPanel effort the reviewer does not advertise", async () => {
    await expect(
      resolveExplicitReviewerPanel(deps([cursor()]), [{ harness: "cursor", effort: "turbo" }]),
    ).rejects.toThrow(
      /does not support requested effort 'turbo'.*harness-wide advertised ladder.*low, medium, high/,
    );
  });

  it("accepts an explicit reviewerPanel effort the reviewer advertises", async () => {
    const specs = await resolveExplicitReviewerPanel(deps([cursor()]), [
      { harness: "cursor", effort: "high" },
    ]);
    expect(specs).toHaveLength(1);
    expect(specs[0]?.requestedEffort).toBe("high");
  });

  it("refuses any reviewer effort when the harness declares no effort controls", async () => {
    const bare = reviewerAdapter("bare", "openai", []);
    await expect(
      resolveExplicitReviewerPanel(deps([bare]), [{ harness: "bare", effort: "high" }]),
    ).rejects.toThrow(/harness declares no effort controls/);
  });

  it("validates a MODEL-naming entry against THAT model's advertised ladder, not the union", async () => {
    // The union carries `ultra` (a sibling model advertises it); the named
    // reviewer model stops at `high`. The gate must speak for the model that
    // will actually review.
    const codexish = () =>
      reviewerAdapter("codexish", "openai", ["low", "medium", "high", "ultra"], {
        knownModels: ["m-small", "m-big"],
        modelEffortLevels: {
          "m-small": { levels: ["low", "medium", "high"], default: "medium" },
          "m-big": { levels: ["low", "medium", "high", "ultra"], default: "low" },
        },
      });
    await expect(
      resolveExplicitReviewerPanel(deps([codexish()]), [
        { harness: "codexish", model: "m-small", effort: "ultra" },
      ]),
    ).rejects.toThrow(
      /does not support requested effort 'ultra'.*model 'm-small' advertises: low, medium, high/,
    );
    // The SAME level on the model that advertises it passes.
    const specs = await resolveExplicitReviewerPanel(deps([codexish()]), [
      { harness: "codexish", model: "m-big", effort: "ultra" },
    ]);
    expect(specs[0]?.requestedEffort).toBe("ultra");
  });

  it("falls back to the harness ladder (and says so) for a model with no recorded ladder", async () => {
    const codexish = () =>
      reviewerAdapter("codexish", "openai", ["low", "medium", "high"], {
        knownModels: ["m-new"],
      });
    await expect(
      resolveExplicitReviewerPanel(deps([codexish()]), [
        { harness: "codexish", model: "m-new", effort: "ultra" },
      ]),
    ).rejects.toThrow(/harness-wide advertised ladder — no per-model ladder recorded for 'm-new'/);
  });
});

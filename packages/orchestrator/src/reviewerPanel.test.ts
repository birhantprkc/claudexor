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
        capabilities: { review: true, effort_levels: [...effortLevels] },
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
      /does not support requested effort 'banana'.*supported: low, medium, high, max/,
    );
  });

  it("refuses a rankable-but-unadvertised legacy reviewer effort too", async () => {
    // `ultra` is a real rank-table level, just not one this reviewer advertises.
    // Silently dropping it is the exact failure the gate exists to prevent.
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
    ).rejects.toThrow(/does not support requested effort 'turbo'.*supported: low, medium, high/);
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
});

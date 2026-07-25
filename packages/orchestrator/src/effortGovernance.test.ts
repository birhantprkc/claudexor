import { describe, expect, it } from "vitest";
import { normalizeEffort } from "@claudexor/core";
import {
  type ModelEffortCapability,
  effortLevelsForModel,
  mergeEffortLadders,
} from "@claudexor/schema";
import { governRouteEffort } from "./effortGovernance.js";

/**
 * The layering contract: governance answers ONLY "does the harness's merged
 * advertised ladder know this level at all?" and discloses when it does not;
 * the adapter — which has resolved the profile env and the routed model — is
 * the single layer that clamps, and only inside the vendor's own merged order.
 */
describe("governRouteEffort", () => {
  const route = {
    id: "codex",
    // The default account's merged ladder, exactly as the manifest carries it:
    // the positional merge of every model's vendor-ordered list.
    effortLevels: ["low", "medium", "high", "xhigh", "max", "ultra"] as const,
  };

  /**
   * Exactly what the codex adapter does with `spec.effort_hint` (`codexEffortFor`
   * = this composition) once it has resolved the PROFILE's catalog for the env the
   * child will run in. Reproduced here rather than imported because harness-codex
   * is not an orchestrator dependency; the shared normalizer is the same owner.
   */
  const adapterResolves = (
    catalog: Record<string, ModelEffortCapability>,
    model: string,
    hint: string | null,
  ): string | null => {
    const merged = mergeEffortLadders(Object.values(catalog).map((entry) => entry.levels));
    const advertised = effortLevelsForModel(
      { effort_levels: merged.order, model_effort_levels: catalog },
      model,
    );
    return normalizeEffort(hint, advertised, merged.consistent ? merged.order : advertised);
  };

  it("forwards a ladder-known level VERBATIM; the profile-resolved adapter places it", () => {
    // `ultra` is on the merged ladder, so governance must not clamp it — the
    // manifest describes the DEFAULT account, while the run may execute under a
    // credential profile whose CODEX_HOME advertises its own catalog.
    const governed = governRouteEffort("ultra", route);
    expect(governed.effort).toBe("ultra");
    expect(governed.ignored).toBeNull();

    const profileCatalog = {
      "gpt-5.6-sol": {
        levels: ["low", "medium", "high", "xhigh", "max", "ultra"],
        default: "low",
      },
      "gpt-5.4": { levels: ["low", "medium", "high", "xhigh"], default: "medium" },
    };
    // On the model that advertises it: verbatim.
    expect(adapterResolves(profileCatalog, "gpt-5.6-sol", governed.effort)).toBe("ultra");
    // On the sibling that stops lower: clamped INSIDE the merged vendor order,
    // by the one layer that actually knows the profile's catalog.
    expect(adapterResolves(profileCatalog, "gpt-5.4", governed.effort)).toBe("xhigh");
  });

  it("forwards an advertised level verbatim", () => {
    expect(governRouteEffort("high", route)).toEqual({ effort: "high", ignored: null });
  });

  it("discloses a level the merged ladder has never seen, naming the ladder", () => {
    const governed = governRouteEffort("banana", route);
    expect(governed.effort).toBeNull();
    expect(governed.ignored).toContain("effort=banana");
    expect(governed.ignored).toContain("codex");
    expect(governed.ignored).toContain("low, medium, high, xhigh, max, ultra");
  });

  it("never clamps: refusal is pure ladder membership, with nothing left to rank against", () => {
    // A ladder capped at xhigh does not know `ultra`, so the request is
    // disclosed rather than silently landed on some "nearest" level — with the
    // rank table gone there is no order here to invent one from.
    const governed = governRouteEffort("ultra", {
      id: "codex",
      effortLevels: ["low", "medium", "high", "xhigh"],
    });
    expect(governed.effort).toBeNull();
    expect(governed.ignored).toContain("effort=ultra");
  });

  it("discloses when the harness has no effort surface at all", () => {
    const governed = governRouteEffort("high", { id: "fake", effortLevels: [] });
    expect(governed.effort).toBeNull();
    expect(governed.ignored).toContain("capabilities.effort_levels is empty");
  });

  it("sends no flag and discloses nothing when nothing was requested", () => {
    expect(governRouteEffort(null, route)).toEqual({ effort: null, ignored: null });
  });
});

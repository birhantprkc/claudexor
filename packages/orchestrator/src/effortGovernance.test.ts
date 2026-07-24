import { describe, expect, it } from "vitest";
import { normalizeEffort } from "@claudexor/core";
import { type ModelEffortCapability, effortLevelsForModel } from "@claudexor/schema";
import { governRouteEffort } from "./effortGovernance.js";

/**
 * The manifest this gate reads is discovered against the DEFAULT native harness
 * home, while the run itself may execute under a credential profile with its own
 * `CODEX_HOME` and therefore its own per-model ladders. These pin the split:
 * governance discloses, the profile-resolved adapter clamps.
 */
describe("governRouteEffort", () => {
  const route = {
    id: "codex",
    // The DEFAULT account's catalog, as `discover()` recorded it: capped at `xhigh`.
    effortLevels: ["low", "medium", "high", "xhigh"] as const,
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
  ): string | null =>
    normalizeEffort(
      hint,
      effortLevelsForModel(
        {
          effort_levels: Object.values(catalog).flatMap((e) => e.levels),
          model_effort_levels: catalog,
        },
        model,
      ),
    );

  it("does not clamp a profile-scoped run against the default account's ladder", () => {
    // The default account's manifest says this model tops out at `xhigh`, but the
    // run is routed to a credential profile whose CODEX_HOME advertises `ultra`.
    const governed = governRouteEffort("ultra", route);

    // Governance must forward the request UNTOUCHED. Clamping to `xhigh` here
    // would be authoritative downstream — an advertised level passes through the
    // adapter verbatim — permanently costing the profile a level it really has.
    expect(governed.effort).toBe("ultra");
    expect(governed.ignored).toBeNull();

    const profileCatalog = {
      "gpt-5.6-sol": {
        levels: ["low", "medium", "high", "xhigh", "max", "ultra"],
        default: "low",
      },
    };
    expect(adapterResolves(profileCatalog, "gpt-5.6-sol", governed.effort)).toBe("ultra");
  });

  it("still lets the adapter clamp when the profile really does stop lower", () => {
    const governed = governRouteEffort("ultra", route);
    const profileCatalog = {
      "gpt-5.4": { levels: ["low", "medium", "high", "xhigh"], default: "medium" },
    };
    // Same forwarded request, but this profile cannot place `ultra` — the clamp
    // happens once, in the layer that actually knows the answer.
    expect(adapterResolves(profileCatalog, "gpt-5.4", governed.effort)).toBe("xhigh");
  });

  it("forwards an advertised level verbatim", () => {
    expect(governRouteEffort("high", route)).toEqual({ effort: "high", ignored: null });
  });

  it("discloses a level no ladder could place", () => {
    const governed = governRouteEffort("banana", route);
    expect(governed.effort).toBeNull();
    expect(governed.ignored).toContain("effort=banana");
    expect(governed.ignored).toContain("codex");
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

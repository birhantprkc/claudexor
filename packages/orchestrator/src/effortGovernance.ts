/**
 * Run-preflight effort gate (INV-105), the effort analog of `modelGovernance`.
 *
 * A requested effort meets the levels the ROUTED (harness, model) advertises.
 * An advertised level rides through, a rankable one clamps, and one we can
 * neither place on the ladder nor forward is DISCLOSED as ignored rather than
 * silently vanishing — the adapter would otherwise just omit the flag and the
 * user would never learn their level went nowhere.
 */
import type { EffortHint, HarnessCapabilities } from "@claudexor/schema";
import { effortLevelsForModel } from "@claudexor/schema";
import { resolveEffort } from "@claudexor/core";

export interface EffortGovernedRoute {
  id: string;
  /** Harness-wide advertised ladder; empty = effort is not a tunable surface. */
  effortLevels: readonly EffortHint[];
  /** Per-model narrowing; a model absent here uses the harness-wide ladder. */
  modelEffortLevels: HarnessCapabilities["model_effort_levels"];
}

/**
 * The effort this route should actually run with, plus any disclosure text.
 * `effort: null` means "send no flag" — either nothing was asked for, or what
 * was asked for could not be honored and is disclosed instead.
 */
export function governRouteEffort(
  requested: EffortHint | null,
  route: EffortGovernedRoute,
  model: string | null,
): { effort: EffortHint | null; ignored: string | null } {
  if (!requested) return { effort: null, ignored: null };
  if (route.effortLevels.length === 0) {
    return {
      effort: null,
      ignored: `effort=${requested} (manifest capabilities.effort_levels is empty for ${route.id})`,
    };
  }
  const check = resolveEffort(
    requested,
    effortLevelsForModel(
      { effort_levels: [...route.effortLevels], model_effort_levels: route.modelEffortLevels },
      model,
    ),
  );
  if (check.status === "rejected") {
    return { effort: null, ignored: `effort=${requested} (${check.message} for ${route.id})` };
  }
  return { effort: requested, ignored: null };
}

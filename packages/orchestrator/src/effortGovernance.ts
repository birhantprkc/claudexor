/**
 * Run-preflight effort gate (INV-105), the effort analog of `modelGovernance`.
 *
 * This gate DISCLOSES, it does not clamp. A requested effort that no harness
 * ladder could ever place is refused here and reported as ignored — the adapter
 * would otherwise just omit the flag and the user would never learn their level
 * went nowhere. Everything else rides through VERBATIM and is resolved by the
 * adapter.
 *
 * Why the clamp lives downstream and not here: the manifest is discovered
 * ONCE, against the DEFAULT native harness home (`discover()` takes no
 * arguments), so `capabilities.model_effort_levels` describes the DEFAULT
 * account's catalog. Codex advertises its ladders per ACCOUNT — every
 * credential profile and API-key route gets its own `CODEX_HOME`, and
 * `model/list` answers for whoever that home is logged into. Clamping here
 * would therefore hold a profile-scoped run to another account's ceiling
 * (asking for `ultra` on a profile whose model advertises it, and silently
 * getting `xhigh` because the default account stops there). The adapter
 * re-resolves against the catalog for the env the child will ACTUALLY run in
 * (`codexEffortsForEnv`), so it is the only layer entitled to clamp.
 *
 * The refusal test runs against the harness-wide advertised UNION rather than
 * the per-model narrowing, for the same reason: the union is the broadest and
 * least account-specific signal the manifest carries, so refusing against it
 * cannot reject a level merely because the DEFAULT account's copy of one model
 * happens not to list it.
 */
import type { EffortHint } from "@claudexor/schema";
import { resolveEffort } from "@claudexor/core";

export interface EffortGovernedRoute {
  id: string;
  /** Harness-wide advertised ladder; empty = effort is not a tunable surface. */
  effortLevels: readonly EffortHint[];
}

/**
 * The effort this route should FORWARD, plus any disclosure text.
 * `effort: null` means "send no flag" — either nothing was asked for, or what
 * was asked for could not be honored anywhere and is disclosed instead.
 *
 * A returned level is the RAW request, deliberately un-clamped: it is the
 * adapter's `effort_hint`, and every adapter that consumes it resolves through
 * the shared normalizer against its own profile-resolved advertised set
 * (`normalizeEffort` in harness-claude, `codexEffortFor` in harness-codex).
 */
export function governRouteEffort(
  requested: EffortHint | null,
  route: EffortGovernedRoute,
): { effort: EffortHint | null; ignored: string | null } {
  if (!requested) return { effort: null, ignored: null };
  if (route.effortLevels.length === 0) {
    return {
      effort: null,
      ignored: `effort=${requested} (manifest capabilities.effort_levels is empty for ${route.id})`,
    };
  }
  // `resolveEffort` stays the single owner of effort semantics (INV-122); only
  // its REJECTION verdict is read here. A level that is advertised, or that the
  // rank table can place against what is advertised, is forwardable — the
  // adapter decides where it actually lands. A level that is neither is one no
  // "nearest" could be invented for, so it is disclosed instead of vanishing.
  const check = resolveEffort(requested, route.effortLevels);
  if (check.status === "rejected") {
    return { effort: null, ignored: `effort=${requested} (${check.message} for ${route.id})` };
  }
  return { effort: requested, ignored: null };
}

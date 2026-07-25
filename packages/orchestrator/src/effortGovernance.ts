/**
 * Run-preflight effort gate (INV-105), the effort analog of `modelGovernance`.
 *
 * This gate DISCLOSES, it does not clamp. It answers exactly one question:
 * does the harness's merged advertised ladder (`capabilities.effort_levels`,
 * the positional merge of its models' vendor-ordered lists) know this level at
 * all? A level the merged ladder has never seen is disclosed as ignored — the
 * adapter would otherwise just omit the flag and the user would never learn
 * their level went nowhere. A level the ladder DOES know rides through
 * VERBATIM and is resolved by the adapter.
 *
 * Why the clamp lives downstream and not here: the manifest is discovered
 * ONCE, against the DEFAULT native harness home (`discover()` takes no
 * arguments), so its ladders describe the DEFAULT account's catalog. Codex
 * advertises its ladders per ACCOUNT — every credential profile and API-key
 * route gets its own `CODEX_HOME`, and `model/list` answers for whoever that
 * home is logged into. Clamping here would therefore hold a profile-scoped run
 * to another account's ceiling. The adapter re-resolves against the catalog
 * for the env the child will ACTUALLY run in (`codexEffortsForEnv`), so it is
 * the only layer entitled to clamp — and clamping is only ever a move INSIDE
 * the vendor's own order, which only the adapter's resolved catalog carries.
 *
 * The membership test runs against the harness-wide merged ladder rather than
 * the per-model narrowing, because the ladder is the broadest and least
 * account-specific signal the manifest carries: a level any of the harness's
 * models advertises is in it, so this gate cannot reject a level merely
 * because the routed model's copy happens not to list it.
 */
import type { EffortHint } from "@claudexor/schema";

export interface EffortGovernedRoute {
  id: string;
  /** Harness-wide merged advertised ladder; empty = effort is not a tunable surface. */
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
  // Pure membership against the merged vendor ladder: with no static rank
  // table there is nothing else for this layer to rank against, which is the
  // point — a level the harness's own advertised order has never seen is one
  // no honest "nearest" could be invented for, so it is disclosed instead of
  // vanishing. Anything the ladder knows is forwardable; WHERE it lands on the
  // routed model is the adapter's call.
  if (!route.effortLevels.includes(requested)) {
    return {
      effort: null,
      ignored:
        `effort=${requested} (not on the advertised ladder of ${route.id}: ` +
        `${route.effortLevels.join(", ")})`,
    };
  }
  return { effort: requested, ignored: null };
}

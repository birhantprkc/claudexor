import type { EffortHint } from "@claudexor/schema";
import { EFFORT_RANK_ORDER } from "@claudexor/schema";

/**
 * The cross-harness effort RANK table, weakest→strongest, read from the schema
 * SSOT (`EFFORT_RANK_ORDER`) so ordering can never drift between packages.
 *
 * Ranking is NOT permission. A level's presence here only means we know where it
 * sits relative to the others; what a run may actually use is whatever the
 * resolved (harness, model) ADVERTISES. That split is the whole design: the
 * vendor vocabulary is open (codex types its own `ReasoningEffort` as any
 * non-empty advertised string), so a level newer than this table must still pass
 * through untouched when the model advertises it.
 */
const EFFORT_LADDER: readonly string[] = EFFORT_RANK_ORDER;

/** Rank of a level, or -1 when this table has never heard of it. */
function rank(level: string): number {
  return EFFORT_LADDER.indexOf(level);
}

/**
 * Outcome of resolving a requested effort against an advertised vocabulary.
 * `rejected` carries actionable text naming what IS advertised — an unknown
 * level is never silently downgraded into something we merely guessed at.
 */
export type EffortCheck =
  | { status: "ok"; effort: EffortHint | null; clamped: boolean }
  | { status: "rejected"; message: string };

/**
 * Resolve a requested reasoning-effort level against the levels a specific
 * (harness, model) advertises. THE single owner of effort semantics; every
 * surface (adapters, settings writes, preflight) resolves through it.
 *
 * - nothing requested → ok, no effort (pass no flag).
 * - `advertised` empty → ok, no effort: effort is not a tunable surface here, so
 *   the caller discloses it as ignored (INV-105) instead of clamping to a guess.
 * - requested IS advertised → PASS THROUGH VERBATIM, even when this repo's rank
 *   table has never heard of it. This is what makes a future vendor level work
 *   with no Claudexor change.
 * - requested is not advertised but IS rankable → CLAMP to the nearest advertised
 *   level by rank (ties resolve to the cheaper one), the long-standing behavior.
 * - requested is neither advertised nor rankable → REJECT, naming the advertised
 *   set. We cannot place it on the ladder, so any "nearest" would be invented.
 */
export function resolveEffort(
  requested: EffortHint | null | undefined,
  advertised: readonly EffortHint[],
): EffortCheck {
  if (requested === null || requested === undefined) {
    return { status: "ok", effort: null, clamped: false };
  }
  if (advertised.length === 0) return { status: "ok", effort: null, clamped: false };
  if (advertised.includes(requested)) return { status: "ok", effort: requested, clamped: false };

  const want = rank(requested);
  // Only rankable candidates can host a clamp; a vendor level we cannot place is
  // a valid TARGET only through the exact-match branch above.
  const rankable = advertised.filter((level) => rank(level) >= 0);
  if (want < 0 || rankable.length === 0) {
    return {
      status: "rejected",
      message:
        `effort "${requested}" is not advertised here and cannot be ranked against what is ` +
        `(advertised: ${advertised.join(", ")})`,
    };
  }

  let best: EffortHint = rankable[0] as EffortHint;
  let bestDistance = Math.abs(rank(best) - want);
  for (const level of rankable.slice(1)) {
    const distance = Math.abs(rank(level) - want);
    // Strictly-closer wins; on a tie keep the LOWER-ranked (cheaper) candidate.
    if (distance < bestDistance || (distance === bestDistance && rank(level) < rank(best))) {
      best = level;
      bestDistance = distance;
    }
  }
  return { status: "ok", effort: best, clamped: true };
}

/**
 * Map a requested effort onto a level the resolved (harness, model) accepts, or
 * null when none should be sent. Thin translational wrapper over `resolveEffort`
 * for arg builders, which must never emit a level the vendor would reject: a
 * rejection yields null (send NO flag, keep the vendor default) rather than a
 * fabricated downgrade. Surfaces that can talk back to the user call
 * `resolveEffort` and report its `message`.
 */
export function normalizeEffort(
  requested: EffortHint | null | undefined,
  advertised: readonly EffortHint[],
): EffortHint | null {
  const check = resolveEffort(requested, advertised);
  return check.status === "ok" ? check.effort : null;
}

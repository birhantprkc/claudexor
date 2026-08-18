import type { CredentialProfile, QuotaSnapshot } from "@claudexor/schema";
import { quotaConstraintAppliesToModel } from "@claudexor/budget";
import { profileQuotaBlock } from "./credential-cooldown.js";
import { profileHeadroomBreach } from "./credential-profile-rotation.js";

/**
 * Quota-aware ACCOUNT POOL of the unified account model (INV-135 rewrite,
 * owner decisions D-U1 + K.5): with no explicit pin and no thread binding, an
 * unpinned run routes to the best enabled+ready account row of its harness.
 *
 * Ranking (D3 freshness preserved — stale quota never authorizes routing):
 *   1. rows with FRESH model-applicable quota evidence and headroom below the
 *      exhaustion bound, by known headroom DESCENDING;
 *   2. rows with unknown/stale quota (eligible, but never ranked as known
 *      headroom);
 *   3. exhausted rows (fresh evidence at/over the policy threshold) — never
 *      selected; they only count toward "the pool is exhausted".
 * Ties break deterministically by profile id (ascending).
 *
 * The pool contains SUBSCRIPTION-kind rows only: an api_key row is a paid
 * route and is never silently selected (INV-061); it remains an explicit pin
 * target. Pool exhaustion counts as unavailability for the policy-governed
 * API-key ROUTE fallback under auth_preference=auto (owner Q2=A).
 */

export type PoolQuotaVerdict =
  | { kind: "fresh_headroom"; headroom: number }
  | { kind: "unknown" }
  | { kind: "exhausted"; resets_at: string | null };

export interface PoolCandidate {
  profile: CredentialProfile;
  verdict: PoolQuotaVerdict;
}

/** The subscription-kind enabled rows of one harness (the static pool). */
export function accountPoolRows(
  registry: readonly CredentialProfile[],
  harnessId: string,
): CredentialProfile[] {
  return registry.filter(
    (profile) =>
      profile.harness_id === harnessId && profile.enabled && profile.credential_kind !== "api_key",
  );
}

/** Worst-window FRESH model-applicable headroom for one subject, or null when
 * no fresh applicable evidence exists (unknown/stale — D3: display-only). */
function freshModelHeadroom(
  snapshots: readonly QuotaSnapshot[],
  harnessId: string,
  profileId: string,
  model: string | null | undefined,
): number | null {
  let worst: number | null = null;
  for (const snapshot of snapshots) {
    if (snapshot.freshness !== "fresh") continue;
    if (snapshot.subject.harness !== harnessId) continue;
    if ((snapshot.subject.subject_id ?? null) !== profileId) continue;
    for (const constraint of snapshot.constraints) {
      if (!quotaConstraintAppliesToModel(constraint, model)) continue;
      if (constraint.used_ratio === null) continue;
      const headroom = 1 - constraint.used_ratio;
      if (worst === null || headroom < worst) worst = headroom;
    }
  }
  return worst;
}

/**
 * Rank one harness's READY pool rows per the unified-model comparator. Rows
 * outside `readyProfileIds` are excluded entirely (not ready ≠ exhausted).
 */
export function rankAccountPool(args: {
  registry: readonly CredentialProfile[];
  harnessId: string;
  snapshots: readonly QuotaSnapshot[];
  readyProfileIds: ReadonlySet<string>;
  headroomThreshold: number;
  model?: string | null;
}): PoolCandidate[] {
  const candidates: PoolCandidate[] = [];
  for (const profile of accountPoolRows(args.registry, args.harnessId)) {
    if (!args.readyProfileIds.has(profile.profile_id)) continue;
    const breach = profileHeadroomBreach(
      args.snapshots,
      args.harnessId,
      profile.profile_id,
      args.headroomThreshold,
      args.model,
    );
    if (breach) {
      candidates.push({
        profile,
        verdict: { kind: "exhausted", resets_at: breach.resets_at },
      });
      continue;
    }
    // A4 cooldown reader: a row under an OBSERVED live block (reactive
    // vendor-limit cooldown or spent window, stale-but-live included) ranks
    // exhausted with its earliest known release instant — selecting it would
    // burn an attempt to rediscover the limit the registry already holds.
    const block = profileQuotaBlock(args.snapshots, args.harnessId, profile.profile_id, args.model);
    if (block) {
      candidates.push({
        profile,
        verdict: { kind: "exhausted", resets_at: block.resets_at },
      });
      continue;
    }
    const headroom = freshModelHeadroom(
      args.snapshots,
      args.harnessId,
      profile.profile_id,
      args.model,
    );
    candidates.push({
      profile,
      verdict: headroom === null ? { kind: "unknown" } : { kind: "fresh_headroom", headroom },
    });
  }
  const rankOf = (verdict: PoolQuotaVerdict): number =>
    verdict.kind === "fresh_headroom" ? 0 : verdict.kind === "unknown" ? 1 : 2;
  return candidates.sort((a, b) => {
    const byRank = rankOf(a.verdict) - rankOf(b.verdict);
    if (byRank !== 0) return byRank;
    if (a.verdict.kind === "fresh_headroom" && b.verdict.kind === "fresh_headroom") {
      const byHeadroom = b.verdict.headroom - a.verdict.headroom;
      if (byHeadroom !== 0) return byHeadroom;
    }
    return a.profile.profile_id < b.profile.profile_id
      ? -1
      : a.profile.profile_id > b.profile.profile_id
        ? 1
        : 0;
  });
}

export type PoolSelection =
  | { outcome: "selected"; candidate: PoolCandidate }
  | {
      /** Every ready row is exhausted, or nothing is ready at all. Counts as
       * unavailability for the API-key ROUTE fallback under `auto` (Q2=A). */
      outcome: "exhausted" | "empty";
      /** Earliest known window reset among exhausted rows, when any. */
      resets_at: string | null;
    };

/**
 * Typed refusal for an unpinned run whose harness pool cannot serve it and
 * whose auth preference forbids the paid API-key route (Q2=A: exhaustion is
 * unavailability; `subscription` never falls to a key — INV-061). Machine
 * fields mirror the pinned refusal: `code` + `resetsAt`, prose stays human.
 */
export function accountPoolUnavailable(
  harnessId: string,
  selection: Extract<PoolSelection, { outcome: "exhausted" | "empty" }>,
): Error {
  const exhausted = selection.outcome === "exhausted";
  return Object.assign(
    new Error(
      exhausted
        ? `every enabled ${harnessId} account is over its quota window` +
            `${selection.resets_at ? ` (earliest reset ${selection.resets_at})` : ""}; ` +
            `the requested subscription route forbids the API-key fallback`
        : `no enabled ${harnessId} account is signed in and the requested subscription route forbids the API-key fallback; connect an account or pin one (--profile)`,
    ),
    {
      code: exhausted ? "subscription_window_exhausted" : "no_routable_account",
      category: "harness_unavailable",
      resetsAt: selection.resets_at,
    },
  );
}

/** Select the unpinned-run account from the pool (or report why not). */
export function selectFromAccountPool(args: Parameters<typeof rankAccountPool>[0]): PoolSelection {
  const ranked = rankAccountPool(args);
  const selectable = ranked.find((candidate) => candidate.verdict.kind !== "exhausted");
  if (selectable) return { outcome: "selected", candidate: selectable };
  if (ranked.length === 0) return { outcome: "empty", resets_at: null };
  let resetsAt: string | null = null;
  for (const candidate of ranked) {
    if (candidate.verdict.kind !== "exhausted" || candidate.verdict.resets_at === null) continue;
    if (resetsAt === null || candidate.verdict.resets_at < resetsAt) {
      resetsAt = candidate.verdict.resets_at;
    }
  }
  return { outcome: "exhausted", resets_at: resetsAt };
}

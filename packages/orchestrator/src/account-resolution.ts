import type {
  AuthPreference,
  CredentialProfile,
  CredentialProfileStatus,
  CredentialUnusableObservation,
  QuotaSnapshot,
} from "@claudexor/schema";
import { accountPoolRows, accountPoolUnavailable, selectFromAccountPool } from "./account-pool.js";
import { profileQuotaBlock, type QuotaBlock } from "./credential-cooldown.js";
import { readyProfilesForRotation } from "./credential-differential.js";
import { preflightDefaultSubject } from "./credential-preflight.js";
import {
  effectiveLimitAction,
  profileHeadroomBreach,
  subscriptionWindowExhausted,
  type ProfilePolicy,
} from "./credential-profile-rotation.js";
import { selectedProfileAvailability, type VendorQuotaObservations } from "./credential-profiles.js";

/**
 * The ONE account-resolution owner for a run's harness (INV-135 unified
 * account model, owner decisions D-U1/D-U6/Q1/Q2), extracted from the
 * orchestrator god-file (INV-124):
 *
 * 1. An explicit pin is STRICT — a fresh exhausted window OR an observed live
 *    quota block (A4: reactive cooldown / spent window, stale-but-live
 *    included) is a typed `subscription_window_exhausted` refusal, never a
 *    silent rotation.
 * 2. An unpinned thread turn stays on its durable bound account while that
 *    row is ready, else switches to the pool with a DISCLOSED lane switch.
 * 3. Unbound runs take the best row of the quota-aware pool.
 * 4. An empty/exhausted pool is unavailability: the paid API-key ROUTE serves
 *    it under a permitting preference (disclosed; never a row), else a typed
 *    refusal. Harnesses with no registered rows keep the legacy
 *    default-subject ladder (unmigrated stores).
 */

export type AccountResolutionEmit = (
  type:
    | "route.profile.headroom_exceeded"
    | "route.profile.rotated"
    | "route.profile.rotation_exhausted"
    | "route.profile.credential_unusable"
    | "route.account.pool_selected"
    | "route.account.lane_switch"
    | "route.account.pool_exhausted",
  payload: Record<string, unknown>,
) => void;

export interface AccountResolutionContext {
  harnessId: string;
  registry: readonly CredentialProfile[];
  policy: ProfilePolicy;
  snapshots: readonly QuotaSnapshot[];
  quota: VendorQuotaObservations;
  /** Live typed `credential_unusable` observations (A7): a condemned row is
   * refused at the readiness composition point, never re-discovered by
   * spending an attempt. */
  unusable: readonly CredentialUnusableObservation[];
  probe: ((profile: CredentialProfile) => Promise<CredentialProfileStatus>) | undefined;
  /** The explicit pin, already resolved/validated by the caller (null = unpinned). */
  pinnedProfile: CredentialProfile | null;
  /** The thread's durable per-harness binding for unpinned turns (D-U1 order 2). */
  boundProfileId: string | null;
  threadId: string | null;
  model: string | null;
  /** Default-route estimate of the legacy unprofiled ladder (no-rows harnesses). */
  defaultRoute: "local_session" | "api_key" | null;
  /** Whether the legacy native login is excluded (`native_credentials_enabled: false`). */
  nativeCredentialsDisabled: boolean;
  /** Effective auth preference (run > harness > routing config). */
  authPreference: AuthPreference;
  /** Record that this harness's unpinned route fell to the PAID api_key route. */
  notePoolApiKeyRoute: () => void;
  emit: AccountResolutionEmit;
}

/** The strict pin's refusal for an OBSERVED live block (A4): same typed code
 * and category as the headroom form — a consumer asks "when can I come back",
 * not which detector fired — with the block's own evidence in the prose. */
function pinnedWindowBlocked(profileId: string, harnessId: string, block: QuotaBlock): Error {
  return Object.assign(
    new Error(
      `credential profile "${profileId}" (${harnessId}) is ${
        block.kind === "exhausted"
          ? "over an observed vendor window"
          : "in a vendor rate-limit cooldown"
      } (${block.constraint_id ?? "cooldown"}; a pinned account never rotates${
        block.resets_at ? `; resets ${block.resets_at}` : ""
      })`,
    ),
    {
      code: "subscription_window_exhausted",
      category: "harness_unavailable",
      resetsAt: block.resets_at,
    },
  );
}

/** Per-run record of harnesses whose unpinned route fell to the PAID API-key
 * route because the pool was empty/exhausted (Q2=A): the spec then carries
 * auth_preference=api_key so the adapter can never spawn back into an
 * exhausted or excluded native login. Keyed by the run-input object. */
export class PoolRouteFlags {
  private readonly flags = new WeakMap<object, Set<string>>();
  note(runKey: object, harnessId: string): void {
    const set = this.flags.get(runKey) ?? new Set<string>();
    set.add(harnessId);
    this.flags.set(runKey, set);
  }
  has(runKey: object, harnessId: string): boolean {
    return this.flags.get(runKey)?.has(harnessId) ?? false;
  }
}

export async function resolveAccountForRun(
  ctx: AccountResolutionContext,
): Promise<CredentialProfile | null> {
  const { harnessId, registry, policy, snapshots, quota, model, emit } = ctx;
  // A7-aware readiness (ONE composition point, `readyProfilesForRotation`):
  // probe wrapper + vendor overlay + admission predicate + the live
  // `credential_unusable` refusal.
  const readyIds = () =>
    readyProfilesForRotation({
      registry,
      harnessId,
      policy,
      current: null,
      probe: ctx.probe,
      quota,
      unusable: ctx.unusable,
      model,
    });
  if (ctx.pinnedProfile) {
    // D-U6: strict pin. A fresh exhausted window refuses with its reset time;
    // unknown/stale quota never refuses (D3 freshness) — but an OBSERVED live
    // block (A4: reactive cooldown / spent window, stale-but-live included)
    // refuses too, since a cooldown instant is absolute clock truth.
    const pinned = ctx.pinnedProfile;
    const breach = profileHeadroomBreach(
      snapshots,
      harnessId,
      pinned.profile_id,
      policy.headroom_threshold,
      model,
    );
    const block = breach
      ? null
      : profileQuotaBlock(snapshots, harnessId, pinned.profile_id, model);
    if (!breach && !block) return pinned;
    emit("route.profile.headroom_exceeded", {
      harness_id: harnessId,
      profile_id: pinned.profile_id,
      action: "refuse",
      constraint_id: breach?.constraint_id ?? block?.constraint_id ?? null,
      used_ratio: breach?.used_ratio ?? null,
      threshold: policy.headroom_threshold,
      resets_at: breach?.resets_at ?? block?.resets_at ?? null,
    });
    throw breach
      ? subscriptionWindowExhausted(pinned.profile_id, harnessId, breach)
      : pinnedWindowBlocked(pinned.profile_id, harnessId, block as QuotaBlock);
  }
  const pool = accountPoolRows(registry, harnessId);
  // The legacy ladder serves ONLY harnesses with no REGISTERED subscription
  // rows (unmigrated stores). A harness whose rows are all DISABLED must fall
  // through to the pool path below and refuse typed (or take the disclosed
  // paid route) — the ladder would silently spawn back into the same
  // account's default store the owner just toggled off.
  const hasRegisteredRows = registry.some(
    (p) => p.harness_id === harnessId && p.credential_kind !== "api_key",
  );
  if (pool.length === 0 && !hasRegisteredRows) {
    if (ctx.nativeCredentialsDisabled) {
      // No rows AND the native login is excluded: only the paid route can
      // serve — never a silent spawn back INTO the disabled login. The
      // admission gate already dropped subscription-only requests.
      ctx.notePoolApiKeyRoute();
      emit("route.account.pool_exhausted", {
        harness_id: harnessId,
        reason: "the CLI login is disabled and no account is registered",
        resets_at: null,
        fallback: "api_key_route",
      });
      return null;
    }
    // Legacy default-subject ladder (unmigrated stores): under an EFFECTIVE
    // `rotate` (explicit, or the A6 kind-aware `auto` on a subscription
    // route), a fresh default-subject headroom breach — or its observed live
    // block (A4) — starts on the next eligible subscription profile instead;
    // effective `fail`/`ask` change nothing.
    const breach = profileHeadroomBreach(
      snapshots,
      harnessId,
      null,
      policy.headroom_threshold,
      model,
    );
    const readyProfileIds =
      effectiveLimitAction(policy, ctx.defaultRoute) === "rotate" &&
      ctx.defaultRoute === "local_session" &&
      (breach !== null || profileQuotaBlock(snapshots, harnessId, null, model) !== null)
        ? await readyIds()
        : new Set<string>();
    return preflightDefaultSubject({
      harnessId,
      policy,
      registry,
      snapshots,
      readyProfileIds,
      defaultRoute: ctx.defaultRoute,
      unusable: ctx.unusable,
      model,
      emit,
    });
  }
  const boundId = ctx.boundProfileId;
  let boundSwitchReason: string | null = null;
  if (boundId) {
    // D-U1 order 2: the thread's bound account resolves BEFORE the pool —
    // stickiness is not a pool ranking preference, so an explicit
    // rotation_eligible list cannot evict a healthy binding.
    const bound = pool.find((row) => row.profile_id === boundId);
    if (bound) {
      const verdict = await selectedProfileAvailability({
        registry,
        profileId: boundId,
        harnessId,
        probe: ctx.probe,
        quota,
      });
      const breach = profileHeadroomBreach(
        snapshots,
        harnessId,
        boundId,
        policy.headroom_threshold,
        model,
      );
      // A4: an observed live block on the bound row (reactive cooldown /
      // spent window) unbinds it exactly like a fresh breach would.
      const block = breach ? null : profileQuotaBlock(snapshots, harnessId, boundId, model);
      if (verdict === "available" && !breach && !block) return bound;
      boundSwitchReason =
        breach || block
          ? `quota window exhausted${
              (breach?.resets_at ?? block?.resets_at)
                ? ` (resets ${breach?.resets_at ?? block?.resets_at})`
                : ""
            }`
          : (verdict ?? "not ready");
    } else {
      boundSwitchReason = "the bound account was disabled or removed";
    }
  }
  const selection = selectFromAccountPool({
    registry,
    harnessId,
    snapshots,
    readyProfileIds: await readyIds(),
    headroomThreshold: policy.headroom_threshold,
    model,
  });
  if (selection.outcome === "selected") {
    const chosen = selection.candidate.profile;
    if (boundId && boundId !== chosen.profile_id) {
      // Q1=A: a lane switch is DISCLOSED, never silent (the continuity layer
      // additionally discloses the hydration on the turn).
      emit("route.account.lane_switch", {
        harness_id: harnessId,
        thread_id: ctx.threadId,
        from_profile_id: boundId,
        to_profile_id: chosen.profile_id,
        reason: boundSwitchReason,
      });
    }
    emit("route.account.pool_selected", {
      harness_id: harnessId,
      profile_id: chosen.profile_id,
      quota: selection.candidate.verdict.kind,
      ...(selection.candidate.verdict.kind === "fresh_headroom"
        ? { headroom: selection.candidate.verdict.headroom }
        : {}),
    });
    return chosen;
  }
  // Pool empty/exhausted = unavailability (Q2=A): the paid API-key ROUTE
  // serves the run under a permitting preference — a route, never a row —
  // else a typed refusal carrying the earliest known reset.
  if (ctx.authPreference === "subscription") {
    emit("route.account.pool_exhausted", {
      harness_id: harnessId,
      reason: selection.outcome,
      resets_at: selection.resets_at,
      fallback: null,
    });
    throw accountPoolUnavailable(harnessId, selection);
  }
  ctx.notePoolApiKeyRoute();
  emit("route.account.pool_exhausted", {
    harness_id: harnessId,
    reason: selection.outcome,
    resets_at: selection.resets_at,
    fallback: "api_key_route",
    ...(boundId ? { from_profile_id: boundId } : {}),
  });
  return null;
}

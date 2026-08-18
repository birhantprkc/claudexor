/**
 * Pure per-snapshot helpers of the QuotaRegistry, split to a smaller owner
 * (complexity ratchet): durable-journal v3.2.0 rollback shaping, snapshot
 * keying, freshness aging, and expired scoped-cooldown pruning. No registry
 * state lives here.
 */
import {
  REACTIVE_COOLDOWN_SOURCE,
  legacyV320QuotaSource,
  type QuotaConstraint,
  type QuotaSnapshot,
} from "@claudexor/schema";

export function snapshotKey(snapshot: QuotaSnapshot): string {
  const subject = snapshot.subject;
  return [
    subject.harness,
    subject.credential_route,
    subject.subject_id ?? "",
    snapshot.source,
  ].join("\0");
}

/** Exact durable payload accepted by the strict v3.2.0 quota schemas. Keep an
 * explicit allowlist at every nested level so a future additive field cannot
 * silently make updater rollback boot-incompatible again. */
export function legacyV320Snapshot(snapshot: QuotaSnapshot): QuotaSnapshot {
  return {
    subject: {
      harness: snapshot.subject.harness,
      credential_route: snapshot.subject.credential_route,
      plan_label: snapshot.subject.plan_label,
      subject_id: snapshot.subject.subject_id,
    },
    constraints: snapshot.constraints.map((constraint): QuotaConstraint => ({
      id: constraint.id,
      label: constraint.label,
      used_ratio: constraint.used_ratio,
      window_seconds: constraint.window_seconds,
      resets_at: constraint.resets_at,
      cooldown_until: constraint.cooldown_until,
    })),
    source: legacyV320QuotaSource(snapshot.source),
    observed_at: snapshot.observed_at,
    freshness: snapshot.freshness,
  };
}

export function staleAt(snapshot: QuotaSnapshot, now: number): QuotaSnapshot {
  if (snapshot.freshness !== "fresh") return snapshot;
  const observed = Date.parse(snapshot.observed_at);
  const resetExpired = snapshot.constraints.some((constraint) => resetExpiredAt(constraint, now));
  const tooOld = !Number.isFinite(observed) || now - observed > 5 * 60_000;
  return resetExpired || tooOld ? { ...snapshot, freshness: "stale" } : snapshot;
}

function resetExpiredAt(constraint: Pick<QuotaConstraint, "resets_at">, now: number): boolean {
  const reset = constraint.resets_at ? Date.parse(constraint.resets_at) : Number.NaN;
  return Number.isFinite(reset) && reset <= now;
}

export function isExpiredScopedCooldown(
  source: QuotaSnapshot["source"],
  constraint: QuotaConstraint,
  now: number,
): boolean {
  // Every reactive cooldown source (the upsertCooldown producers), not a claude-only
  // name check: an expired scoped sibling never hides a newer active one (Q24 generalized).
  return (
    Object.values(REACTIVE_COOLDOWN_SOURCE).includes(source) &&
    constraint.id.startsWith("cooldown:") &&
    resetExpiredAt(constraint, now)
  );
}

export function withoutExpiredScopedCooldowns(
  snapshot: QuotaSnapshot,
  now: number,
): QuotaSnapshot | null {
  const constraints = snapshot.constraints.filter(
    (constraint) => !isExpiredScopedCooldown(snapshot.source, constraint, now),
  );
  if (constraints.length === snapshot.constraints.length) return snapshot;
  return constraints.length === 0 ? null : { ...snapshot, constraints };
}

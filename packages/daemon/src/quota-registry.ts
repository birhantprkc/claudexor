import type { DurableJournal } from "@claudexor/journal";
import { hashJson } from "@claudexor/util";
import {
  ControlQuotaResponse,
  HarnessEvent,
  QuotaSnapshot as QuotaSnapshotSchema,
  type CredentialRoute,
  type QuotaAbsence,
  type QuotaConstraint,
  type QuotaSnapshot,
  type QuotaSubject,
} from "@claudexor/schema";

const UPSERTED = "quota.snapshot.upserted";
const SCOPED_PREPARED = "quota.snapshot.scoped_prepared";
const REMOVED = "quota.subject.removed";
const PROJECTION_UPDATED = "quota.projection.updated";
const POLL_BACKOFF_MS = 60_000;
const MAX_POLL_BACKOFF_MS = 15 * 60_000;
/** Snapshots older than this are pruned from every projection read (W17):
 * a day-old observation is not quota truth, just footer clutter. */
const MAX_SNAPSHOT_AGE_MS = 24 * 60 * 60_000;

/** One refresh cycle's fruit: the snapshots a source observed, plus the typed
 * absences it CLAIMS for subjects it tried and could not observe. Absence is
 * stated by the source, never inferred from an empty snapshot list. */
export interface QuotaRefreshResult {
  snapshots: QuotaSnapshot[];
  absences?: QuotaAbsence[];
}

export type QuotaRefresher = () => Promise<QuotaRefreshResult>;

/** The registered subject UNIVERSE: every subject the daemon expects to hear
 * about, so a subject with neither snapshot nor a source claim still surfaces
 * a "no_source" absence instead of vanishing. */
export type QuotaSubjectUniverse = () => QuotaSubject[];

/** Global-journal authority for vendor-owned quota snapshots. */
export class QuotaRegistry {
  private readonly snapshots = new Map<string, QuotaSnapshot>();
  /** Ephemeral typed-absence state, recomputed each refresh/poll cycle — NOT
   * journaled: an absence is a live derivation of "who reported nothing this
   * cycle", never a durable fact to replay. */
  private absences: QuotaAbsence[] = [];
  private pollFailures = 0;
  private pollNotBefore = 0;
  /** Signature carried by the last durable projection marker. Raw quota
   * evidence may span several records; this is the commit/recovery boundary
   * consumed by snapshot-then-SSE clients. */
  private lastPublishedProjectionSignature: string | null = null;
  private refreshInFlight: ReturnType<QuotaRegistry["performRefreshCycle"]> | null = null;

  constructor(
    private readonly journal: DurableJournal,
    private readonly refreshers: readonly QuotaRefresher[] = [],
    private readonly now: () => Date = () => new Date(),
    private readonly subjects: QuotaSubjectUniverse = () => [],
  ) {
    let rawMutationAfterMarker = false;
    let pendingScoped: { baseHash: string; snapshot: QuotaSnapshot } | null = null;
    for (const record of journal.records()) {
      if (record.type === SCOPED_PREPARED) {
        const payload =
          typeof record.payload === "object" &&
          record.payload !== null &&
          !Array.isArray(record.payload)
            ? (record.payload as {
                version?: unknown;
                base_hash?: unknown;
                snapshot?: unknown;
              })
            : {};
        const snapshot = QuotaSnapshotSchema.safeParse(payload.snapshot);
        pendingScoped =
          payload.version === 1 && typeof payload.base_hash === "string" && snapshot.success
            ? {
                baseHash: payload.base_hash,
                snapshot: snapshot.data,
              }
            : null;
        continue;
      }
      if (record.type === UPSERTED) {
        const base = QuotaSnapshotSchema.parse(record.payload);
        const baseHash = hashJson(base);
        const committedScoped =
          pendingScoped !== null &&
          pendingScoped.baseHash === baseHash &&
          hashJson(legacyV320Snapshot(pendingScoped.snapshot)) === baseHash
            ? pendingScoped.snapshot
            : null;
        this.apply(committedScoped ?? base);
        pendingScoped = null;
        rawMutationAfterMarker = true;
        continue;
      }
      // A scoped prepare commits only through the immediately following
      // matching legacy upsert. If the writer stopped or another record
      // intervened, ignore the incomplete prepare on replay.
      pendingScoped = null;
      if (record.type === REMOVED) {
        const payload = record.payload as { harness?: unknown; subject_id?: unknown };
        // subject_id is null for a harness's default/native subject, which is
        // exactly the one a revocation retirement can name.
        if (
          typeof payload.harness === "string" &&
          (typeof payload.subject_id === "string" || payload.subject_id === null)
        ) {
          this.remove(payload.harness, payload.subject_id);
        }
        rawMutationAfterMarker = true;
      }
      if (record.type === PROJECTION_UPDATED) {
        const payload = record.payload as { projection_signature?: unknown };
        this.lastPublishedProjectionSignature =
          typeof payload.projection_signature === "string" ? payload.projection_signature : null;
        rawMutationAfterMarker = false;
      }
    }
    this.validateProjection();
    // A process can stop after a durable raw mutation but before its separate
    // projection marker. Replaying that state without a new marker would leave
    // already-subscribed clients permanently behind. Close the recovered
    // commit boundary synchronously before the projection becomes available.
    if (rawMutationAfterMarker) {
      this.appendProjectionMarker("recovery", this.now().toISOString());
    }
  }

  read() {
    const now = this.now().getTime();
    return ControlQuotaResponse.parse({
      snapshots: this.activeSnapshots(now),
      absences: this.activeAbsences(now),
      refreshed_at: null,
    });
  }

  /** Freshness-annotated snapshots with expired (>24h) observations pruned.
   * An old observation whose constraint still EXTENDS into the future (a
   * weekly cooldown/reset seen once) is kept and stale-marked: pruning it
   * would hide a live cap from both the footer and the router's ledger. */
  private activeSnapshots(now: number): QuotaSnapshot[] {
    return [...this.snapshots.values()]
      .map((snapshot) => withoutExpiredScopedCooldowns(snapshot, now))
      .filter((snapshot): snapshot is QuotaSnapshot => snapshot !== null)
      .filter((snapshot) => {
        const observed = Date.parse(snapshot.observed_at);
        if (!Number.isFinite(observed)) return false;
        if (now - observed <= MAX_SNAPSHOT_AGE_MS) return true;
        return snapshot.constraints.some((constraint) =>
          [constraint.cooldown_until, constraint.resets_at].some((raw) => {
            const at = raw ? Date.parse(raw) : Number.NaN;
            return Number.isFinite(at) && at > now;
          }),
        );
      })
      .map((snapshot) => staleAt(snapshot, now));
  }

  async refresh() {
    return (await this.refreshCycle()).response;
  }

  /** Fresh quota plus the exact global-journal fence for snapshot-then-SSE.
   * The cursor is captured inside refreshCycle, synchronously with `response`,
   * so a later append can never be skipped by a client resuming from it. */
  async refreshWithCursor() {
    const { response, quotaEventCursor } = await this.refreshCycle();
    return { response, quotaEventCursor };
  }

  /** Cycle-local core: the produced-snapshot count belongs to THIS invocation
   * (wave-2 finding: a shared mutable field let a concurrent user refresh
   * overwrite the poller's view of its own cycle). */
  private refreshCycle() {
    if (this.refreshInFlight) return this.refreshInFlight;
    const cycle = this.performRefreshCycle().finally(() => {
      if (this.refreshInFlight === cycle) this.refreshInFlight = null;
    });
    this.refreshInFlight = cycle;
    return cycle;
  }

  private async performRefreshCycle() {
    if (this.refreshers.length === 0) {
      throw Object.assign(new Error("no live vendor-owned quota refresh source is available"), {
        code: "quota_refresh_unavailable",
        status: 503,
      });
    }
    let successfulSources = 0;
    let producedSnapshots = 0;
    const failures: string[] = [];
    const claims: QuotaAbsence[] = [];
    for (const refresher of this.refreshers) {
      try {
        const result = await refresher();
        // Validate the source batch before its first durable write. A malformed
        // later item must not leave earlier items applied without the cycle's
        // projection marker when this is the only nominally successful source.
        const snapshots = result.snapshots.map((snapshot) => QuotaSnapshotSchema.parse(snapshot));
        // One refresh can contain many vendor subjects. Persist every source
        // event, but publish ONE projection-level marker after the full response
        // is assembled so clients never see a marker-per-item burst.
        for (const snapshot of snapshots) this.recordUpsert(snapshot);
        producedSnapshots += snapshots.length;
        if (result.absences) claims.push(...result.absences);
        successfulSources += 1;
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (successfulSources === 0) {
      throw Object.assign(new Error(`quota refresh failed: ${failures.join("; ")}`), {
        code: "quota_refresh_unavailable",
        status: 503,
      });
    }
    const now = this.now().getTime();
    this.recomputeAbsences(claims, now);
    const refreshedAt = this.now().toISOString();
    const response = ControlQuotaResponse.parse({
      snapshots: this.activeSnapshots(now),
      absences: this.activeAbsences(now),
      refreshed_at: refreshedAt,
    });
    // No await may appear between response construction and this marker/cursor.
    // The marker makes absence-only and identical refreshes observable; its own
    // cursor is the exact last event represented by this response.
    const quotaEventCursor = this.appendProjectionMarker("refresh", refreshedAt, response);
    return { response, producedSnapshots, quotaEventCursor };
  }

  /** Aggregate one cycle's snapshots + absence claims against the subject
   * universe (V11a): a fresh-or-stale snapshot from ANY source means no
   * absence; else the first refresher-claimed absence wins; neither =>
   * "no_source". Identity is (harness, subject_id); route/source never split
   * a subject. */
  private recomputeAbsences(claims: readonly QuotaAbsence[], now: number): void {
    // Every other reason answers "why is there no snapshot", so a snapshot
    // silences it. `auth_revoked` says the vendor REJECTED the credential the
    // snapshot was read with: the window is no longer spendable, and leaving
    // it would report a dead profile as verified for up to 24h.
    for (const claim of claims) {
      if (claim.reason !== "auth_revoked") continue;
      const { harness, subject_id } = claim.subject;
      const present = [...this.snapshots.values()].some(
        (s) => s.subject.harness === harness && s.subject.subject_id === subject_id,
      );
      if (!present) continue;
      // Durable authority BEFORE the live projection (upsert/removeSubject
      // parity): a failed append after an in-memory delete would let replay
      // resurrect the revoked window on restart (f-dace28127b7a).
      this.journal.append(REMOVED, { harness, subject_id });
      this.remove(harness, subject_id);
    }
    const covered = new Set(
      this.activeSnapshots(now).map((snapshot) => subjectIdentity(snapshot.subject)),
    );
    const result: QuotaAbsence[] = [];
    const claimed = new Set<string>();
    for (const claim of claims) {
      const key = subjectIdentity(claim.subject);
      if (covered.has(key) || claimed.has(key)) continue;
      claimed.add(key);
      result.push(claim);
    }
    for (const subject of this.subjects()) {
      const key = subjectIdentity(subject);
      if (covered.has(key) || claimed.has(key)) continue;
      claimed.add(key);
      result.push({
        subject,
        reason: "no_source",
        detail: null,
        observed_at: new Date(now).toISOString(),
      });
    }
    this.absences = result;
  }

  /** Absences whose subject is not (any longer) covered by an active snapshot —
   * a snapshot arriving via ingest between cycles silences its absence at once,
   * so read() never shows a subject with both a snapshot and an absence. */
  private activeAbsences(now: number): QuotaAbsence[] {
    const covered = new Set(
      this.activeSnapshots(now).map((snapshot) => subjectIdentity(snapshot.subject)),
    );
    return this.absences.filter((absence) => !covered.has(subjectIdentity(absence.subject)));
  }

  /** A credential just changed (login/logout): drop the absence backoff so
   * the next poll observes the new state immediately instead of waiting out
   * up to 15 minutes of logged-out pacing (wave-1). */
  noteCredentialChange(): void {
    this.pollFailures = 0;
    this.pollNotBefore = 0;
  }

  /** Background official-source refresh for empty/stale projections with bounded backoff. */
  async pollStale(): Promise<boolean> {
    const now = this.now().getTime();
    const snapshots = this.activeSnapshots(now);
    // Freshness/pruning are clock-derived projection facts. Publish the change
    // even when the official refresh attempted below fails, so subscribers do
    // not retain a formerly-fresh quota/next_up pairing indefinitely.
    this.publishClockTransitionIfNeeded();
    if (snapshots.length > 0 && snapshots.every((snapshot) => snapshot.freshness === "fresh"))
      return false;
    if (now < this.pollNotBefore) return false;
    try {
      const { producedSnapshots } = await this.refreshCycle();
      if (producedSnapshots > 0) {
        this.pollFailures = 0;
        this.pollNotBefore = now + POLL_BACKOFF_MS;
        return true;
      }
      // An absence-only cycle (nobody logged in, endpoint returned nothing
      // parseable) is a SOFT failure for pacing (v3.0.3 S8): the typed
      // absences are recorded, but re-polling every minute forever would just
      // re-spawn vendor probes for the same answer — back off exponentially
      // until real state appears.
      this.pollFailures += 1;
      this.pollNotBefore =
        now + Math.min(POLL_BACKOFF_MS * 2 ** (this.pollFailures - 1), MAX_POLL_BACKOFF_MS);
      return true;
    } catch {
      this.pollFailures += 1;
      this.pollNotBefore =
        now + Math.min(POLL_BACKOFF_MS * 2 ** (this.pollFailures - 1), MAX_POLL_BACKOFF_MS);
      return false;
    }
  }

  ingest(harnessId: string, value: unknown): void {
    const event = HarnessEvent.safeParse(value);
    if (!event.success) return;
    const quota = event.data.quota;
    const credentialRoute = event.data.credential_route;
    if (quota && credentialRoute) {
      this.upsert({
        subject: {
          harness: harnessId,
          credential_route: credentialRoute,
          plan_label: quota.plan_label,
          // Reconcile the subject with the event's Claudexor profile stamp
          // (round-17 #2): a profiled run's quota must never register as the
          // engine-default subject just because the vendor record carries no
          // subject of its own. The profile stamp is the credential identity.
          subject_id: event.data.credential_profile_id ?? quota.subject_id ?? null,
        },
        constraints: quota.constraints,
        source: quota.source,
        observed_at: event.data.ts,
        freshness: "fresh",
      });
    }
    if (event.data.rate_limit && credentialRoute && ["codex", "claude"].includes(harnessId)) {
      this.upsertCooldown(harnessId, credentialRoute, event.data);
    }
  }

  upsert(value: QuotaSnapshot): void {
    this.recordUpsert(value);
    this.appendProjectionMarker("direct_mutation", this.now().toISOString());
  }

  private recordUpsert(value: QuotaSnapshot): void {
    const snapshot = QuotaSnapshotSchema.parse(value);
    // Runtime updates share this journal with the prior installed engine during
    // rollback. v3.2.0's strict QuotaConstraint schema predates
    // applies_to_models. Prepare the exact current snapshot under a new record
    // type that an older runtime safely ignores, then commit it with the
    // established, explicitly v3.2.0-shaped upsert. Current replay applies a
    // prepare only when its matching base follows, so a stop between the two
    // records loses neither the prior projection nor model scope: the journal
    // appends the pair under one recovery intent and one fsync.
    const legacy = legacyV320Snapshot(snapshot);
    if (snapshot.constraints.some((constraint) => constraint.applies_to_models !== undefined)) {
      this.journal.appendBatch([
        {
          type: SCOPED_PREPARED,
          payload: {
            version: 1,
            base_hash: hashJson(legacy),
            snapshot,
          },
        },
        { type: UPSERTED, payload: legacy },
      ]);
    } else {
      this.journal.append(UPSERTED, legacy);
    }
    this.apply(snapshot);
  }

  removeSubject(harness: string, subjectId: string): number {
    const removed = [...this.snapshots.values()].filter(
      (snapshot) =>
        snapshot.subject.harness === harness && snapshot.subject.subject_id === subjectId,
    ).length;
    this.journal.append(REMOVED, { harness, subject_id: subjectId });
    this.remove(harness, subjectId);
    this.appendProjectionMarker("direct_mutation", this.now().toISOString());
    return removed;
  }

  private appendProjectionMarker(
    reason: "refresh" | "direct_mutation" | "recovery" | "clock_transition",
    observedAt: string,
    response = this.read(),
  ): string {
    const projectionSignature = this.projectionSignature(response);
    const marker = this.journal.append(PROJECTION_UPDATED, {
      reason,
      observed_at: observedAt,
      projection_signature: projectionSignature,
    });
    this.lastPublishedProjectionSignature = projectionSignature;
    return this.journal.cursorFor(marker);
  }

  private publishClockTransitionIfNeeded(): void {
    const response = this.read();
    const signature = this.projectionSignature(response);
    if (signature === this.lastPublishedProjectionSignature) return;
    this.appendProjectionMarker("clock_transition", this.now().toISOString(), response);
  }

  private projectionSignature(response: ReturnType<QuotaRegistry["read"]>): string {
    // refreshed_at is request metadata, not projection identity. Snapshot
    // freshness and absence coverage are logical facts and remain included.
    return JSON.stringify({ snapshots: response.snapshots, absences: response.absences });
  }

  validateProjection(): void {
    for (const snapshot of this.snapshots.values()) QuotaSnapshotSchema.parse(snapshot);
  }

  private upsertCooldown(
    harness: string,
    credentialRoute: CredentialRoute,
    event: ReturnType<typeof HarnessEvent.parse>,
  ): void {
    const reset = event.rate_limit?.resets_at ?? null;
    const delay = event.rate_limit?.retry_delay_ms ?? null;
    const now = this.now();
    const cooldownUntil =
      reset ??
      new Date(now.getTime() + (typeof delay === "number" ? delay : 5 * 60_000)).toISOString();
    const source = harness === "claude" ? "claude_api_retry" : "codex_rollout";
    // The event's profile stamp scopes the cooldown to ITS subject (release
    // wave round-11): a profiled limit must never cool the default subject
    // down (or vice versa), and two profiles never share one quota key.
    const profileId = event.credential_profile_id ?? null;
    const constraintId = event.rate_limit?.constraint_id
      ? `cooldown:${event.rate_limit.constraint_id}`
      : "cooldown";
    const existing = [...this.snapshots.values()].find(
      (snapshot) =>
        snapshot.subject.harness === harness &&
        snapshot.subject.credential_route === credentialRoute &&
        (snapshot.subject.subject_id ?? null) === profileId &&
        snapshot.source === source,
    );
    this.upsert({
      subject: existing?.subject ?? {
        harness,
        credential_route: credentialRoute,
        plan_label: null,
        subject_id: profileId,
      },
      source,
      observed_at: event.ts,
      freshness: "fresh",
      constraints: [
        ...(existing?.constraints.filter(
          (constraint) =>
            constraint.id !== constraintId &&
            !isExpiredScopedCooldown(source, constraint, now.getTime()),
        ) ?? []),
        {
          id: constraintId,
          label: "Cooldown",
          ...(event.rate_limit?.applies_to_models !== undefined
            ? { applies_to_models: event.rate_limit.applies_to_models }
            : {}),
          used_ratio: null,
          window_seconds: null,
          resets_at: reset,
          cooldown_until: cooldownUntil,
        },
      ],
    });
  }

  private apply(snapshot: QuotaSnapshot): void {
    this.snapshots.set(snapshotKey(snapshot), snapshot);
  }

  private remove(harness: string, subjectId: string | null): number {
    let removed = 0;
    for (const [key, snapshot] of this.snapshots) {
      if (snapshot.subject.harness === harness && snapshot.subject.subject_id === subjectId) {
        this.snapshots.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
}

export function quotaProjection(
  refreshers: readonly QuotaRefresher[] = [],
  subjects: QuotaSubjectUniverse = () => [],
  now: () => Date = () => new Date(),
) {
  return {
    name: "quota",
    create: (journal: DurableJournal) => new QuotaRegistry(journal, refreshers, now, subjects),
    validate: (registry: QuotaRegistry) => registry.validateProjection(),
  };
}

function snapshotKey(snapshot: QuotaSnapshot): string {
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
function legacyV320Snapshot(snapshot: QuotaSnapshot): QuotaSnapshot {
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
    source: snapshot.source,
    observed_at: snapshot.observed_at,
    freshness: snapshot.freshness,
  };
}

/** Absence-matching identity: (harness, subject_id) only — one credential
 * subject is one subject regardless of which route or source observed it. */
function subjectIdentity(subject: QuotaSubject): string {
  return [subject.harness, subject.subject_id ?? ""].join("\0");
}

function staleAt(snapshot: QuotaSnapshot, now: number): QuotaSnapshot {
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

function isExpiredScopedCooldown(
  source: QuotaSnapshot["source"],
  constraint: QuotaConstraint,
  now: number,
): boolean {
  return (
    source === "claude_api_retry" &&
    constraint.id.startsWith("cooldown:") &&
    resetExpiredAt(constraint, now)
  );
}

function withoutExpiredScopedCooldowns(snapshot: QuotaSnapshot, now: number): QuotaSnapshot | null {
  const constraints = snapshot.constraints.filter(
    (constraint) => !isExpiredScopedCooldown(snapshot.source, constraint, now),
  );
  if (constraints.length === snapshot.constraints.length) return snapshot;
  return constraints.length === 0 ? null : { ...snapshot, constraints };
}

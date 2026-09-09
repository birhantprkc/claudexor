import type { DurableJournal } from "@claudexor/journal";
import { hashJson } from "@claudexor/util";
import {
  ControlQuotaResponse,
  HarnessEvent,
  QUOTA_GAP_ABSENCE_REASONS,
  QuotaAbsence as QuotaAbsenceSchema,
  QuotaSnapshot as QuotaSnapshotSchema,
  REACTIVE_COOLDOWN_SOURCE,
  vendorResetDayCooldownEnd,
  type CredentialRoute,
  type QuotaAbsence,
  type QuotaSnapshot,
  type QuotaSubject,
} from "@claudexor/schema";
import {
  isExpiredScopedCooldown,
  legacyV320Snapshot,
  snapshotKey,
  staleAt,
  withoutExpiredScopedCooldowns,
} from "./quota-registry-support.js";
import {
  buildRefresherLanes,
  derivePollPacedRows,
  foldAbsenceClaims,
  laneDemand,
  performPollSweep,
  recomputeScopeFor,
  selectCycleEntries,
  subjectCoverSets,
  type PacingLane,
  type QuotaRefresher,
  type QuotaVendorRefresher,
  type RefresherLanes,
} from "./quota-poll-lanes.js";
import type { QuotaPacerStateStore } from "./quota-poll-pacer.js";
import { QuotaRefreshCoordinator } from "./quota-refresh-coordinator.js";
import { quotaSubjectIdentity } from "./quota-refresh-demand.js";

const UPSERTED = "quota.snapshot.upserted";
const SCOPED_PREPARED = "quota.snapshot.scoped_prepared";
const REMOVED = "quota.subject.removed";
const PROJECTION_UPDATED = "quota.projection.updated";
const REPLAY_TYPES = [SCOPED_PREPARED, UPSERTED, REMOVED, PROJECTION_UPDATED];
/** Snapshots older than this are pruned from every projection read (W17):
 * a day-old observation is not quota truth, just footer clutter. */
const MAX_SNAPSHOT_AGE_MS = 24 * 60 * 60_000;

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
  /** Signature carried by the last durable projection marker. Raw quota
   * evidence may span several records; this is the commit/recovery boundary
   * consumed by snapshot-then-SSE clients. */
  private lastPublishedProjectionSignature: string | null = null;
  private readonly refreshCoordinator = new QuotaRefreshCoordinator<
    Awaited<ReturnType<QuotaRegistry["performRefreshCycle"]>>
  >();
  private readonly refresherLanes: RefresherLanes;
  private pollSweepInFlight: Promise<boolean> | null = null;
  private recoveryMarkerPending = false;

  constructor(
    private readonly journal: DurableJournal,
    refreshers: readonly (QuotaRefresher | QuotaVendorRefresher)[] = [],
    private readonly now: () => Date = () => new Date(),
    private readonly subjects?: QuotaSubjectUniverse,
    pacerStore?: QuotaPacerStateStore,
  ) {
    let rawMutationAfterMarker = false;
    let pendingScoped: { seq: number; baseHash: string; snapshot: QuotaSnapshot } | null = null;
    for (const record of journal.records(0, REPLAY_TYPES)) {
      // Filtering must not make a formerly interrupted pair adjacent.
      if (pendingScoped && record.seq !== pendingScoped.seq + 1) pendingScoped = null;
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
                seq: record.seq,
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
    this.recoveryMarkerPending = rawMutationAfterMarker;
    this.refresherLanes = buildRefresherLanes(refreshers, pacerStore);
  }

  /** Publish the recovered projection boundary only after bootstrap activation. */
  recoverAfterStartup(): void {
    if (!this.recoveryMarkerPending) return;
    this.appendProjectionMarker("recovery", this.now().toISOString());
    this.recoveryMarkerPending = false;
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

  /** One coalesced atomic refresh cycle; a poll passes its lane so only that
   * vendor's refreshers run. Join semantics are asymmetric on purpose: a poll
   * joining a foreground FULL cycle keeps its (superset) result, but a FULL
   * caller that joined a lane-SCOPED poll cycle re-runs a full cycle once it
   * completes — an explicit refresh must not silently return with sibling
   * vendors unre-fetched and undisclosed. Bounded retry; on exhaustion the
   * last (complete-projection) result serves. */
  private async refreshCycle(
    followCredentialChanges = true,
    scope?: PacingLane,
  ): Promise<Awaited<ReturnType<QuotaRegistry["performRefreshCycle"]>>> {
    for (let attempt = 0; ; attempt += 1) {
      const cycle = await this.refreshCoordinator.run(
        (credentialGeneration) => this.performRefreshCycle(credentialGeneration, scope ?? null),
        followCredentialChanges,
      );
      if (scope !== undefined || !cycle.scoped || attempt > this.refresherLanes.lanes.length)
        return cycle;
    }
  }

  private async performRefreshCycle(credentialGeneration: number, scope: PacingLane | null) {
    if (this.refresherLanes.entries.length === 0) {
      throw Object.assign(new Error("no live vendor-owned quota refresh source is available"), {
        code: "quota_refresh_unavailable",
        status: 503,
      });
    }
    // Foreground cycles honor each vendor lane's rate-limit cooldown; the
    // skips serve last-known registry data and are disclosed additively.
    const { running, skipped } = selectCycleEntries(
      this.refresherLanes,
      scope,
      this.now().getTime(),
    );
    const settled = await Promise.allSettled(running.map(async ({ refresh }) => refresh()));
    const batches: Array<{ snapshots: QuotaSnapshot[]; absences: QuotaAbsence[] } | null> = [];
    const failures: string[] = [];
    // Validate EVERY fulfilled source batch before the first durable write.
    // Declaration order below, not completion order, remains the deterministic
    // authority for both snapshot writes and first-claim absence precedence.
    for (const result of settled) {
      if (result.status === "rejected") {
        failures.push(
          result.reason instanceof Error ? result.reason.message : String(result.reason),
        );
        batches.push(null);
        continue;
      }
      try {
        batches.push({
          snapshots: result.value.snapshots.map((snapshot) => QuotaSnapshotSchema.parse(snapshot)),
          absences: (result.value.absences ?? []).map((absence) =>
            QuotaAbsenceSchema.parse(absence),
          ),
        });
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
        batches.push(null);
      }
    }
    // An all-cooled full cycle (running empty, skips disclosed) is a served
    // last-known response, not a failure; only attempted-and-failed sources
    // make the cycle unavailable.
    if (running.length > 0 && batches.every((batch) => batch === null)) {
      throw Object.assign(new Error(`quota refresh failed: ${failures.join("; ")}`), {
        code: "quota_refresh_unavailable",
        status: 503,
      });
    }
    // Everything below mutates the journal or live projection without an
    // await. Fence the whole commit boundary before its first write: a cycle
    // that captured retired credentials contributes no snapshot, absence,
    // marker, response, or cursor.
    if (!this.refreshCoordinator.isCurrent(credentialGeneration)) {
      throw new Error("quota refresh superseded by a credential change");
    }
    const claims: QuotaAbsence[] = [];
    for (const batch of batches) {
      if (batch === null) continue;
      // One refresh can contain many vendor subjects. Persist every source
      // event, but publish ONE projection-level marker after the full response
      // is assembled so clients never see a marker-per-item burst.
      for (const snapshot of batch.snapshots) this.recordUpsert(snapshot);
      claims.push(...batch.absences);
    }
    const now = this.now().getTime();
    if (running.length > 0) this.recomputeAbsences(claims, now, recomputeScopeFor(running));
    // A typed rate_limited absence is PACING evidence (owner decision 7=A):
    // arm the vendor lane's persisted floor — foreground cycles included, so
    // an explicit refresh that got throttled also cools later fan-outs — and
    // never journal it as a quota cooldown.
    for (const claim of claims) {
      if (claim.reason !== "rate_limited") continue;
      const lane = this.refresherLanes.lanes.find((item) => item.vendor === claim.subject.harness);
      lane?.pacer.noteRateLimited(now, claim.retry_after_ms ?? null);
    }
    const refreshedAt = this.now().toISOString();
    const response = ControlQuotaResponse.parse({
      snapshots: this.activeSnapshots(now),
      absences: this.activeAbsences(now),
      refreshed_at: refreshedAt,
      ...(skipped.length > 0 ? { refresh_skipped: skipped } : {}),
    });
    // No await may appear between response construction and this marker/cursor.
    // The marker makes absence-only and identical refreshes observable; its own
    // cursor is the exact last event represented by this response.
    const quotaEventCursor = this.appendProjectionMarker("refresh", refreshedAt, response);
    // scoped: an unscoped joiner re-runs a full cycle on it (join semantics).
    return { response, quotaEventCursor, scoped: scope !== null };
  }

  /** Fold claims against (harness, subject_id): fresh snapshots silence
   * refresh gaps; stale snapshots retain their explanations. Other claims
   * keep their existing precedence and retirement rules; no evidence yields
   * "no_source". Route/source never split a subject.
   *
   * `scope` (a vendor-lane cycle) rebuilds only that vendor's rows plus every
   * REFRESHERLESS harness's rows (those can only ever be `no_source`, and
   * skipping them would leave e.g. a cursor subject silently unstated until
   * the next full cycle); other vendors' claimed rows are preserved so a
   * claude-only poll cannot degrade codex's typed reasons to no_source.
   * `null` scope (a full cycle, or an anonymous-lane cycle whose coverage is
   * unknowable) keeps the pre-existing full rebuild. */
  private recomputeAbsences(
    claims: readonly QuotaAbsence[],
    now: number,
    scope: ReadonlySet<string> | null = null,
  ): void {
    const laneVendors = new Set(
      this.refresherLanes.lanes.map((lane) => lane.vendor).filter((vendor) => vendor !== null),
    );
    const rebuilt = (harness: string): boolean =>
      scope === null || scope.has(harness) || !laneVendors.has(harness);
    // Every other reason answers "why is there no snapshot", so a snapshot
    // silences it. `auth_revoked` says the vendor rejected the credential;
    // `credential_profile_ambiguous` says current platform policy forbids
    // choosing the subject at all. Both authoritatively retire cached derived
    // evidence before their typed absence is projected.
    for (const claim of claims) {
      if (claim.reason !== "auth_revoked" && claim.reason !== "credential_profile_ambiguous")
        continue;
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
    const { covered, freshCovered } = subjectCoverSets(this.activeSnapshots(now));
    this.absences = foldAbsenceClaims({
      claims,
      prior: this.absences,
      rebuilt,
      covered,
      freshCovered,
      subjects: this.subjects?.() ?? [],
      now,
    });
  }

  /** Refresh gaps coexist with stale snapshots and are silenced by fresh ones.
   * Other absences require no active snapshot. Floor-suppressed subjects gain
   * derived `poll_paced` rows (see derivePollPacedRows). */
  private activeAbsences(now: number): QuotaAbsence[] {
    const { covered, freshCovered } = subjectCoverSets(this.activeSnapshots(now));
    const rows = this.absences.filter(
      (absence) =>
        !(QUOTA_GAP_ABSENCE_REASONS.has(absence.reason) ? freshCovered : covered).has(
          quotaSubjectIdentity(absence.subject),
        ),
    );
    const subjects = this.subjects?.() ?? [];
    const lanes = this.refresherLanes.lanes;
    return rows.concat(derivePollPacedRows(lanes, subjects, rows, freshCovered, now));
  }

  /** Credential or routability state changed (login/profile/native/settings):
   * drop the credential-demand backoff so the next poll observes the new
   * subject universe instead of waiting out up to 15 minutes of old-state
   * pacing. Each lane's vendor rate-limit floor deliberately survives — a
   * login does not un-rate-limit the vendor endpoint. */
  noteCredentialChange(): void {
    this.refreshCoordinator.retireCredentialGeneration();
    for (const lane of this.refresherLanes.lanes) lane.pacer.noteCredentialChange();
  }

  /** Background official-source refresh for per-subject primary demand. One
   * single-flight sweep drives every vendor lane in order; each eligible lane
   * runs its own coalesced cycle, so one vendor's backoff never starves a
   * sibling vendor's freshness. Resolves true when any lane refreshed. */
  pollStale(): Promise<boolean> {
    if (this.pollSweepInFlight) return this.pollSweepInFlight;
    const sweep = performPollSweep(this.refresherLanes.lanes, {
      now: this.now,
      publishClockTransition: () => this.publishClockTransitionIfNeeded(),
      laneDemand: (vendor, now, dueBefore, since) =>
        laneDemand(vendor, this.activeSnapshots(now), this.subjects?.(), now, dueBefore, since),
      currentGeneration: () => this.refreshCoordinator.currentGeneration(),
      isCurrentGeneration: (generation) => this.refreshCoordinator.isCurrent(generation),
      runLaneCycle: (lane) => this.refreshCycle(false, lane),
    }).finally(() => {
      if (this.pollSweepInFlight === sweep) this.pollSweepInFlight = null;
    });
    this.pollSweepInFlight = sweep;
    return sweep;
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
          // subject of its own. The profile stamp is the binding key used for
          // routing and quota attribution, not a claim about physical custody.
          subject_id: event.data.credential_profile_id ?? quota.subject_id ?? null,
        },
        constraints: quota.constraints,
        source: quota.source,
        observed_at: event.data.ts,
        freshness: "fresh",
      });
    }
    if (event.data.rate_limit && credentialRoute && harnessId in REACTIVE_COOLDOWN_SOURCE) {
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
    // rollback. v3.2.0's strict schemas predate applies_to_models AND the
    // cursor_rate_limit source. Prepare the exact current snapshot under a new
    // record type an older runtime safely ignores, then commit it with the
    // established v3.2.0-shaped upsert; current replay applies a prepare only
    // when its matching base follows (one recovery intent, one fsync).
    const legacy = legacyV320Snapshot(snapshot);
    if (
      snapshot.constraints.some((constraint) => constraint.applies_to_models !== undefined) ||
      legacy.source !== snapshot.source
    ) {
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

  /** `subjectId: null` retires a harness's legacy default/native subject —
   * the unified-accounts migration's quota step (no replay alias: the new row
   * refreshes fresh, legacy null evidence is removed here or ages out). */
  removeSubject(harness: string, subjectId: string | null): number {
    // Fence held official work at the earliest credential-deletion boundary.
    this.noteCredentialChange();
    const removed = [...this.snapshots.values()].filter(
      (snapshot) =>
        snapshot.subject.harness === harness && (snapshot.subject.subject_id ?? null) === subjectId,
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
    // A day-granular vendor reset (A1 payload) bounds the cooldown at end-of-day UTC.
    const cooldownUntil =
      reset ??
      vendorResetDayCooldownEnd(event.payload) ??
      new Date(now.getTime() + (typeof delay === "number" ? delay : 5 * 60_000)).toISOString();
    const source = REACTIVE_COOLDOWN_SOURCE[harness] ?? "codex_rollout";
    // The event's profile stamp scopes the cooldown to ITS subject (round-11):
    // a profiled limit never cools the default subject down (or vice versa).
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

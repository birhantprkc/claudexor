import type { DurableJournal } from "@claudexor/journal";
import { hashJson } from "@claudexor/util";
import {
  ControlQuotaResponse,
  HarnessEvent,
  QuotaAbsence as QuotaAbsenceSchema,
  QuotaSnapshot as QuotaSnapshotSchema,
  REACTIVE_COOLDOWN_SOURCE,
  legacyV320QuotaSource,
  vendorResetDayCooldownEnd,
  type CredentialRoute,
  type QuotaAbsence,
  type QuotaConstraint,
  type QuotaSnapshot,
  type QuotaSubject,
} from "@claudexor/schema";
import { QuotaPollPacer } from "./quota-poll-pacer.js";
import { QuotaRefreshCoordinator } from "./quota-refresh-coordinator.js";
import { quotaSubjectIdentity, remainingQuotaRefreshDemand } from "./quota-refresh-demand.js";

const UPSERTED = "quota.snapshot.upserted";
const SCOPED_PREPARED = "quota.snapshot.scoped_prepared";
const REMOVED = "quota.subject.removed";
const PROJECTION_UPDATED = "quota.projection.updated";
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
  /** Signature carried by the last durable projection marker. Raw quota
   * evidence may span several records; this is the commit/recovery boundary
   * consumed by snapshot-then-SSE clients. */
  private lastPublishedProjectionSignature: string | null = null;
  private readonly refreshCoordinator = new QuotaRefreshCoordinator<
    Awaited<ReturnType<QuotaRegistry["performRefreshCycle"]>>
  >();
  private readonly pollPacer: QuotaPollPacer;
  private recoveryMarkerPending = false;

  constructor(
    private readonly journal: DurableJournal,
    private readonly refreshers: readonly QuotaRefresher[] = [],
    private readonly now: () => Date = () => new Date(),
    private readonly subjects?: QuotaSubjectUniverse,
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
    this.recoveryMarkerPending = rawMutationAfterMarker;
    this.pollPacer = new QuotaPollPacer({
      now: this.now,
      publishClockTransition: () => this.publishClockTransitionIfNeeded(),
      hasDemand: (now) =>
        remainingQuotaRefreshDemand(this.activeSnapshots(now), this.subjects?.()).size > 0,
      refresh: async () => {
        await this.refreshCycle(false);
      },
    });
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

  /** One coalesced atomic refresh cycle shared by foreground and background
   * callers; poll pacing derives from post-cycle demand, never shared counters. */
  private async refreshCycle(
    followCredentialChanges = true,
  ): ReturnType<QuotaRegistry["performRefreshCycle"]> {
    return this.refreshCoordinator.run(
      (credentialGeneration) => this.performRefreshCycle(credentialGeneration),
      followCredentialChanges,
    );
  }

  private async performRefreshCycle(credentialGeneration: number) {
    if (this.refreshers.length === 0) {
      throw Object.assign(new Error("no live vendor-owned quota refresh source is available"), {
        code: "quota_refresh_unavailable",
        status: 503,
      });
    }
    const settled = await Promise.allSettled(this.refreshers.map(async (refresher) => refresher()));
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
    if (batches.every((batch) => batch === null)) {
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
    return { response, quotaEventCursor };
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
      this.activeSnapshots(now).map((snapshot) => quotaSubjectIdentity(snapshot.subject)),
    );
    const result: QuotaAbsence[] = [];
    const claimed = new Set<string>();
    for (const claim of claims) {
      const key = quotaSubjectIdentity(claim.subject);
      if (covered.has(key) || claimed.has(key)) continue;
      claimed.add(key);
      result.push(claim);
    }
    for (const subject of this.subjects?.() ?? []) {
      const key = quotaSubjectIdentity(subject);
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
      this.activeSnapshots(now).map((snapshot) => quotaSubjectIdentity(snapshot.subject)),
    );
    return this.absences.filter((absence) => !covered.has(quotaSubjectIdentity(absence.subject)));
  }

  /** Credential or routability state changed (login/profile/native/settings):
   * drop absence backoff so the next poll observes the new subject universe
   * instead of waiting out up to 15 minutes of old-state pacing. */
  noteCredentialChange(): void {
    this.refreshCoordinator.retireCredentialGeneration();
    this.pollPacer.noteCredentialChange();
  }

  /** Background official-source refresh for per-subject primary demand. The
   * whole decision + refresh + pacing update is single-flight, independent of
   * foreground refresh coalescing. */
  pollStale(): Promise<boolean> {
    return this.pollPacer.poll();
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
    source: legacyV320QuotaSource(snapshot.source),
    observed_at: snapshot.observed_at,
    freshness: snapshot.freshness,
  };
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
  // Every reactive cooldown source (the upsertCooldown producers), not a claude-only
  // name check: an expired scoped sibling never hides a newer active one (Q24 generalized).
  return (
    Object.values(REACTIVE_COOLDOWN_SOURCE).includes(source) &&
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

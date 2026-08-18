import type { CredentialUnusableObservation, HarnessEvent } from "@claudexor/schema";
import { CredentialUnusableObservation as CredentialUnusableObservationSchema } from "@claudexor/schema";

/** No observation may outlive this bound, whatever its producer asked for. */
const MAX_TTL_MS = 24 * 60 * 60_000;
/** Bounded memory: the ledger holds evidence, not history. */
const MAX_ROWS = 64;

/**
 * The daemon's bounded, self-expiring memory of typed `credential_unusable`
 * observations (A7): "this credential is DEAD, not quota-spent".
 *
 * Deliberately IN-MEMORY, never journaled: profile readiness is non-durable by
 * contract (the doctor's projection), the quota poller re-derives vendor
 * rejections within a poll cycle after a restart, and a restart usually
 * follows exactly the re-login that heals a dead credential — journaling would
 * buy rollback-compat risk to preserve evidence that expires anyway. The
 * `QuotaAbsence` channel is unsuitable on purpose: the registry hides an
 * absence while ANY live snapshot covers the subject, which is exactly how a
 * dead credential with a lingering cooldown snapshot would vanish.
 *
 * Clearing contract (all three, per the design roast):
 * 1. self-expiry — every row carries `expires_at`, clamped to 24h max;
 * 2. a successful model response for the same subject (`observeEvent`);
 * 3. a credential-generation change voids the verdicts about the changed
 *    generation: a login/logout clears the WHOLE ledger
 *    (`noteCredentialChange`, wired in claudexord's setup lifecycle), while a
 *    control-API credential mutation (profile enable/disable/create/remove,
 *    secret set/delete) clears PER SUBJECT (`clearSubject` /
 *    `clearDefaultSubjects`, wired beside the daemon's status-cache busting).
 *    Clearing is always fail-open — a lost observation costs at
 *    most one attempt rediscovering a refusal, while a stale one poisons
 *    rotation.
 */
export class CredentialUnusableLedger {
  private rows = new Map<string, CredentialUnusableObservation>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  /** Validate, clamp to the TTL bound, newest-wins per (subject, model). */
  record(value: CredentialUnusableObservation): void {
    const obs = CredentialUnusableObservationSchema.parse(value);
    const observed = Date.parse(obs.observed_at);
    const cap = (Number.isFinite(observed) ? observed : this.now().getTime()) + MAX_TTL_MS;
    const expires = Math.min(Date.parse(obs.expires_at), cap);
    this.prune();
    if (!Number.isFinite(expires) || expires <= this.now().getTime()) return;
    if (this.rows.size >= MAX_ROWS && !this.rows.has(key(obs))) {
      // Bounded: drop the earliest-expiring row rather than refusing evidence.
      const earliest = [...this.rows.entries()].reduce((a, b) =>
        Date.parse(a[1].expires_at) <= Date.parse(b[1].expires_at) ? a : b,
      );
      this.rows.delete(earliest[0]);
    }
    this.rows.set(key(obs), { ...obs, expires_at: new Date(expires).toISOString() });
  }

  /** Every un-expired observation (the read side of the orchestrator deps). */
  live(): readonly CredentialUnusableObservation[] {
    this.prune();
    return [...this.rows.values()];
  }

  /**
   * Success telemetry (wired where usage events already flow): a usage event
   * with served tokens proves the vendor honored this subject's credential,
   * so its credential-wide observations are stale. A model-SCOPED entitlement
   * observation clears only when the event's observed model matches exactly —
   * vendor display labels are not slugs, so an unprovable match honestly
   * leaves the row to its short TTL or a generation change.
   */
  observeEvent(harnessId: string, event: HarnessEvent): void {
    if (event.type !== "usage") return;
    const served = (event.usage?.input_tokens ?? 0) > 0 || (event.usage?.output_tokens ?? 0) > 0;
    if (!served) return;
    const profileId = event.credential_profile_id ?? null;
    for (const [k, obs] of this.rows) {
      if (obs.harness_id !== harnessId || obs.profile_id !== profileId) continue;
      if (obs.model === null || obs.model === (event.observed_model ?? null)) this.rows.delete(k);
    }
  }

  /** Credential generation changed wholesale (login/logout): every verdict
   * about the old generation is void. */
  noteCredentialChange(): void {
    this.rows.clear();
  }

  /** ONE subject's credential changed (a control-API profile or profile-secret
   * mutation): only ITS verdicts are void, across every model scope.
   * `profileId` null = the harness's default subject. */
  clearSubject(harnessId: string, profileId: string | null): void {
    for (const [k, obs] of this.rows) {
      if (obs.harness_id === harnessId && obs.profile_id === profileId) this.rows.delete(k);
    }
  }

  /** A bare managed secret name changed an engine-DEFAULT credential slot.
   * WHICH harness reads that slot is adapter knowledge the daemon does not
   * duplicate, so every default subject's verdicts are voided — fail-open by
   * the clearing contract (costs at most one rediscovered refusal). */
  clearDefaultSubjects(): void {
    for (const [k, obs] of this.rows) {
      if (obs.profile_id === null) this.rows.delete(k);
    }
  }

  private prune(): void {
    const now = this.now().getTime();
    for (const [k, obs] of this.rows) {
      const expires = Date.parse(obs.expires_at);
      if (!Number.isFinite(expires) || expires <= now) this.rows.delete(k);
    }
  }
}

function key(obs: CredentialUnusableObservation): string {
  return [obs.harness_id, obs.profile_id ?? "", obs.model ?? ""].join("\0");
}

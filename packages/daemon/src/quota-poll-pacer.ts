const POLL_BACKOFF_MS = 60_000;
const MAX_POLL_BACKOFF_MS = 15 * 60_000;

export interface QuotaPollPacerDeps {
  readonly now: () => Date;
  readonly publishClockTransition: () => void;
  readonly hasDemand: (now: number) => boolean;
  readonly refresh: () => Promise<void>;
}

/** Whole-lifecycle single-flight and completion-anchored pacing for the quota
 * registry. Evidence/demand semantics stay with QuotaRegistry; this helper
 * owns only scheduling state. */
export class QuotaPollPacer {
  private failures = 0;
  private notBefore = 0;
  private inFlight: Promise<boolean> | null = null;
  /** Prevent an old-credential cycle from restoring backoff after a reset. */
  private credentialGeneration = 0;

  constructor(private readonly deps: QuotaPollPacerDeps) {}

  noteCredentialChange(): void {
    this.credentialGeneration += 1;
    this.failures = 0;
    this.notBefore = 0;
  }

  poll(): Promise<boolean> {
    if (this.inFlight) return this.inFlight;
    const poll = this.perform().finally(() => {
      if (this.inFlight === poll) this.inFlight = null;
    });
    this.inFlight = poll;
    return poll;
  }

  private async perform(): Promise<boolean> {
    const now = this.deps.now().getTime();
    this.deps.publishClockTransition();
    if (!this.deps.hasDemand(now)) return false;
    if (now < this.notBefore) return false;
    const credentialGeneration = this.credentialGeneration;
    try {
      await this.deps.refresh();
      const completedAt = this.deps.now().getTime();
      if (this.credentialGeneration !== credentialGeneration) return true;
      if (!this.deps.hasDemand(completedAt)) {
        this.failures = 0;
        this.notBefore = 0;
        return true;
      }
      this.armBackoff(completedAt);
      return true;
    } catch {
      if (this.credentialGeneration === credentialGeneration) {
        this.armBackoff(this.deps.now().getTime());
      }
      return false;
    }
  }

  private armBackoff(completedAt: number): void {
    this.failures += 1;
    this.notBefore =
      completedAt + Math.min(POLL_BACKOFF_MS * 2 ** (this.failures - 1), MAX_POLL_BACKOFF_MS);
  }
}

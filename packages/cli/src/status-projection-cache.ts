/**
 * TTL + single-flight cache for the daemon's poll-heavy status projections.
 *
 * Hit live 2026-08-04: a UI polling `/v2/credential-profiles` and
 * `/v2/harnesses` every 5 seconds made the daemon spawn full harness sweeps
 * (discover + doctor for every adapter, plus a doctor probe per registered
 * credential profile) on EVERY tick — each sweep shells out to the vendor
 * CLIs, takes >8s under load, and starves the daemon's request loop until an
 * interactive login POST times out client-side ("Daemon unreachable:
 * ReadTimeout"). The poller needs cheap reads, not fresh probes per tick, so
 * these projections now serve the last computed value inside a short TTL and
 * coalesce concurrent recomputes into one in-flight sweep. An explicit
 * fresh/snapshot request still bypasses the TTL, and a credential-state
 * change (login/logout) invalidates every registered cache so a fresh login
 * is visible on the next poll rather than a TTL later.
 */

import { statSync } from "node:fs";
import { globalConfigPath } from "@claudexor/config";

const registry = new Set<{ invalidate(): void }>();

/** Cheap identity stamp of the global config file: any write — service-layer,
 * CLI, or hand edit — changes it, so config-derived projection facts are never
 * served stale. One stat() per poll read. */
export function globalConfigVersion(): string {
  try {
    const s = statSync(globalConfigPath());
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "absent";
  }
}

export const STATUS_PROJECTION_TTL_MS = 15_000;

export interface StatusProjectionCacheOptions {
  ttlMs?: number;
  now?: () => number;
  /**
   * Cheap version stamp the cached value must match to be served — the global
   * config file's identity for both poll surfaces. Config-derived facts (the
   * Enabled toggle, registered profiles) are cheap to read and mutable through
   * MANY paths (service mutations, the CLI, a hand edit), so they must never
   * lag a TTL: only the expensive probe-derived facts deserve one. A version
   * mismatch recomputes exactly like an invalidation.
   */
  versionOf?: () => string;
}

export class StatusProjectionCache<T> {
  private value: { at: number; version: string; data: T } | null = null;
  private inFlight: { generation: number; promise: Promise<T> } | null = null;
  private generation = 0;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly versionOf: () => string;

  constructor(opts: StatusProjectionCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? STATUS_PROJECTION_TTL_MS;
    this.now = opts.now ?? Date.now;
    this.versionOf = opts.versionOf ?? (() => "");
    registry.add(this);
  }

  /** Serve the cached value inside the TTL (same version); otherwise compute
   * once, shared by every concurrent reader. `fresh` bypasses the TTL but
   * still coalesces with a current in-flight compute and re-primes the cache
   * on completion. An invalidation or version change during an in-flight
   * compute keeps that compute's result OUT of the cache (its data predates
   * the change) and later readers start a new one. */
  async read(compute: () => Promise<T>, opts?: { fresh?: boolean }): Promise<T> {
    const version = this.versionOf();
    if (
      !opts?.fresh &&
      this.value &&
      this.value.version === version &&
      this.now() - this.value.at < this.ttlMs
    ) {
      return this.value.data;
    }
    if (this.inFlight && this.inFlight.generation === this.generation) {
      return this.inFlight.promise;
    }
    const generation = this.generation;
    const entry = {
      generation,
      promise: compute().then(
        (data) => {
          if (this.generation === generation) {
            this.value = { at: this.now(), version: this.versionOf(), data };
          }
          if (this.inFlight === entry) this.inFlight = null;
          return data;
        },
        (err) => {
          // A failed sweep must not poison the cache: the next reader retries.
          if (this.inFlight === entry) this.inFlight = null;
          throw err;
        },
      ),
    };
    this.inFlight = entry;
    return entry.promise;
  }

  invalidate(): void {
    this.value = null;
    this.generation += 1;
  }
}

/** Credential state changed (login/logout): every projection that embeds
 * harness/profile status is stale at once. */
export function invalidateStatusProjections(): void {
  for (const cache of registry) cache.invalidate();
}

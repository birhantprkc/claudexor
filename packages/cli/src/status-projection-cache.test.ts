import { describe, expect, it } from "vitest";
import {
  STATUS_PROJECTION_TTL_MS,
  StatusProjectionCache,
  invalidateStatusProjections,
} from "./status-projection-cache.js";

describe("status projection cache (daemon poll-surface load fix, 2026-08-04)", () => {
  it("serves the cached value inside the TTL and recomputes after it", async () => {
    let nowMs = 0;
    let computes = 0;
    const cache = new StatusProjectionCache<number>({ now: () => nowMs });
    const compute = async () => ++computes;
    expect(await cache.read(compute)).toBe(1);
    // A 5s UI poll inside the TTL must not pay another sweep.
    nowMs += 5_000;
    expect(await cache.read(compute)).toBe(1);
    nowMs += STATUS_PROJECTION_TTL_MS;
    expect(await cache.read(compute)).toBe(2);
  });

  it("coalesces concurrent readers into one in-flight compute", async () => {
    let computes = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const cache = new StatusProjectionCache<number>();
    const compute = async () => {
      computes += 1;
      await gate;
      return computes;
    };
    const [a, b, c] = [cache.read(compute), cache.read(compute), cache.read(compute)];
    release();
    expect(await Promise.all([a, b, c])).toEqual([1, 1, 1]);
    expect(computes).toBe(1);
  });

  it("a failed compute does not poison the cache", async () => {
    const cache = new StatusProjectionCache<number>();
    await expect(cache.read(async () => Promise.reject(new Error("sweep died")))).rejects.toThrow(
      "sweep died",
    );
    expect(await cache.read(async () => 7)).toBe(7);
  });

  it("fresh bypasses the TTL and re-primes; invalidation forces the next read to compute", async () => {
    let nowMs = 0;
    let computes = 0;
    const cache = new StatusProjectionCache<number>({ now: () => nowMs });
    const compute = async () => ++computes;
    expect(await cache.read(compute)).toBe(1);
    expect(await cache.read(compute, { fresh: true })).toBe(2);
    expect(await cache.read(compute)).toBe(2);
    // A login/logout invalidates every registered projection at once.
    invalidateStatusProjections();
    expect(await cache.read(compute)).toBe(3);
  });

  it("a version change is an invalidation: config-derived facts never lag the TTL", async () => {
    // The failing gate pin (control-services-profile-update F1) proved this
    // live: a raw updateGlobalConfig write (the Enabled toggle) flowed through
    // no service-layer hook, and a whole-response TTL cache served the
    // pre-mutation projection. The cache now validates a cheap version stamp
    // (the global config file identity) on every read.
    let version = "v1";
    let computes = 0;
    const cache = new StatusProjectionCache<number>({ versionOf: () => version });
    const compute = async () => ++computes;
    expect(await cache.read(compute)).toBe(1);
    expect(await cache.read(compute)).toBe(1);
    version = "v2";
    expect(await cache.read(compute)).toBe(2);
    expect(await cache.read(compute)).toBe(2);
  });

  it("an invalidation during an in-flight compute keeps that result out of the cache", async () => {
    let computes = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const cache = new StatusProjectionCache<number>();
    const slow = async () => {
      computes += 1;
      await gate;
      return computes;
    };
    const first = cache.read(slow);
    // The mutation lands while the pre-mutation sweep is still running.
    invalidateStatusProjections();
    release();
    expect(await first).toBe(1);
    // The stale in-flight result must not have primed the cache.
    expect(await cache.read(async () => ++computes)).toBe(2);
  });
});

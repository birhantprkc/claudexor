import type { ThreadStore } from "./threads.js";

/**
 * Cross-partition account lifecycle helpers (INV-135/137), extracted from
 * project-partitions.ts (INV-124). The unified-accounts migration and its
 * rollback apply a continuity mutation across the global store and every
 * HEALTHY project partition; quarantined partitions are skipped and DISCLOSED
 * (their null-lane sessions migrate on a later start once recovered — a
 * bounded disclosed residual, never silent loss).
 */

export interface ProfileContinuityResult {
  sessions: number;
  checkpoints: number;
  skippedPartitions: string[];
}

export function applyProfileContinuityAcross(
  hosts: { stores: ThreadStore[]; skippedPartitions: string[] },
  apply: (store: ThreadStore) => { sessions: number; checkpoints: number },
): ProfileContinuityResult {
  let sessions = 0;
  let checkpoints = 0;
  for (const store of hosts.stores) {
    const result = apply(store);
    sessions += result.sessions;
    checkpoints += result.checkpoints;
  }
  return { sessions, checkpoints, skippedPartitions: hosts.skippedPartitions };
}

/** Credential-profile deletion invalidation summed across every store. */
export function invalidateCredentialProfileAcross(
  stores: ThreadStore[],
  harnessId: string,
  profileId: string,
): { clearedThreads: number; invalidatedSessions: number } {
  return stores.reduce(
    (total, store) => {
      const result = store.invalidateCredentialProfile(harnessId, profileId);
      return {
        clearedThreads: total.clearedThreads + result.clearedThreads,
        invalidatedSessions: total.invalidatedSessions + result.invalidatedSessions,
      };
    },
    { clearedThreads: 0, invalidatedSessions: 0 },
  );
}

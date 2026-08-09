import {
  quotaRefreshDemandHarnesses,
  quotaSourceTraits,
  type QuotaSnapshot,
  type QuotaSubject,
} from "@claudexor/schema";

const REFRESH_CAPABLE_HARNESSES = new Set<string>(quotaRefreshDemandHarnesses());

/** Demand identity: one credential subject regardless of route or source. */
export function quotaSubjectIdentity(subject: QuotaSubject): string {
  return [subject.harness, subject.subject_id ?? ""].join("\0");
}

/** Only fresh matching primary evidence satisfies a registered subject.
 * Reactive/spool evidence remains in the projection but is irrelevant here.
 * Undefined preserves the legacy embedder contract of one fresh primary;
 * an explicitly empty universe means no demand. */
export function remainingQuotaRefreshDemand(
  snapshots: readonly QuotaSnapshot[],
  subjects?: readonly QuotaSubject[],
): Set<string> {
  const satisfied = new Set(
    snapshots
      .filter(
        (snapshot) =>
          snapshot.freshness === "fresh" &&
          quotaSourceTraits(snapshot.source).refreshDemandHarness === snapshot.subject.harness,
      )
      .map((snapshot) => quotaSubjectIdentity(snapshot.subject)),
  );
  if (subjects === undefined) {
    return satisfied.size > 0 ? new Set() : new Set(["legacy-unscoped"]);
  }
  const demand = new Set<string>();
  for (const subject of subjects) {
    if (!REFRESH_CAPABLE_HARNESSES.has(subject.harness)) continue;
    const key = quotaSubjectIdentity(subject);
    if (!satisfied.has(key)) demand.add(key);
  }
  return demand;
}

import type { DurableJournal } from "@claudexor/journal";
import { QuotaRegistry, type QuotaRefresher, type QuotaSubjectUniverse } from "./quota-registry.js";

export function quotaProjection(
  refreshers: readonly QuotaRefresher[] = [],
  subjects?: QuotaSubjectUniverse,
  now: () => Date = () => new Date(),
) {
  return {
    name: "quota",
    create: (journal: DurableJournal) => new QuotaRegistry(journal, refreshers, now, subjects),
    validate: (registry: QuotaRegistry) => registry.validateProjection(),
    recover: (registry: QuotaRegistry) => registry.recoverAfterStartup(),
  };
}

import { rmSync } from "node:fs";
import { join } from "node:path";
import { makeOutcomeFacts, RunOutcomeFacts, WorkProduct } from "@claudexor/schema";
import type { ArtifactStore } from "@claudexor/artifact-store";

/** Strategy success may already have materialized a WorkProduct before a
 * terminal barrier settles. Reconcile only its terminal projection: produced
 * bytes, review evidence, and apply/revert state remain historical facts. */
export function reconcileWorkProductTerminal(
  context: { store: ArtifactStore; paths: { finalDir: string } },
  facts: RunOutcomeFacts,
): void {
  const path = join(context.paths.finalDir, "work_product.yaml");
  const current = context.store.readYaml<unknown>(path);
  if (!current || typeof current !== "object" || Array.isArray(current)) return;
  const record = current as Record<string, unknown>;
  const priorMeta =
    record["meta"] && typeof record["meta"] === "object" && !Array.isArray(record["meta"])
      ? (record["meta"] as Record<string, unknown>)
      : {};
  const reconciled = {
    ...record,
    meta: {
      ...priorMeta,
      lifecycle: facts.lifecycle,
      outcome_facts: facts,
    },
  };
  WorkProduct.parse(reconciled);
  context.store.writeYaml(path, reconciled);
}

/** Cancellation has no RunFailure payload. A prepared failed result may have
 * written one before the deferred terminal barrier lets cancellation win. */
export function clearFailureArtifact(context: { paths: { finalDir: string } }): void {
  rmSync(join(context.paths.finalDir, "failure.yaml"), { force: true });
}

/** Replace only the process terminal axes while retaining independent
 * checks/review/no-change/work-state evidence from an already prepared run. */
export function terminalOutcomeFacts(
  prior: RunOutcomeFacts | undefined,
  lifecycle: RunOutcomeFacts["lifecycle"],
  reason: RunOutcomeFacts["reason"],
): RunOutcomeFacts {
  return prior
    ? RunOutcomeFacts.parse({ ...prior, lifecycle, reason })
    : makeOutcomeFacts(lifecycle, { reason });
}

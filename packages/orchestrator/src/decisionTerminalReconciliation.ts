import { join } from "node:path";
import type { ArtifactStore } from "@claudexor/artifact-store";
import { DecisionRecord, type RunOutcomeFacts } from "@claudexor/schema";
import { terminalOutcomeFacts } from "./terminalOutcome.js";

/** The terminal guard owns only the terminal truth of an already-valid
 * decision. Ordinary strategies own their winner, review/check evidence,
 * budget, and recommendation; an escaped failure/cancel must not rewrite
 * those fields, but leaving a succeeded decision beside a failed lifecycle
 * would make Control project contradictory outcome facts. */
export function reconcileDecisionTerminal(
  context: { store: ArtifactStore; paths: { arbitrationDir: string } },
  terminal: { facts: RunOutcomeFacts; why: string; preparedFacts?: RunOutcomeFacts },
): RunOutcomeFacts {
  const path = join(context.paths.arbitrationDir, "decision.yaml");
  const current = context.store.readYaml<unknown>(path);
  const parsed = DecisionRecord.safeParse(current);
  if (!parsed.success || !current || typeof current !== "object" || Array.isArray(current)) {
    return terminal.facts;
  }
  const facts = terminalOutcomeFacts(
    terminal.preparedFacts ?? parsed.data.facts,
    terminal.facts.lifecycle,
    terminal.facts.reason,
  );
  const reconciled = {
    ...(current as Record<string, unknown>),
    facts,
    why_winner: terminal.why,
  };
  DecisionRecord.parse(reconciled);
  context.store.writeYaml(path, reconciled);
  return facts;
}

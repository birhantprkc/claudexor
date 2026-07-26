import type { ResolvedConfig, RoutingGoal } from "@claudexor/schema";
import { HarnessUnavailableError } from "@claudexor/core";
import { noProjectRepoRoot } from "@claudexor/util";
import type { RunInput } from "./orchestrator.js";

export interface RunInputResolutionDeps {
  config: ResolvedConfig;
  registryIds: Iterable<string>;
  routingGoal?: RoutingGoal;
}

/** Resolve stable pool, primary, model, web, and routing defaults once per run. */
export function resolveRunInputDefaults(input: RunInput, deps: RunInputResolutionDeps): RunInput {
  if (
    input.contextMode === "off" &&
    !(input.mode === "ask" && input.repoRoot === noProjectRepoRoot())
  ) {
    throw new Error("contextMode 'off' is only supported for Ask without a repoRoot");
  }
  const cfg = deps.config;
  const configuredPool = cfg.global.routing.eligible_harnesses;
  const harnesses = input.harnesses ?? (configuredPool.length > 0 ? configuredPool : undefined);
  const explicitPrimary = input.primaryHarness;
  const configPrimary = cfg.global.routing.primary_harness;
  const primaryHarness =
    explicitPrimary ??
    (input.harnesses?.length === 1 ? input.harnesses[0] : undefined) ??
    configPrimary ??
    undefined;
  if (primaryHarness && harnesses?.length && !harnesses.includes(primaryHarness)) {
    if (explicitPrimary) {
      throw new Error(
        `primary harness '${explicitPrimary}' is not in the eligible harness pool (${harnesses.join(", ")}); ` +
          `pass --primary-harness as one of [${harnesses.join(", ")}], or add '${explicitPrimary}' to --harness`,
      );
    }
    throw new HarnessUnavailableError(
      `ambiguous primary harness: the configured default primary '${primaryHarness}' is not in the selected pool [${harnesses.join(", ")}], ` +
        `and no --primary-harness was given. Pin one explicitly, e.g. \`--primary-harness ${harnesses[0]}\` ` +
        `(or another of [${harnesses.join(", ")}]).`,
    );
  }
  if (input.web && input.externalContextPolicy && input.web !== input.externalContextPolicy) {
    throw new Error(
      `contradictory web policy: web='${input.web}' vs externalContextPolicy='${input.externalContextPolicy}' (pass one, or equal values)`,
    );
  }
  const web = input.web ?? input.externalContextPolicy ?? "auto";
  const knownHarnessIds = new Set(deps.registryIds);
  for (const key of Object.keys(input.models ?? {})) {
    if (!knownHarnessIds.has(key)) {
      throw new Error(
        `models map names unknown harness '${key}' (registered: ${[...knownHarnessIds].sort().join(", ")}); ` +
          `run \`claudexor harness list --all\``,
      );
    }
  }
  const models: Record<string, string> = { ...input.models };
  if (input.model) {
    const scalarTarget = primaryHarness ?? (harnesses?.length === 1 ? harnesses[0] : undefined);
    if (!scalarTarget) {
      throw new Error(
        `a scalar model ('${input.model}') is ambiguous without a primary harness: ` +
          `the pool is ${harnesses?.length ? `[${harnesses.join(", ")}]` : "auto-resolved"} — ` +
          `set a primary harness, pass exactly one --harness, or use a harness-scoped model map`,
      );
    }
    models[scalarTarget] ??= input.model;
  }
  const harnessCfg = cfg.global.harnesses;
  for (const harnessId of harnesses ?? []) {
    const defaultModel = harnessCfg[harnessId]?.default_model;
    if (defaultModel) models[harnessId] ??= defaultModel;
  }
  return {
    ...input,
    harnesses,
    primaryHarness,
    primaryHarnessExplicit: explicitPrimary !== undefined,
    model: undefined,
    models,
    routingGoal:
      input.routingGoal ??
      deps.routingGoal ??
      cfg.project.budget?.routing_goal ??
      cfg.global.routing.goal ??
      "auto",
    web,
    externalContextPolicy: web,
  };
}

/**
 * Explicit reviewer-panel resolution (owner-configured panels). Every entry
 * must pass the SAME gates auto-selection uses — registered real harness,
 * enabled in settings, doctor-ok on the review route, readonly-review
 * capable — plus the STRICT model truth gate (INV-104: live inventory
 * when the adapter has `models()`, else manifest `known_models`; empty truth
 * refuses) and the declared effort ladder. Violations throw typed
 * HarnessUnavailableError; the orchestrator turns them into review_preflight
 * failure ARTIFACTS after run-dir creation, before candidates spend money.
 */
import type {
  AuthPreference,
  AuthSourceReadiness,
  ConformanceReport,
  ControlReviewerPanelEntry,
  EffortHint,
  Intent,
  ModelEffortCapability,
  ProviderFamily,
} from "@claudexor/schema";
import {
  effortLevelsForModel,
  estimateEffectiveAuthRoute,
  knownModelIdsForRoute,
} from "@claudexor/schema";
import type { HarnessAdapter } from "@claudexor/core";
import { HarnessUnavailableError, validateModel } from "@claudexor/core";
import { WorkspaceManager } from "@claudexor/workspace";
import type { ReviewerSpec } from "@claudexor/review";

const MODEL_INVENTORY_RETRY_DELAY_MS = 250;

interface PanelHarnessSettings {
  enabled?: boolean;
  default_model?: string | null;
}

export interface ReviewerPanelDeps {
  cwd: string;
  registry: Map<string, HarnessAdapter>;
  harnessSettings: Record<string, PanelHarnessSettings | undefined>;
  authPreferenceFor: (harnessId: string) => AuthPreference;
  /** Disclosure sink for a knob the panel dropped instead of refusing (the
   * auto panel's `reviewerEfforts` map). Optional: the drop itself never
   * depends on a listener being wired. */
  onIgnoredSetting?: (detail: string) => void;
}

/**
 * The reviewer effort gate: a requested level must be one the SELECTED reviewer
 * actually advertises.
 *
 * ONE owner for both panel paths (INV-104's effort sibling). The wire type is an
 * open slug rather than an enum — a level is only meaningful per (harness,
 * model), so the boundary cannot know it — which means this manifest check IS
 * the guarantee that a typo or an unsupported level is refused instead of
 * travelling inward. Without it a reviewer effort dies silently: the adapter's
 * normalizer drops an unresolvable level to "send no flag", while the review
 * artifact still records `requested_effort`, so the run reads as though the
 * level had been honored.
 */
function reviewerEffortRefusal(
  harnessId: string,
  requestedEffort: EffortHint | null,
  capabilities: {
    effort_levels: readonly EffortHint[];
    model_effort_levels: Record<string, ModelEffortCapability>;
  },
  model: string | null,
): string | null {
  if (!requestedEffort) return null;
  // Validate against the ladder of the model that will actually review: the
  // model's own advertised list when the entry resolves one and the manifest
  // recorded it, else the harness-wide merged ladder — which is then the only
  // honest set, and the refusal says so.
  const advertised = effortLevelsForModel(capabilities, model);
  if (advertised.includes(requestedEffort)) return null;
  const perModel =
    model !== null && (capabilities.model_effort_levels[model]?.levels.length ?? 0) > 0;
  const supported = advertised.join(", ");
  const suffix = !supported
    ? " (harness declares no effort controls)"
    : perModel
      ? ` (model '${model}' advertises: ${supported})`
      : ` (harness-wide advertised ladder — no per-model ladder recorded${model ? ` for '${model}'` : ""}: ${supported})`;
  return `reviewer harness '${harnessId}' does not support requested effort '${requestedEffort}'${suffix}`;
}

export async function resolveExplicitReviewerPanel(
  deps: ReviewerPanelDeps,
  panel: ControlReviewerPanelEntry[],
): Promise<ReviewerSpec[]> {
  const { cwd, registry, harnessSettings } = deps;
  const known = [...registry.keys()].sort().join(", ");
  const modelInventory = new Map<string, Set<string>>();
  const statusByRoute = new Map<
    string,
    {
      manifest: Awaited<ReturnType<HarnessAdapter["discover"]>> | null;
      status: "ok" | "degraded" | "unavailable";
      enabledIntents: Intent[];
      reasons: string[];
      authSources: AuthSourceReadiness[];
    }
  >();
  const specs: ReviewerSpec[] = [];
  const reviewModelHome: {
    current: { env: Record<string, string>; dispose: () => void } | null;
  } = { current: null };
  try {
    const reviewModelEnv = (): Record<string, string> => {
      reviewModelHome.current ??= new WorkspaceManager(cwd).readOnlyHomeEnv();
      return reviewModelHome.current.env;
    };
    for (const entry of panel) {
      const adapter = registry.get(entry.harness);
      if (!adapter) {
        throw new HarnessUnavailableError(
          `unknown reviewer harness '${entry.harness}' (registered: ${known}); run \`claudexor harness list --all\``,
        );
      }
      if (harnessSettings[entry.harness]?.enabled === false) {
        throw new HarnessUnavailableError(
          `reviewer harness '${entry.harness}' is disabled in settings (harnesses.${entry.harness}.enabled=false)`,
        );
      }
      const authPreference = deps.authPreferenceFor(entry.harness);
      const routeKey = `${entry.harness}\0${authPreference}`;
      if (!statusByRoute.has(routeKey)) {
        let manifest: Awaited<ReturnType<HarnessAdapter["discover"]>> | null = null;
        try {
          manifest = await adapter.discover();
        } catch {
          manifest = null;
        }
        try {
          const report = await adapter.doctor({ cwd, env: reviewModelEnv(), authPreference });
          statusByRoute.set(routeKey, {
            manifest,
            status: report.status,
            enabledIntents: report.enabled_intents,
            reasons: report.reasons ?? [],
            authSources: report.auth_sources ?? [],
          });
        } catch (err) {
          statusByRoute.set(routeKey, {
            manifest,
            status: "unavailable",
            enabledIntents: [],
            reasons: [err instanceof Error ? err.message : String(err)],
            authSources: [],
          });
        }
      }
      const status = statusByRoute.get(routeKey);
      const manifest = status?.manifest;
      if (!status || !manifest) {
        throw new HarnessUnavailableError(`reviewer harness '${entry.harness}' is unavailable`);
      }
      if (manifest.kind === "fake") {
        throw new HarnessUnavailableError(
          `reviewer harness '${entry.harness}' is a fake harness and cannot be used in reviewer panels`,
        );
      }
      if (status.status !== "ok") {
        const reason = status.reasons.length > 0 ? `: ${status.reasons.join("; ")}` : "";
        throw new HarnessUnavailableError(
          `reviewer harness '${entry.harness}' is not doctor-ok${reason}`,
        );
      }
      if (
        !status.enabledIntents.includes("review") ||
        !manifest.capabilities.review ||
        !manifest.access_profiles_supported.includes("readonly")
      ) {
        throw new HarnessUnavailableError(
          `reviewer harness '${entry.harness}' cannot perform readonly review`,
        );
      }
      const requestedModel = entry.model ?? harnessSettings[entry.harness]?.default_model ?? null;
      if (requestedModel) {
        if (typeof adapter.models !== "function") {
          // STRICT: the manifest list is the truth source here; an empty
          // list means the harness cannot verify models and the explicit
          // model is refused (validateModel phrases both refusals).
          const check = validateModel(
            requestedModel,
            knownModelIdsForRoute(
              manifest.capabilities.known_models,
              estimateEffectiveAuthRoute(authPreference, status.authSources),
            ),
            "manifest",
          );
          if (check.status !== "ok") {
            throw new HarnessUnavailableError(
              `reviewer harness '${entry.harness}' refused requested model '${requestedModel}': ${check.message}; run \`claudexor models --harness ${entry.harness}\``,
            );
          }
        } else {
          const inventoryKey = `${entry.harness}\0${authPreference}`;
          if (!modelInventory.has(inventoryKey)) {
            modelInventory.set(
              inventoryKey,
              await listModelIdsWithRetry(adapter.models.bind(adapter), {
                cwd,
                authPreference,
                env: reviewModelEnv,
                harnessId: entry.harness,
                requestedModel,
              }),
            );
          }
          const models = modelInventory.get(inventoryKey);
          if (models && !models.has(requestedModel)) {
            const available = [...models].slice(0, 80).join(", ");
            const suffix = models.size > 80 ? `, ... (${models.size} total)` : "";
            throw new HarnessUnavailableError(
              `reviewer harness '${entry.harness}' does not support requested model '${requestedModel}' on the review route (available: ${available}${suffix}); run \`claudexor models --harness ${entry.harness}\``,
            );
          }
        }
      }
      const requestedEffort = entry.effort ?? null;
      // An EXPLICIT panel entry is a precise owner statement — an unadvertised
      // level stays a hard, typed refusal (never forwarded to die natively).
      const refusal = reviewerEffortRefusal(
        entry.harness,
        requestedEffort,
        manifest.capabilities,
        requestedModel,
      );
      if (refusal) throw new HarnessUnavailableError(refusal);
      specs.push({
        adapter,
        providerFamily: manifest.provider_family,
        requestedModel,
        requestedEffort,
        authPreference,
      });
    }
  } finally {
    reviewModelHome.current?.dispose();
  }
  return specs;
}

export interface AutoReviewerPanelOverrides {
  reviewerModels?: Partial<Record<ProviderFamily, string>>;
  reviewerEfforts?: Partial<Record<ProviderFamily, EffortHint>>;
}

/**
 * Auto reviewer-panel selection (no owner-configured panel): pick up to two
 * doctor-ok, readonly-review-capable harnesses from DISTINCT provider
 * families. Eligibility consumes a point-probe in the same scoped read-only
 * env shape the reviewers later run with, and the STRICT model truth gate
 * applies to any per-family/default model override — a doomed reviewer model
 * is refused here, never forwarded to die as an opaque native error
 * mid-review.
 */
export async function resolveAutoReviewerPanel(
  deps: ReviewerPanelDeps,
  overrides: AutoReviewerPanelOverrides = {},
): Promise<ReviewerSpec[]> {
  const { cwd, registry, harnessSettings } = deps;
  const specs: ReviewerSpec[] = [];
  const seen = new Set<string>();
  const reviewHome = new WorkspaceManager(cwd).readOnlyHomeEnv();
  try {
    for (const adapter of registry.values()) {
      let m: Awaited<ReturnType<HarnessAdapter["discover"]>> | null = null;
      try {
        m = await adapter.discover();
      } catch {
        continue;
      }
      if (!m || m.kind === "fake" || seen.has(m.provider_family)) continue;
      // Per-harness settings gate reviewers before doctor/model probes: a disabled
      // harness must not spend auth/API-key readiness checks.
      if (harnessSettings[adapter.id]?.enabled === false) continue;
      const authPreference = deps.authPreferenceFor(adapter.id);
      let report: ConformanceReport | null = null;
      try {
        report = await adapter.doctor({ cwd, env: reviewHome.env, authPreference });
      } catch {
        continue;
      }
      if (report.status !== "ok") continue; // reviewer eligibility needs scoped doctor-OK.
      if (!report.enabled_intents.includes("review")) continue;
      if (!m.capabilities.review || !m.access_profiles_supported.includes("readonly")) continue;
      // Explicit per-family override first, then the user's per-harness
      // default model: an explicit model request makes the route provable
      // (accepted_model_arg) on CLIs that never echo their model.
      const requestedModel =
        overrides.reviewerModels?.[m.provider_family] ??
        harnessSettings[adapter.id]?.default_model ??
        null;
      // STRICT: the auto panel applies the SAME model truth gate as the
      // explicit panel — a doomed reviewer model is refused here, never
      // forwarded to die as an opaque native error mid-review.
      if (requestedModel) {
        const check = validateModel(
          requestedModel,
          typeof adapter.models === "function"
            ? (await adapter.models({ cwd, env: reviewHome.env, authPreference })).map((x) => x.id)
            : knownModelIdsForRoute(
                m.capabilities.known_models,
                estimateEffectiveAuthRoute(authPreference, report.auth_sources),
              ),
          typeof adapter.models === "function" ? "api" : "manifest",
        );
        if (check.status !== "ok") {
          throw new HarnessUnavailableError(
            `auto-selected reviewer harness '${adapter.id}' refused model '${requestedModel}': ${check.message}; ` +
              `fix the reviewer model override or harnesses.${adapter.id}.default_model, or run \`claudexor models --harness ${adapter.id}\``,
          );
        }
      }
      // DISCLOSE-AND-DROP, deliberately weaker than the model gate above: the
      // per-family `reviewerEfforts` map also rides stored replay surfaces
      // (Exact Retry params, `ControlRunAgainDraft.request`), so a map recorded
      // before a reviewer/catalog change must not hard-fail a replay that used
      // to run. A fresh request and a replayed draft are indistinguishable at
      // this layer, so the disclosed drop applies everywhere — the honest
      // middle: the panel still reviews, at the reviewer's default effort, and
      // the drop is disclosed instead of a typed refusal killing the run.
      // (Explicit `reviewerPanel[].effort` entries above stay hard refusals.)
      let requestedEffort = overrides.reviewerEfforts?.[m.provider_family] ?? null;
      const dropped = reviewerEffortRefusal(
        adapter.id,
        requestedEffort,
        m.capabilities,
        requestedModel,
      );
      if (dropped) {
        deps.onIgnoredSetting?.(`reviewer effort dropped: ${dropped}`);
        requestedEffort = null;
      }
      seen.add(m.provider_family);
      specs.push({
        adapter,
        providerFamily: m.provider_family,
        requestedModel,
        requestedEffort,
        authPreference,
      });
      if (specs.length >= 2) break;
    }
  } finally {
    reviewHome.dispose();
  }
  return specs;
}

/** One retry with a short delay: transient inventory hiccups (cold auth,
 * slow first call) must not fail a panel that would succeed a moment later —
 * but a persistently empty/erroring inventory still refuses loudly. */
async function listModelIdsWithRetry(
  listModels: NonNullable<HarnessAdapter["models"]>,
  input: {
    cwd: string;
    authPreference: AuthPreference;
    env: () => Record<string, string>;
    harnessId: string;
    requestedModel: string;
  },
): Promise<Set<string>> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const models = await listModels({
        cwd: input.cwd,
        env: input.env(),
        authPreference: input.authPreference,
      });
      if (models.length === 0) {
        throw new Error("model inventory was empty");
      }
      return new Set(models.map((m) => m.id));
    } catch (err) {
      lastError = err;
      if (attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, MODEL_INVENTORY_RETRY_DELAY_MS));
      }
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError ?? "unknown");
  throw new HarnessUnavailableError(
    `reviewer harness '${input.harnessId}' could not verify requested model '${input.requestedModel}' because its model inventory call failed after retry: ${detail}; run \`claudexor models --harness ${input.harnessId}\``,
  );
}

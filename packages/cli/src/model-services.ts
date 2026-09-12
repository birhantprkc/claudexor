import type { AdapterRegistry, ModelAdapter } from "@claudexor/core";
import { credentialProfilePolicyState } from "@claudexor/core";
import { loadConfig } from "@claudexor/config";
import {
  ModelOperations,
  type CredentialUnusableLedger,
  type DaemonClient,
  type ModelOperationDependencies,
  type QuotaRegistry,
} from "@claudexor/daemon";
import { createCodexModelAdapter } from "@claudexor/harness-codex";
import {
  differentialSubjectVerdict,
  probeCredentialProfileStatus,
  profileStatusAdmits,
  resolveAccountForRun,
  resolveCredentialProfile,
  vendorVerifiedProfileStatus,
  vendorCredentialObservation,
} from "@claudexor/orchestrator";
import {
  ControlModelCatalogResponse,
  ControlProblem,
  GlobalConfig,
  type CredentialProfile,
  type HarnessEvent,
  type ModelAccountChoice,
  type ModelUsage,
} from "@claudexor/schema";
import { errorCode, noProjectRepoRoot, redactSecrets } from "@claudexor/util";
import { accountsMigrationGate } from "./accounts-unified-migration.js";
import { buildRegistry } from "./registry.js";
import { credentialUnusableLedger } from "./run-orchestrator.js";
import type { RetentionRunner } from "./retention-service.js";

interface ModelSource {
  adapter: ModelAdapter;
  label: string;
  credentialHarness: string;
}

interface Dependencies extends Pick<ModelOperationDependencies, "commands" | "resources" | "warn"> {
  client: Pick<DaemonClient, "enqueue" | "cancel">;
  quota: () => QuotaRegistry;
  config?: () => GlobalConfig;
  registry?: AdapterRegistry;
  sources?: readonly ModelSource[];
  unusable?: CredentialUnusableLedger;
  migrationGate?: typeof accountsMigrationGate;
}

function modelError(code: string, message: string, status = 409): Error {
  return Object.assign(new Error(message), { code, status, retryable: false });
}

/** Model transport composition shares account, quota, command, and retention owners
 * with Agents. It never starts an Agent Run or creates another routing ledger. */
export function createModelServices(deps: Dependencies) {
  const sources = deps.sources ?? [
    { adapter: createCodexModelAdapter(), label: "Codex", credentialHarness: "codex" },
  ];
  const registry = deps.registry ?? buildRegistry({ includeFakes: false });
  const config = deps.config ?? (() => loadConfig(noProjectRepoRoot()).global);
  const unusable = deps.unusable ?? credentialUnusableLedger;
  const lifetime = new AbortController();
  const getSource = (id: string): ModelSource => {
    const source = sources.find((entry) => entry.adapter.id === id);
    if (!source) throw modelError("model_source_unavailable", "No such model source", 404);
    const migration = (deps.migrationGate ?? accountsMigrationGate)(source.credentialHarness);
    if (migration) throw modelError("accounts_migration_incomplete", migration.reason, 503);
    return source;
  };

  const resolve = async (
    source: ModelSource,
    account: ModelAccountChoice,
    model: string | null,
    signal: AbortSignal,
  ): Promise<{ profile: CredentialProfile; catalog: ControlModelCatalogResponse }> => {
    signal.throwIfAborted();
    const cfg = config();
    const harnessId = source.credentialHarness;
    const harness = cfg.harnesses[harnessId];
    if (harness?.enabled === false)
      throw modelError("model_source_unavailable", "This model source is disabled in settings");
    // The first model transport admits only the existing managed-login rows.
    // API-key and OAuth secret-reference rows remain Agent capabilities.
    const profiles = cfg.credential_profiles.filter(
      (row) => row.credential_kind === "config_dir_login",
    );
    let pinnedProfile: CredentialProfile | null = null;
    if (account.mode === "pin") {
      try {
        pinnedProfile = resolveCredentialProfile(profiles, account.profileId, harnessId);
      } catch {
        throw modelError(
          "model_account_unavailable",
          "The pinned managed model account is unknown, disabled, or incompatible",
        );
      }
    }
    const probe = registry.get(harnessId)?.probeCredentialProfile?.bind(registry.get(harnessId));
    const quota = deps.quota().read();
    if (pinnedProfile) {
      // Preserve a confirmed sign-in remedy across subsequent pinned calls.
      // Local probe failures and generic unavailability do not prove revocation.
      const revoked = unusable
        .live()
        .find(
          (entry) =>
            entry.harness_id === harnessId &&
            entry.profile_id === pinnedProfile.profile_id &&
            entry.code === "auth_revoked" &&
            (entry.model === null || entry.model === model),
        );
      const vendor = vendorCredentialObservation(quota, harnessId, pinnedProfile.profile_id);
      const revokedAt =
        revoked?.observed_at ?? (vendor?.outcome === "revoked" ? vendor.observed_at : null);
      if (revokedAt)
        throw Object.assign(
          modelError("auth_required", "The pinned managed model account requires sign-in"),
          {
            problem: ControlProblem.parse({
              code: "auth_required",
              message: "The pinned managed model account requires sign-in",
              retryable: false,
              context: {
                source: source.adapter.id,
                credentialProfileId: pinnedProfile.profile_id,
                observedAt: revokedAt,
              },
            }),
          },
        );
      const status = vendorVerifiedProfileStatus(
        await probeCredentialProfileStatus(pinnedProfile, probe),
        quota,
      );
      if (!profileStatusAdmits(pinnedProfile, status))
        throw modelError(
          "auth_unavailable",
          "The pinned model account has no verified current authentication",
        );
    }
    const excluded = new Set<string>();
    const catalogRefusals = new Map<string, ControlProblem>();
    // Catalog membership is checked on exactly the selected account, before inference.
    // The same pool resolver chooses any next candidate; this loop never generates.
    while (true) {
      signal.throwIfAborted();
      const currentQuota = deps.quota().read();
      let profile: CredentialProfile | null;
      try {
        profile = await resolveAccountForRun({
          harnessId,
          registry: profiles,
          policy:
            harness?.profile_policy ??
            GlobalConfig.parse({ harnesses: { [harnessId]: {} } }).harnesses[harnessId]!
              .profile_policy,
          profileCardinality: credentialProfilePolicyState({
            adapter: registry.get(harnessId),
            registry: profiles,
          }),
          snapshots: currentQuota.snapshots,
          quota: currentQuota,
          unusable: unusable.live(),
          probe,
          pinnedProfile,
          boundProfileId: account.mode === "auto" ? (account.preferredProfileId ?? null) : null,
          threadId: null,
          model,
          excludedProfileIds: excluded,
          defaultRoute: null,
          // Model calls cannot borrow an unregistered/default login or a paid route.
          nativeCredentialsDisabled: true,
          authPreference: "subscription",
          notePoolApiKeyRoute: () => {},
          emit: () => {},
        });
      } catch (error) {
        if (errorCode(error) === "credential_pool_exhausted") {
          const provided = ControlProblem.safeParse(
            error && typeof error === "object" && "problem" in error ? error.problem : null,
          );
          const recordedCauses = provided.success ? provided.data.context.poolCauses : null;
          const causes = new Set(Array.isArray(recordedCauses) ? recordedCauses : []);
          const resets: Array<string | null> = causes.has("quota")
            ? [
                provided.success && typeof provided.data.context.resetsAt === "string"
                  ? provided.data.context.resetsAt
                  : null,
              ]
            : [];
          for (const refusal of catalogRefusals.values()) {
            causes.add(
              refusal.code === "auth_required"
                ? "auth"
                : refusal.code === "subscription_window_exhausted"
                  ? "quota"
                  : "unavailable",
            );
            if (refusal.code === "subscription_window_exhausted")
              resets.push(
                typeof refusal.context.resetsAt === "string" ? refusal.context.resetsAt : null,
              );
          }
          const poolCause =
            causes.size === 1 && causes.has("quota")
              ? "quota"
              : causes.size === 1 && causes.has("auth")
                ? "auth"
                : causes.size > 1 && !causes.has("unavailable")
                  ? "mixed"
                  : "unavailable";
          const code =
            poolCause === "quota"
              ? "subscription_window_exhausted"
              : poolCause === "auth"
                ? "auth_required"
                : excluded.size > 0 && causes.size === 0
                  ? "model_unavailable"
                  : "credential_pool_exhausted";
          const message =
            poolCause === "quota"
              ? "Every available model account is blocked by subscription quota"
              : poolCause === "auth"
                ? "Every available model account requires sign-in"
                : "No managed account can currently serve this model request";
          const resetsAt =
            resets.length > 0 &&
            resets.every((at): at is string => at !== null && Number.isFinite(Date.parse(at)))
              ? resets.reduce((earliest, at) =>
                  Date.parse(at) < Date.parse(earliest) ? at : earliest,
                )
              : null;
          throw Object.assign(modelError(code, message), {
            problem: ControlProblem.parse({
              code,
              message,
              retryable: false,
              context: { source: source.adapter.id, poolCause, resetsAt },
            }),
          });
        }
        throw error;
      }
      if (!profile)
        throw modelError("model_account_unavailable", "Connect a managed account for model calls");
      signal.throwIfAborted();
      let catalog: ControlModelCatalogResponse;
      try {
        catalog = ControlModelCatalogResponse.parse(
          await source.adapter.catalog({ profile, signal }),
        );
      } catch (error) {
        const problem = ControlProblem.safeParse(
          error && typeof error === "object" && "problem" in error ? error.problem : null,
        );
        if (!problem.success) throw error;
        const refusal = {
          ...problem.data,
          context: {
            ...problem.data.context,
            source: source.adapter.id,
            credentialProfileId: profile.profile_id,
          },
        };
        catalogRefusals.set(profile.profile_id, refusal);
        // One selection epoch visits a rejected account at most once, even if
        // evidence maintenance fails or a concurrent refresh retires its block.
        excluded.add(profile.profile_id);
        try {
          await observe(source, profile, refusal);
        } catch (error) {
          deps.warn?.(`Model quota evidence was not recorded: ${redactSecrets(String(error))}`);
        }
        if (account.mode === "pin")
          throw Object.assign(modelError(refusal.code, refusal.message), { problem: refusal });
        continue;
      }
      if (
        catalog.source !== source.adapter.id ||
        catalog.credentialProfileId !== profile.profile_id
      )
        throw modelError(
          "model_catalog_identity_mismatch",
          "The model catalog does not identify the selected account",
        );
      if (model === null || catalog.models.some((entry) => entry.id === model))
        return { profile, catalog };
      if (account.mode === "pin")
        throw modelError(
          "model_unavailable",
          "The pinned account does not advertise the requested model",
        );
      excluded.add(profile.profile_id);
    }
  };

  const observe = async (
    source: ModelSource,
    profile: CredentialProfile,
    problem: ControlProblem | null,
    usage?: ModelUsage,
    model?: string | null,
  ) => {
    const ts = new Date().toISOString();
    const event: HarnessEvent = {
      type: usage ? "usage" : "error",
      ts,
      session_id: "model-operation",
      credential_route: "vendor_native",
      credential_profile_id: profile.profile_id,
      observed_model: model ?? undefined,
      usage: {
        input_tokens: usage?.input_tokens ?? undefined,
        output_tokens: usage?.output_tokens ?? undefined,
        cached_input_tokens: usage?.cached_input_tokens ?? undefined,
      },
    };
    // A cooldown is an assertion about time, so only the vendor's own reset or
    // retry delay may produce one. Without either field the registry would
    // invent a window instead of admitting it does not know.
    const context = problem?.context ?? {};
    if (typeof context.resetsAt === "string" || typeof context.retryAfterMs === "number") {
      event.rate_limit = {
        resets_at: typeof context.resetsAt === "string" ? context.resetsAt : null,
        retry_delay_ms: typeof context.retryAfterMs === "number" ? context.retryAfterMs : null,
      };
    }
    deps.quota().ingest(source.credentialHarness, event);
    unusable.observeEvent(source.credentialHarness, event);
    if (problem?.code === "auth_required") {
      const observation = await differentialSubjectVerdict({
        harnessId: source.credentialHarness,
        profile,
        model: model ?? null,
        quota: deps.quota().read(),
        transients: [
          {
            kind: "unknown",
            category: "auth_failed",
            retryable: false,
            retryDelayMs: null,
            httpStatus: null,
            signal: null,
            adapterCode: "auth_required",
          },
        ],
      });
      if (observation) unusable.record(observation);
    }
  };

  const operations = new ModelOperations({
    commands: deps.commands,
    resources: deps.resources,
    warn: deps.warn,
    enqueue: ({ request, ...options }) => deps.client.enqueue(request, options),
    cancel: (id, reason) => deps.client.cancel(id, reason),
    resolve: async (request, signal) => {
      const source = getSource(request.source);
      const { profile, catalog } = await resolve(source, request.account, request.model, signal);
      return {
        profile,
        adapter: {
          ...source.adapter,
          invoke: async (input, context) => {
            const result = await source.adapter.invoke(input, { ...context, catalog });
            // Evidence maintenance must not erase an already-received model result.
            try {
              await observe(source, profile, result.problem, result.usage, result.route.model);
            } catch (error) {
              deps.warn?.(`Model quota evidence was not recorded: ${redactSecrets(String(error))}`);
            }
            return result;
          },
        },
      };
    },
  });
  return {
    operations,
    routes: {
      modelSources: async () => ({
        sources: sources.map(({ adapter, label, credentialHarness }) => ({
          id: adapter.id,
          label,
          credentialHarness,
        })),
      }),
      modelCatalog: async (
        sourceId: string,
        credentialProfileId?: string,
        requestedModel?: string,
      ) =>
        (
          await resolve(
            getSource(sourceId),
            credentialProfileId
              ? { mode: "pin", profileId: credentialProfileId }
              : { mode: "auto" },
            requestedModel ?? null,
            lifetime.signal,
          )
        ).catalog,
      createModelOperation: operations.create.bind(operations),
      getModelOperation: async (id: string) => operations.inspect(id),
      readModelResult: async (id: string) => operations.readResult(id),
      acknowledgeModelResult: async (id: string, sha256: string) =>
        operations.acknowledge(id, sha256),
      cancelModelOperation: operations.cancel.bind(operations),
    },
    withRetention:
      (run: RetentionRunner): RetentionRunner =>
      async (request) => {
        const receipt = await run(request);
        const modelPayloads = operations.reconcileResources(request.dry_run);
        receipt.errors.push(...modelPayloads.errors);
        if (request.model_payload_report) receipt.model_payloads = modelPayloads;
        return receipt;
      },
    close: () => {
      lifetime.abort("host_cancelled");
      operations.close();
    },
  };
}

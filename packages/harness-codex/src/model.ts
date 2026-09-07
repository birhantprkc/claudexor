import { validateModel, type ModelAdapter, type ModelAdapterContext } from "@claudexor/core";
import type { ControlModelCatalogResponse, ModelCatalogEntry, ModelRoute } from "@claudexor/schema";
import { CLAUDEXOR_VERSION } from "@claudexor/util";
import {
  prepareCodexModelAuth,
  type CodexModelAuth,
  type CodexModelAuthDeps,
} from "./model-auth.js";
import {
  buildResponsesRequest,
  CodexModelError,
  emptyModelResult,
  providerProblem,
  readResponsesStream,
  record,
  text,
  validateCodexModelOptions,
} from "./responses.js";
import { CODEX_VENDOR_CLI_VERSION } from "./vendor-cli-version.js";

const ENDPOINT = "https://chatgpt.com/backend-api/codex";
const CLIENT = "claudexor";

export interface CodexModelAdapterDeps extends CodexModelAuthDeps {
  fetch?: typeof fetch;
}

function headers(auth: CodexModelAuth): Record<string, string> {
  return {
    Authorization: `Bearer ${auth.accessToken}`,
    "ChatGPT-Account-ID": auth.accountId,
    "Content-Type": "application/json",
    originator: CLIENT,
    "User-Agent": `${CLIENT}/${CLAUDEXOR_VERSION}`,
  };
}

function capacity(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** An expired/opaque access token's 401 is not proof that a new login is needed. */
function authenticatedProblem(
  response: Response,
  body: unknown,
  auth: CodexModelAuth,
  now: number,
) {
  const problem = providerProblem(response.status, body, response.headers);
  return response.status === 401 && (auth.expiresAt === null || auth.expiresAt <= now)
    ? new CodexModelError(
        "auth_refresh_failed",
        "Codex refused access credentials whose freshness could not be confirmed.",
        problem.context,
      ).problem
    : problem;
}

/** Exact backend metadata only; no CLI alias list, compaction limit, or historical default. */
export function parseCodexModelCatalog(value: unknown): ModelCatalogEntry[] {
  const models = record(value)?.models;
  if (!Array.isArray(models))
    throw new CodexModelError("catalog_unavailable", "Codex did not return a model catalog.");
  // Mirror ModelsManager::build_available_models + mark_default_by_picker_visibility
  // using THIS account's metadata. Incomplete metadata does not invent a default.
  const hasPriority = models.every((value) => {
    const item = record(value);
    return (
      Number.isSafeInteger(item?.priority) &&
      ["list", "hide", "none"].includes(String(item?.visibility))
    );
  });
  const ordered = hasPriority
    ? [...models].sort((a, b) => Number(record(a)?.priority) - Number(record(b)?.priority))
    : models;
  const defaultEntry = hasPriority
    ? (ordered.find((value) => record(value)?.visibility === "list") ?? ordered[0])
    : null;
  return ordered.map((value) => {
    const entry = record(value),
      id = text(entry?.slug);
    if (!entry || !id)
      throw new CodexModelError(
        "catalog_unavailable",
        "Codex returned an invalid model catalog entry.",
      );
    const efforts = Array.isArray(entry.supported_reasoning_levels)
      ? entry.supported_reasoning_levels
          .map((item) => text(record(item)?.effort))
          .filter((item): item is string => item !== null)
      : [];
    const modalities = Array.isArray(entry.input_modalities)
      ? entry.input_modalities.filter((item): item is string => typeof item === "string")
      : [];
    return {
      id,
      label: text(entry.display_name),
      isDefault: value === defaultEntry,
      contextWindow: capacity(entry.context_window),
      maxContextWindow: capacity(entry.max_context_window),
      // Backend output-cap parameters are unsupported even when a model has a published output capacity.
      maxOutputTokens: capacity(entry.max_output_tokens),
      inputModalities: modalities,
      reasoningEfforts: efforts,
      defaultReasoningEffort: text(entry.default_reasoning_level),
      supportedOptions: [
        "toolChoice",
        "cacheKey",
        "serviceTier",
        ...(efforts.length ? ["reasoningEffort"] : []),
        ...(entry.supports_parallel_tool_calls === true ? ["parallelToolCalls"] : []),
      ],
    };
  });
}

async function catalogFor(
  auth: CodexModelAuth,
  context: Omit<ModelAdapterContext, "onDispatch">,
  fetcher: typeof fetch,
  now: () => number,
): Promise<ControlModelCatalogResponse> {
  context.signal.throwIfAborted();
  let response: Response;
  try {
    response = await fetcher(`${ENDPOINT}/models?client_version=${CODEX_VENDOR_CLI_VERSION}`, {
      headers: headers(auth),
      signal: context.signal,
      redirect: "error",
    });
  } catch {
    context.signal.throwIfAborted();
    throw new CodexModelError(
      "catalog_unavailable",
      "The selected Codex account's catalog could not be reached.",
      {},
      true,
    );
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    if (response.ok)
      throw new CodexModelError(
        "catalog_unavailable",
        "Codex returned an unreadable model catalog.",
      );
  }
  if (!response.ok) {
    const problem = authenticatedProblem(response, body, auth, now());
    const code = problem.code === "provider_failed" ? "catalog_unavailable" : problem.code;
    throw new CodexModelError(code, problem.message, problem.context, problem.retryable);
  }
  return {
    source: "codex",
    credentialProfileId: context.profile.profile_id,
    accountFingerprint: auth.accountFingerprint,
    observedAt: new Date(now()).toISOString(),
    provenance: `codex.backend.models; client_version=${CODEX_VENDOR_CLI_VERSION}; default=vendor-priority-and-visibility`,
    models: parseCodexModelCatalog(body),
  };
}

/** One adapter-owned generation, with the official CLI owning token refresh. */
export function createCodexModelAdapter(deps: CodexModelAdapterDeps = {}): ModelAdapter {
  const fetcher = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? Date.now;
  return {
    id: "codex",
    async catalog(context) {
      const auth = await prepareCodexModelAuth(context.profile, context.signal, deps);
      return catalogFor(auth, context, fetcher, now);
    },
    async invoke(request, context) {
      let route: ModelRoute = {
        source: "codex",
        credentialProfileId: context.profile.profile_id,
        accountFingerprint: null,
        model: request.model,
      };
      let dispatched = false;
      try {
        if (
          request.source !== "codex" ||
          (request.account.mode === "pin" &&
            request.account.profileId !== context.profile.profile_id)
        ) {
          throw new CodexModelError(
            "invalid_request",
            "The selected profile does not match the requested Codex route.",
          );
        }
        // Refuse unsupported explicit options before auth helpers, catalog I/O, or dispatch.
        validateCodexModelOptions(request.options);
        const auth = await prepareCodexModelAuth(context.profile, context.signal, deps);
        route = { ...route, accountFingerprint: auth.accountFingerprint };
        const discovered = context.catalog;
        if (
          discovered &&
          (discovered.source !== route.source ||
            discovered.credentialProfileId !== route.credentialProfileId ||
            discovered.accountFingerprint !== auth.accountFingerprint)
        )
          throw new CodexModelError(
            "auth_changed",
            "The managed Codex account changed after model discovery.",
          );
        // The caller may hand off this operation's exact-account catalog.
        // Unknown identity cannot authorize reuse, but remains a usable route:
        // obtain fresh metadata rather than inventing a fingerprint or a limit.
        const catalog = discovered?.accountFingerprint
          ? discovered
          : await catalogFor(auth, context, fetcher, now);
        const checked = validateModel(
          request.model,
          catalog.models.map((model) => model.id),
          "api",
        );
        const model = catalog.models.find((entry) => entry.id === request.model);
        if (checked.status !== "ok" || !model)
          throw new CodexModelError(
            "model_unavailable",
            "The requested model is not in this account's Codex model catalog.",
          );
        if (
          request.options.reasoningEffort &&
          !model.reasoningEfforts.includes(request.options.reasoningEffort)
        ) {
          throw new CodexModelError(
            "unsupported_parameter",
            "The requested reasoning effort is not advertised for this model.",
            { parameter: "reasoningEffort" },
          );
        }
        const body = JSON.stringify(buildResponsesRequest(request, route));
        const requestHeaders = new Headers(headers(auth));
        if (request.options.cacheKey !== undefined) {
          try {
            requestHeaders.set("session_id", request.options.cacheKey);
          } catch {
            throw new CodexModelError(
              "unsupported_parameter",
              "The requested cacheKey cannot be represented in a Codex HTTP header.",
              { parameter: "cacheKey" },
            );
          }
        }
        // HTTP header validation is preparation, not evidence of a physical send.
        context.signal.throwIfAborted();
        await context.onDispatch(route);
        dispatched = true;
        const response = await fetcher(`${ENDPOINT}/responses`, {
          method: "POST",
          headers: requestHeaders,
          body,
          signal: context.signal,
          redirect: "error",
        });
        if (!response.ok) {
          const result = emptyModelResult({ ...route, model: null });
          let error: unknown = null;
          try {
            error = await response.json();
          } catch {
            /* HTTP status remains an authoritative refusal. */
          }
          result.problem = authenticatedProblem(response, error, auth, now());
          return result;
        }
        return await readResponsesStream(response, route);
      } catch (error) {
        const result = emptyModelResult({ ...route, model: null });
        result.outcome = dispatched ? "unknown" : "failed";
        result.problem =
          error instanceof CodexModelError
            ? error.problem
            : new CodexModelError(
                dispatched
                  ? "transport_unknown"
                  : context.signal.aborted
                    ? "cancelled"
                    : "model_unavailable",
                dispatched
                  ? "The Codex generation outcome is unknown; it was not retried."
                  : context.signal.aborted
                    ? "The model operation was cancelled before dispatch."
                    : "The Codex model request could not be prepared.",
              ).problem;
        return result;
      }
    },
  };
}

export interface ChatResult {
  text: string;
  diagnostic_text: string | null;
  finish_reason: string | null;
  provider_error: ParsedProviderError | null;
  model: string | null;
  usage: { input_tokens?: number; output_tokens?: number; provider_cost?: number };
}

export interface ParsedProviderError {
  code: number;
  message: string;
  error_type: string | null;
  provider_code: string | null;
}

export interface ParsedModel {
  id: string;
  label: string | null;
  context_window: number | null;
}

/**
 * Parse an OpenAI-compatible `GET /v1/models` response: `{ data: [{ id, ... }] }`.
 * Only `id` is guaranteed by the OpenAI shape; `context_window`/`label` are
 * populated opportunistically (some compatible providers, e.g. OpenRouter,
 * carry richer fields). Entries without a usable string `id` are dropped.
 */
export function parseModelsList(json: any): ParsedModel[] {
  const data = Array.isArray(json?.data) ? json.data : [];
  const out: ParsedModel[] = [];
  for (const entry of data) {
    const id = typeof entry?.id === "string" ? entry.id : null;
    if (!id) continue;
    const label = typeof entry?.name === "string" ? entry.name : null;
    const ctxRaw = entry?.context_length ?? entry?.context_window;
    const context_window =
      typeof ctxRaw === "number" && Number.isInteger(ctxRaw) && ctxRaw > 0 ? ctxRaw : null;
    out.push({ id, label, context_window });
  }
  return out;
}

/** Parse an OpenAI-compatible /chat/completions response. */
export function parseChatCompletion(json: any): ChatResult {
  const choice = json?.choices?.[0];
  const content = choice?.message?.content;
  const text = String(content ?? "");
  const usage = json?.usage ?? {};
  const providerCost =
    typeof usage.cost === "number" && Number.isFinite(usage.cost) && usage.cost >= 0
      ? usage.cost
      : undefined;
  return {
    text,
    diagnostic_text: typeof content === "string" ? content : null,
    finish_reason: typeof choice?.finish_reason === "string" ? choice.finish_reason : null,
    provider_error: parseProviderError(choice?.error),
    model: typeof json?.model === "string" ? json.model : null,
    usage: {
      input_tokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : undefined,
      output_tokens:
        typeof usage.completion_tokens === "number" ? usage.completion_tokens : undefined,
      ...(providerCost === undefined ? {} : { provider_cost: providerCost }),
    },
  };
}

function parseProviderError(value: unknown): ParsedProviderError | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const error = value as Record<string, unknown>;
  if (typeof error["code"] !== "number" || !Number.isFinite(error["code"])) return null;
  if (typeof error["message"] !== "string") return null;

  const metadata =
    error["metadata"] && typeof error["metadata"] === "object" && !Array.isArray(error["metadata"])
      ? (error["metadata"] as Record<string, unknown>)
      : null;
  return {
    code: error["code"],
    message: error["message"],
    error_type: typeof metadata?.["error_type"] === "string" ? metadata["error_type"] : null,
    provider_code:
      typeof metadata?.["provider_code"] === "string" ? metadata["provider_code"] : null,
  };
}

import type { HarnessEvent } from "@claudexor/schema";
import { normalizeRetryDelayMs, redactSecrets } from "@claudexor/util";

const CLAUDE_TRANSIENT_RE =
  /overloaded|temporar(?:y|ily) unavailable|network|econnreset|etimedout|enotfound|eai_again|stream/i;
const CLAUDE_RETRY_CATEGORIES = new Set([
  "authentication_failed",
  "oauth_org_not_allowed",
  "billing_error",
  "rate_limit",
  "overloaded",
  "invalid_request",
  "model_not_found",
  "server_error",
  "max_output_tokens",
  "unknown",
]);

/** Translate Claude's native retry frame into the shared typed retry signals. */
export function claudeApiRetryEvents(
  obj: Record<string, unknown>,
  sessionId: string,
  ts: string,
): HarnessEvent[] {
  const errText = String(obj["error"] ?? "");
  const retryDelayMs = normalizeRetryDelayMs(obj["retry_delay_ms"]);
  const event: HarnessEvent = {
    type: "status",
    session_id: sessionId,
    ts,
    text: `api_retry: ${redactSecrets(errText).slice(0, 500)}`,
    status: {
      kind: "api_retry",
      attempt: nonnegativeSafeIntegerOrUndef(obj["attempt"]),
      max_retries: nonnegativeSafeIntegerOrUndef(obj["max_retries"]),
      ...(retryDelayMs === null ? {} : { retry_delay_ms: retryDelayMs }),
      error_category: claudeRetryCategory(obj["error"]),
    },
    payload: { api_retry: true, retry_delay_ms: retryDelayMs },
  };
  if (/rate.?limit|overloaded|too many requests|quota/i.test(errText)) {
    event.rate_limit = { resets_at: null, retry_delay_ms: retryDelayMs };
  }
  if (CLAUDE_TRANSIENT_RE.test(errText)) {
    event.transient = {
      kind: /overloaded|temporar(?:y|ily) unavailable/i.test(errText)
        ? "service_unavailable"
        : "network",
      retry_delay_ms: retryDelayMs,
    };
  }
  return [event];
}

function nonnegativeSafeIntegerOrUndef(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function claudeRetryCategory(
  raw: unknown,
):
  | "authentication_failed"
  | "oauth_org_not_allowed"
  | "billing_error"
  | "rate_limit"
  | "overloaded"
  | "invalid_request"
  | "model_not_found"
  | "server_error"
  | "max_output_tokens"
  | "unknown"
  | undefined {
  if (raw === undefined || raw === null) return undefined;
  const value = String(raw);
  if (CLAUDE_RETRY_CATEGORIES.has(value)) return value as ReturnType<typeof claudeRetryCategory>;
  if (/rate.?limit|too many requests|(?:^|\D)429(?:\D|$)/i.test(value)) return "rate_limit";
  if (/overloaded|(?:^|\D)529(?:\D|$)/i.test(value)) return "overloaded";
  if (/authentication|unauthorized|(?:^|\D)401(?:\D|$)/i.test(value))
    return "authentication_failed";
  if (/oauth.*org|org.*not.*allowed/i.test(value)) return "oauth_org_not_allowed";
  if (/billing|payment|credit balance|(?:^|\D)402(?:\D|$)/i.test(value)) return "billing_error";
  if (/model.{0,20}not.{0,10}found/i.test(value)) return "model_not_found";
  if (/max.?output.?tokens/i.test(value)) return "max_output_tokens";
  if (/invalid.?request|(?:^|\D)400(?:\D|$)/i.test(value)) return "invalid_request";
  if (/internal server error|server.?error|(?:^|\D)5\d\d(?:\D|$)/i.test(value))
    return "server_error";
  return "unknown";
}

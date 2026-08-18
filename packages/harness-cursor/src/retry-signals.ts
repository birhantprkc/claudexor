import type { HarnessEvent } from "@claudexor/schema";

/**
 * Cursor vendor-limit classification (A1). cursor-agent has NO typed
 * rate-limit frame: hitting the subscription's usage limit surfaces as PROSE —
 * live incident 2026-08-17: `ActionRequiredError: You've hit your usage limit
 * You've saved $567 on API model usage this month with Ultra. Switch to a
 * different model or set a Spend Limit to continue with Gemini. Your usage
 * limits will reset when your monthly cycle ends on 9/12/2026.` — delivered on
 * stderr with exit 1 (and potentially as `error` / non-success `result`
 * frames). Without a typed `rate_limit` signal the orchestrator's reactive
 * credential rotation is structurally impossible for cursor, so the vendor
 * limit died as a generic `harness_error` while ready sibling profiles idled.
 *
 * This module mirrors harness-codex/src/retry-signals.ts: pure classifiers the
 * parse layer applies to failure prose. No orchestration logic lives here.
 */
// Deliberately NOT keyed on the bare `ActionRequiredError` wrapper: cursor
// uses that class for other required actions too (e.g. re-login), and
// mislabeling an auth failure as a rate limit would corrupt the typed
// taxonomy. The limit-specific prose is what classifies. Word boundaries
// keep substrings honest: "code 4290" is not a 429, and narrative gerunds
// ("docs about rate limiting") are prose ABOUT limits, not a limit verdict —
// vendor limit prose says "rate limit(s)/limited", never "limiting".
const CURSOR_VENDOR_LIMIT_RE =
  /\busage.?limits?\b|\brate.?limit(?:s|ed)?\b|\btoo many requests\b|\bquota[ _-]?(?:exceeded|exhausted|reached)\b|\b(?:http|status|code)[ :/]?429\b|\b429 too many\b/i;

/**
 * `resets when your monthly cycle ends on M/D/YYYY` — the vendor states the
 * reset at DAY granularity in US month-first order (cursor.com billing copy)
 * with no timezone or time of day.
 */
const CURSOR_RESET_DAY_RE = /reset(?:s)?\b[^.]*?\bon (\d{1,2})\/(\d{1,2})\/(\d{4})/i;

/**
 * Extract the vendor's day-granular reset date as `YYYY-MM-DD`, or null when
 * the prose names none (or names an implausible calendar day).
 */
export function cursorVendorResetDay(message: string): string | null {
  const match = CURSOR_RESET_DAY_RE.exec(message);
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${match[3]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Classify cursor vendor-limit prose onto the typed `rate_limit` signal.
 * Returns true when the message matched (the event was enriched).
 *
 * - `resets_at` stays null on purpose: the vendor reports the reset at DAY
 *   granularity with unknown timezone, and fabricating a precise ISO instant
 *   (e.g. an invented midnight) would overclaim. The parsed day rides as
 *   payload evidence instead; downstream cooldown TTL bounds apply.
 * - `applies_to_models` is scoped to the REQUESTED model of THIS run — an
 *   operational rejection scope. The prose names the billing pool ("…continue
 *   with Gemini" = Cursor's usage-based pool, not a per-model quota), and a
 *   sibling model that still rides free on the same account (the live grok
 *   lane) must never be cooled by it. A vendor-asserted per-model quota is
 *   deliberately NOT claimed. With no model identity at all the signal stays
 *   account-scoped (null = the schema's honest "every model").
 * - `status.error_category: "rate_limit"` carries the typed retry class
 *   (fixture `retry_class` contract). `kind: "api_retry"` is the only status
 *   kind the frozen schema carries today; consumers read only
 *   `error_category` (orchestrator attemptTelemetry / transientClassify), and
 *   a dedicated kind would be a schema change that is out of A1 scope.
 */
export function applyCursorVendorLimit(
  event: HarnessEvent,
  message: string,
  scopeModel?: string | null,
): boolean {
  if (!CURSOR_VENDOR_LIMIT_RE.test(message)) return false;
  const resetDay = cursorVendorResetDay(message);
  event.rate_limit = {
    resets_at: null,
    retry_delay_ms: null,
    applies_to_models: scopeModel ? [scopeModel] : null,
  };
  event.status = { kind: "api_retry", error_category: "rate_limit" };
  event.payload = {
    ...(event.payload ?? {}),
    cursor_vendor_limit: true,
    ...(resetDay ? { vendor_reset_day: resetDay, vendor_reset_granularity: "day" } : {}),
  };
  return true;
}

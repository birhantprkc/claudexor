import type { QuotaRefresher } from "@claudexor/daemon";
import type { QuotaSource } from "@claudexor/schema";
import { refreshClaudeOauthUsageQuota } from "./claude-oauth-usage.js";
import { refreshClaudeStatuslineQuota } from "./claude-statusline.js";
import { refreshCodexQuota } from "./codex-quota-source.js";

export interface QuotaRefresherRegistration {
  readonly source: QuotaSource;
  readonly refresh: QuotaRefresher;
}

/** The daemon's top-level refreshers and the source each owns. Schema traits
 * independently declare which sources must appear here; the parity test keeps
 * composition and vocabulary in lockstep. */
export const QUOTA_REFRESHER_REGISTRATIONS = [
  { source: "codex_app_server", refresh: refreshCodexQuota },
  { source: "claude_statusline", refresh: refreshClaudeStatuslineQuota },
  { source: "claude_oauth_usage", refresh: () => refreshClaudeOauthUsageQuota() },
] as const satisfies readonly QuotaRefresherRegistration[];

export function quotaRefreshers(): QuotaRefresher[] {
  return QUOTA_REFRESHER_REGISTRATIONS.map((registration) => registration.refresh);
}

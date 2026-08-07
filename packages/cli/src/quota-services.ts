/** /v2/quota control services over the daemon's QuotaRegistry. */
import type { QuotaRegistry } from "@claudexor/daemon";
import { ControlQuotaRefreshRequest, withQuotaAvailability } from "@claudexor/schema";

/** Bind GET/POST /v2/quota to the registry. Both routes decorate each snapshot
 * with the derived model-aware availability projection at the response
 * boundary; the registry's own read()/journal/projection-signature stay
 * byte-identical, and surfaces embedding raw snapshots (Accounts snapshot)
 * are untouched. POST accepts an optional model to compute state against. */
export function quotaControlServices(quotaRegistry: () => QuotaRegistry) {
  return {
    quota: async () => withQuotaAvailability(quotaRegistry().read()),
    refreshQuota: async (input?: unknown) => {
      const request = ControlQuotaRefreshRequest.parse(input ?? {});
      return withQuotaAvailability(await quotaRegistry().refresh(), { model: request.model });
    },
  };
}

import type { BudgetLedger } from "@claudexor/budget";
import type { EventLog } from "@claudexor/event-log";
import type { DelegationBudgetAuthority } from "./delegationBudgetAuthority.js";
import type { RoutedAdapter, RunInput } from "./orchestrator.js";

export function activateDelegationParent(
  authority: DelegationBudgetAuthority | undefined,
  input: RunInput,
  runId: string,
  ledger: BudgetLedger,
  routes: readonly RoutedAdapter[],
  log: EventLog,
): void {
  if (input.delegate !== true || !routes.some((route) => route.delegationRequirement.effective))
    return;
  if (!authority) {
    throw Object.assign(new Error("effective Delegate requires daemon-lifetime budget authority"), {
      code: "delegation_budget_authority_unavailable",
      status: 503,
    });
  }
  authority.registerParent(runId, ledger);
  log.deferTerminal();
}

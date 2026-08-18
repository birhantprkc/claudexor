/**
 * ONE construction owner for the daemon's per-run Orchestrator, hoisted from
 * `claudexord` so the credential-evidence wiring (A7) lives beside the quota
 * wiring it siblings: the same event stream that feeds the quota registry
 * feeds the unusable-credential ledger's success-clearing, and the same deps
 * boundary that injects quota snapshots injects the ledger's observations.
 */
import { CredentialUnusableLedger, type QuotaRegistry } from "@claudexor/daemon";
import { Orchestrator } from "@claudexor/orchestrator";
import type { normalizeRunStartRequest } from "@claudexor/control-api";
import { buildRegistry } from "./registry.js";

/**
 * Daemon-lifetime typed `credential_unusable` evidence (A7): in-memory and
 * bounded by design — the poller re-derives vendor rejections within a cycle
 * after a restart, and a restart usually follows the re-login that heals a
 * dead credential. `claudexord` clears it on credential-generation changes.
 */
export const credentialUnusableLedger = new CredentialUnusableLedger();

type OrchestratorDeps = ConstructorParameters<typeof Orchestrator>[0];

export function buildRunOrchestrator(args: {
  p: ReturnType<typeof normalizeRunStartRequest>;
  delegationBudgetAuthority: OrchestratorDeps["delegationBudgetAuthority"];
  quotaStore: () => QuotaRegistry;
  /** Typed per-harness refusal while a unified-accounts migration is
   * incomplete (a crash between phases) — other harnesses keep working. */
  accountsMigrationGate?: OrchestratorDeps["accountsMigrationGate"];
}): Orchestrator {
  const { p, quotaStore } = args;
  return new Orchestrator({
    registry: buildRegistry(),
    delegationBudgetAuthority: args.delegationBudgetAuthority,
    accountsMigrationGate: args.accountsMigrationGate,
    routingGoal: p.routingGoal,
    quotaSnapshots: () => quotaStore().read().snapshots,
    // The absence half of the SAME projection: `auth_revoked` is how the
    // poller reports a vendor rejecting a profile's credential, and run
    // admission is the surface that has to act on it.
    quotaAbsences: () => quotaStore().read().absences,
    quotaEventSink: (harnessId, event) => {
      quotaStore().ingest(harnessId, event);
      // The same stream is the ledger's success telemetry: served tokens on a
      // subject clear its stale dead-credential verdicts (clearing contract).
      credentialUnusableLedger.observeEvent(harnessId, event);
    },
    credentialUnusable: () => credentialUnusableLedger.live(),
    recordCredentialUnusable: (obs) => credentialUnusableLedger.record(obs),
    reviewerPanel: p.reviewerPanel,
    reviewerModels:
      p.reviewerModels && typeof p.reviewerModels === "object" ? p.reviewerModels : undefined,
    reviewerEfforts:
      p.reviewerEfforts && typeof p.reviewerEfforts === "object" ? p.reviewerEfforts : undefined,
  });
}

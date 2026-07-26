import {
  projectApplyEligibility,
  projectOutcomeBanner,
  projectRunLineage,
} from "./run-detail-projections.js";

export interface DelegationReceipt {
  requested?: boolean;
  effective?: boolean;
  used?: boolean;
  reason?: string | null;
  remediation?: string | null;
}

export function projectDelegation(
  detail: Record<string, unknown> | null,
): DelegationReceipt | null {
  return projectRunLineage(detail).delegation as DelegationReceipt | null;
}

export function terminalDetailFields(detail: Record<string, unknown> | null): {
  outcomeBanner?: string;
  delegation?: DelegationReceipt;
  applyEligibility?: Record<string, unknown>;
} {
  const outcomeBanner = projectOutcomeBanner(detail);
  const delegation = projectDelegation(detail);
  const applyEligibility = projectApplyEligibility(detail);
  return {
    ...(outcomeBanner ? { outcomeBanner } : {}),
    ...(delegation ? { delegation } : {}),
    ...(applyEligibility ? { applyEligibility } : {}),
  };
}

export function terminalDelegationLines(receipt: DelegationReceipt | null): string[] {
  if (receipt?.requested !== true) return [];
  const partiallyDegraded = receipt.reason === "partially_degraded";
  return [
    `  delegation: effective=${String(receipt.effective)} used=${String(receipt.used)} reason=${String(receipt.reason ?? "unknown")}`,
    ...(receipt.effective === true && !partiallyDegraded
      ? []
      : [
          partiallyDegraded
            ? "  WARNING: one selected lane continued without Delegate; inspect its typed requirement receipt."
            : "  WARNING: continued without Delegate; inspect the run for the typed cause.",
        ]),
  ];
}

export function inspectDelegationLines(receipt: DelegationReceipt | null): string[] {
  if (!receipt) return [];
  const lines = [
    `delegation: requested=${String(receipt.requested)} effective=${String(receipt.effective)} used=${String(receipt.used)} reason=${String(receipt.reason ?? "unknown")}`,
  ];
  if (receipt.requested && (!receipt.effective || receipt.reason === "partially_degraded")) {
    lines.push(
      receipt.reason === "partially_degraded"
        ? "WARNING: Delegate was unavailable on one selected lane; that lane continued as ordinary Agent."
        : `WARNING: Delegate was unavailable; this run continued as ordinary Agent (${receipt.reason ?? "unknown"}).`,
    );
    if (receipt.remediation) lines.push(`  next: ${receipt.remediation}`);
  }
  return lines;
}

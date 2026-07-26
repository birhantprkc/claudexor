const READY_STATUSES = new Set(["connected", "ready", "ok"]);
const PENDING_STATUSES = new Set(["pending", "connecting", "starting"]);

/**
 * Project Claude's init snapshot onto fail-closed receipts for required servers.
 *
 * Claude Code starts inline MCP servers asynchronously and can emit its init
 * frame while a healthy stdio server is still `pending`. That is positive
 * startup-in-progress evidence, not a terminal failure. Preserve it so the
 * connection can finish; an absent server or any non-ready, non-pending status
 * remains a hard startup failure, and a later attempted-tool failure remains a
 * hard harness failure through the ordinary tool-result path.
 */
export function requiredMcpStartupReceipts(
  raw: unknown,
  required: ReadonlySet<string>,
): { servers: unknown; failed: string[] } {
  if (required.size === 0) return { servers: raw, failed: [] };
  const servers = Array.isArray(raw) ? [...raw] : [];
  const failed: string[] = [];
  for (const name of required) {
    const index = servers.findIndex(
      (entry) =>
        !!entry && typeof entry === "object" && (entry as { name?: unknown }).name === name,
    );
    const entry = index >= 0 ? servers[index] : null;
    const status =
      entry &&
      typeof entry === "object" &&
      typeof (entry as { status?: unknown }).status === "string"
        ? (entry as { status: string }).status.toLowerCase()
        : "";
    if (READY_STATUSES.has(status) || PENDING_STATUSES.has(status)) continue;
    failed.push(name);
    const failedReceipt = {
      ...(entry && typeof entry === "object" ? entry : {}),
      name,
      status: "failed",
    };
    if (index >= 0) servers[index] = failedReceipt;
    else servers.push(failedReceipt);
  }
  return { servers, failed };
}

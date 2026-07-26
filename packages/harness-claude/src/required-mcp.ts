/** Project Claude's init snapshot onto fail-closed receipts for required servers. */
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
    if (["connected", "ready", "ok"].includes(status)) continue;
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

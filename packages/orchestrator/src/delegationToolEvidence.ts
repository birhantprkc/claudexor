import type { HarnessEvent } from "@claudexor/schema";
import type { AttemptTelemetry } from "./attemptTelemetry.js";

/** The required belt server failed after injection. A ready/pending-but-unused
 * belt is not unavailable; the harness remains free to solve the turn itself. */
export function delegationBeltUnavailable(t: AttemptTelemetry): boolean {
  return t.delegationBelt.requested && t.delegationBelt.failed;
}

/** An exact injected belt operation failed and has not recovered through the
 * same tool+kind+target success. INV-030 makes this a required-capability hard
 * failure while reusing INV-043's recovery key; it does not rewrite the
 * startup-only `delegation_belt.failed` receipt or the run-level `used` fact. */
export function delegationBeltToolFailure(t: AttemptTelemetry): boolean {
  if (!t.delegationBelt.requested) return false;
  const serverName = t.delegationBelt.serverName;
  if (!serverName) return false;
  return t.toolErrors.some(
    (error) =>
      !error.recovered &&
      isDelegationBeltTool(
        {
          name: error.tool,
          kind: error.kind,
          ...(error.target !== null ? { target: error.target } : {}),
        },
        serverName,
      ),
  );
}

/** Record a non-error terminal shape that is nevertheless failure for the
 * required belt. The caller has already proven this is the exact belt tool. */
export function recordDelegationBeltResultFailure(
  t: AttemptTelemetry,
  tool: NonNullable<HarnessEvent["tool"]>,
  summary: string,
): void {
  t.toolErrors.push({
    tool: tool.name,
    kind: tool.kind,
    target: tool.target ?? null,
    summary,
    toolUseId: tool.use_id ?? null,
    recovered: false,
  });
}

/** Exact adapter-neutral belt evidence. Claude namespaces the normalized tool
 * name as `mcp__server__tool`; Codex keeps the native tool name and records the
 * server boundary in `target` as `server:tool`. Delimiters are mandatory so a
 * similarly-prefixed foreign server cannot satisfy Delegate used=true. */
export function isDelegationBeltTool(
  tool: HarnessEvent["tool"] | undefined,
  serverName: string,
): boolean {
  if (!tool || tool.kind !== "mcp") return false;
  return (
    tool.name.startsWith(`mcp__${serverName}__`) ||
    (typeof tool.target === "string" && tool.target.startsWith(`${serverName}:`))
  );
}

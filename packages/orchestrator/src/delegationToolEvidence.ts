import type { HarnessEvent } from "@claudexor/schema";
import type { AttemptTelemetry } from "./attemptTelemetry.js";

/** The required belt failed after injection. A ready-but-unused belt is not
 * unavailable; the harness remains free to solve the turn itself. */
export function delegationBeltUnavailable(t: AttemptTelemetry): boolean {
  return t.delegationBelt.requested && t.delegationBelt.failed;
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

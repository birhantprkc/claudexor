import { DelegationCapability, type HarnessManifest } from "@claudexor/schema";
import { resolveDaemonEntry } from "./delegation-belt-descriptor.js";

/** One producer for the installed-runtime x harness Delegate capability. */
export function delegationCapabilityFor(
  manifest: HarnessManifest | null | undefined,
  runtimeAvailable = resolveDaemonEntry() !== undefined,
): DelegationCapability {
  const requiresFullAccess =
    manifest?.capability_profile.mcp_injection_requires_full_access ?? false;
  if (manifest?.capability_profile.mcp_injection !== true) {
    return DelegationCapability.parse({
      available: false,
      reason: "manifest_unsupported",
      remediation: "Choose a harness that supports Claudexor MCP injection.",
      requiresFullAccess,
    });
  }
  if (!runtimeAvailable) {
    return DelegationCapability.parse({
      available: false,
      reason: "runtime_unavailable",
      remediation: "Update or repair the Claudexor runtime to restore Delegate.",
      requiresFullAccess,
    });
  }
  return DelegationCapability.parse({
    available: true,
    reason: "ready",
    remediation: null,
    requiresFullAccess,
  });
}

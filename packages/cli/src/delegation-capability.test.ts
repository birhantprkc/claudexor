import { describe, expect, it } from "vitest";
import { HarnessManifest } from "@claudexor/schema";
import { delegationCapabilityFor } from "./delegation-capability.js";
import { RequestRequirementsResolver } from "@claudexor/orchestrator";

function manifest(injects: boolean, requiresFullAccess = false) {
  return HarnessManifest.parse({
    id: "fixture",
    display_name: "Fixture",
    kind: "local_cli",
    provider_family: "anthropic",
    capabilities: { implement: true },
    capability_profile: {
      mcp_injection: injects,
      mcp_injection_requires_full_access: requiresFullAccess,
    },
    access_profiles_supported: ["workspace_write", "external_sandbox_full"],
  });
}

describe("Delegate capability projection", () => {
  it("combines the packaged runtime and manifest through one typed producer", () => {
    expect(delegationCapabilityFor(manifest(true, true), true)).toEqual({
      available: true,
      reason: "ready",
      remediation: null,
      requiresFullAccess: true,
    });
    expect(delegationCapabilityFor(manifest(false), true)).toMatchObject({
      available: false,
      reason: "manifest_unsupported",
    });
    expect(delegationCapabilityFor(manifest(true), false)).toMatchObject({
      available: false,
      reason: "runtime_unavailable",
    });
    expect(delegationCapabilityFor(manifest(false), false)).toMatchObject({
      available: false,
      reason: "manifest_unsupported",
      remediation: expect.stringContaining("Choose a harness"),
    });
    expect(
      new RequestRequirementsResolver().resolveDelegation({
        harnessId: "fixture",
        requested: true,
        manifestCapable: false,
        runtimeAvailable: false,
        requiresFullAccess: false,
        fullAccess: false,
      }).reason,
    ).toBe(delegationCapabilityFor(manifest(false), false).reason);
  });
});

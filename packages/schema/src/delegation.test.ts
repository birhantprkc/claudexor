import { describe, expect, it } from "vitest";
import {
  DelegationCapability,
  RunDelegationInfo,
  delegationRemediationForReason,
} from "./delegation.js";

describe("Delegate cross-field contracts", () => {
  it("rejects impossible capability combinations", () => {
    expect(
      DelegationCapability.safeParse({
        available: true,
        reason: "runtime_unavailable",
        remediation: "repair",
        requiresFullAccess: false,
      }).success,
    ).toBe(false);
    expect(
      DelegationCapability.safeParse({
        available: false,
        reason: "ready",
        remediation: null,
        requiresFullAccess: false,
      }).success,
    ).toBe(false);
  });

  it("rejects impossible run receipts and mismatched remediation", () => {
    expect(
      RunDelegationInfo.safeParse({
        requested: false,
        effective: true,
        used: true,
        reason: "used",
        remediation: null,
      }).success,
    ).toBe(false);
    expect(
      RunDelegationInfo.safeParse({
        requested: true,
        effective: false,
        used: false,
        reason: "runtime_unavailable",
        remediation: null,
      }).success,
    ).toBe(false);
    expect(
      RunDelegationInfo.parse({
        requested: true,
        effective: false,
        used: false,
        reason: "runtime_unavailable",
        remediation: delegationRemediationForReason("runtime_unavailable"),
      }),
    ).toMatchObject({ reason: "runtime_unavailable" });
    for (const used of [false, true]) {
      expect(
        RunDelegationInfo.parse({
          requested: true,
          effective: true,
          used,
          reason: "partially_degraded",
          remediation: delegationRemediationForReason("partially_degraded"),
        }),
      ).toMatchObject({ reason: "partially_degraded", used });
    }
    expect(
      RunDelegationInfo.parse({
        requested: true,
        effective: true,
        used: true,
        reason: "startup_failed",
        remediation: delegationRemediationForReason("startup_failed"),
      }),
    ).toMatchObject({ reason: "startup_failed", used: true });
  });
});

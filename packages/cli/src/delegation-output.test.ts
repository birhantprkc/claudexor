import { describe, expect, it } from "vitest";
import { inspectDelegationLines, terminalDelegationLines } from "./delegation-output.js";

describe("Delegate terminal projection", () => {
  it("keeps a mixed-pool downgrade prominent even when another lane used Delegate", () => {
    const receipt = {
      requested: true,
      effective: true,
      used: true,
      reason: "partially_degraded",
      remediation: "Inspect the ordinary Agent lane.",
    };
    expect(terminalDelegationLines(receipt)).toContain(
      "  WARNING: one selected lane continued without Delegate; inspect its typed requirement receipt.",
    );
    expect(inspectDelegationLines(receipt)).toContain(
      "WARNING: Delegate was unavailable on one selected lane; that lane continued as ordinary Agent.",
    );
    expect(inspectDelegationLines(receipt)).toContain("  next: Inspect the ordinary Agent lane.");
  });
});

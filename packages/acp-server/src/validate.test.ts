import { describe, expect, it } from "vitest";
import { validateRunControls } from "./validate.js";

describe("ACP run-control applicability", () => {
  it.each(["ask", "plan"] as const)("rejects Agent-only controls on %s", (mode) => {
    expect(validateRunControls({ mode, reviewerPanel: [{ harness: "codex" }] })?.message).toMatch(
      /reviewerPanel.*Agent/i,
    );
    expect(
      validateRunControls({ mode, protectedPathApprovals: [{ path: "test/**" }] })?.message,
    ).toMatch(/protectedPathApprovals.*Agent/i);
  });

  it("accepts reviewers and approvals on Agent", () => {
    expect(
      validateRunControls({
        mode: "agent",
        reviewerPanel: [{ harness: "codex" }],
        protectedPathApprovals: [{ path: "test/**" }],
      }),
    ).toBeNull();
  });
});

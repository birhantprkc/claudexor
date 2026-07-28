import { describe, expect, it } from "vitest";
import { runControlApplicability, runStartStrategyViolations } from "./run-strategy.js";

describe("run-control applicability", () => {
  it.each(["ask", "plan"] as const)(
    "makes reviewers and protected-path approvals unavailable on %s",
    (mode) => {
      const applicability = runControlApplicability({ mode });
      expect(applicability.reviewerPanel).toMatchObject({ applicable: false });
      expect(applicability.protectedPathApprovals).toMatchObject({ applicable: false });
      expect(applicability.reviewerPanel.reason).toMatch(/Agent/);
      expect(applicability.protectedPathApprovals.reason).toMatch(/read-only/);
    },
  );

  it("keeps every review control applicable on Agent", () => {
    expect(runControlApplicability({ mode: "agent" })).toEqual({
      reviewerPanel: { applicable: true },
      protectedPathApprovals: { applicable: true },
    });
  });

  it.each(["ask", "plan"] as const)(
    "refuses every meaningful reviewer/approval representation on %s",
    (mode) => {
      const violations = runStartStrategyViolations({
        mode,
        reviewerPanel: [{ harness: "codex" }],
        reviewerModels: { openai: "gpt" },
        reviewerEfforts: { openai: "high" },
        protectedPathApprovals: [{ path: "test/**" }],
      });
      expect(violations).toEqual([
        expect.stringContaining("reviewerPanel"),
        expect.stringContaining("reviewerModels"),
        expect.stringContaining("reviewerEfforts"),
        expect.stringContaining("protectedPathApprovals"),
      ]);
    },
  );
});

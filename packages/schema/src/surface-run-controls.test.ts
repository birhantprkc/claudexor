import { describe, expect, it } from "vitest";
import { validateSurfaceRunControls } from "./surface-run-controls.js";

describe("surface run-control applicability", () => {
  it.each(["ask", "plan"] as const)("rejects Agent-only controls on %s", (mode) => {
    expect(validateSurfaceRunControls({ mode, reviewerPanel: [{ harness: "codex" }] })).toMatch(
      /reviewerPanel.*Agent/i,
    );
    expect(
      validateSurfaceRunControls({ mode, protectedPathApprovals: [{ path: "test/**" }] }),
    ).toMatch(/protectedPathApprovals.*Agent/i);
    expect(validateSurfaceRunControls({ mode, tests: [] })).toMatch(/tests.*agent/i);
  });

  it("projects Ask and Plan strategy applicability through the same owner", () => {
    expect(validateSurfaceRunControls({ mode: "agent", deepScan: true })).toMatch(/ask strategy/);
    expect(validateSurfaceRunControls({ mode: "ask", council: true })).toMatch(/plan strategy/);
    expect(validateSurfaceRunControls({ mode: "ask", deepScan: true })).toBeNull();
    expect(validateSurfaceRunControls({ mode: "plan", council: true })).toBeNull();
  });

  it("accepts the same controls on Agent", () => {
    expect(
      validateSurfaceRunControls({
        mode: "agent",
        reviewerPanel: [{ harness: "codex" }],
        protectedPathApprovals: [{ path: "test/**" }],
      }),
    ).toBeNull();
  });
});

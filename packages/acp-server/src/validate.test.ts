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
    expect(validateRunControls({ mode, tests: [] })?.message).toMatch(/tests.*agent/i);
  });

  it("rejects cross-mode Ask and Plan strategy fields at the ACP boundary", () => {
    expect(validateRunControls({ mode: "agent", deepScan: true })?.message).toMatch(/ask strategy/);
    expect(validateRunControls({ mode: "ask", council: true })?.message).toMatch(/plan strategy/);
    expect(validateRunControls({ mode: "ask", deepScan: true })).toBeNull();
    expect(validateRunControls({ mode: "plan", council: true })).toBeNull();
    expect(validateRunControls({ mode: "ask", race: true })?.message).toMatch(/Agent strategy/);
    expect(validateRunControls({ mode: "plan", race: true })?.message).toMatch(/Agent strategy/);
    expect(validateRunControls({ mode: "agent", race: true })).toBeNull();
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

  it("rejects inline secret fixtures with the typed ACP error code", () => {
    const rejected = validateRunControls({
      mode: "agent",
      prompt: `use sk-${"a".repeat(32)}`,
    });
    expect(rejected).toMatchObject({ code: "inline_secret_rejected" });
    expect(rejected?.message).toMatch(/secret-like/i);
  });
});

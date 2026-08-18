import { describe, expect, it } from "vitest";
import type { HarnessEvent } from "@claudexor/schema";
import { newAttemptOutputMarkers, observeAttemptOutputMarkers } from "./attemptOutputMarkers.js";
import { createAttemptTelemetry, observeAttemptTelemetry } from "./attemptTelemetry.js";

function ev(type: HarnessEvent["type"], extra: Partial<HarnessEvent> = {}): HarnessEvent {
  return { type, session_id: "s", ts: new Date().toISOString(), ...extra } as HarnessEvent;
}

describe("attemptOutputMarkers (A2 structural predicate input)", () => {
  it("marks agent progress for thinking/tool/file/patch/compaction — NEVER message/error/status", () => {
    for (const progress of [
      ev("thinking", { text: "reasoning..." }),
      ev("tool_call", { tool: { name: "bash", kind: "command" } }),
      ev("tool_result", { tool: { name: "bash", kind: "command", status: "ok" } }),
      ev("file_change", { payload: { path: "x.txt" } }),
      ev("patch_produced"),
      ev("context", {
        context: {
          kind: "compaction_completed",
          cause: "unknown",
          native_code: null,
          trigger: null,
          pre_tokens: null,
        },
      }),
    ]) {
      const m = newAttemptOutputMarkers();
      observeAttemptOutputMarkers(m, progress);
      expect(m.sawAgentProgress, progress.type).toBe(true);
    }
    // The incident class: vendor limit/failure PROSE arriving as message or
    // error must never read as agent progress (it would block the structural
    // rotation branch); status/lifecycle events are not model work either.
    const m = newAttemptOutputMarkers();
    for (const nonProgress of [
      ev("message", { text: "You've hit your usage limit" }),
      ev("error", { error: "You've hit your usage limit" }),
      ev("status", { text: "non-success result prose" }),
      ev("started"),
      ev("usage", { usage: { input_tokens: 1 } }),
      ev("completed"),
      ev("thinking", { text: "   " }),
      ev("context", {
        context: {
          kind: "capacity_exhausted",
          cause: "prompt_too_long",
          native_code: null,
          trigger: null,
          pre_tokens: null,
        },
      }),
    ]) {
      observeAttemptOutputMarkers(m, nonProgress);
    }
    expect(m.sawAgentProgress).toBe(false);
    expect(m.fileChanges).toBe(0);
  });

  it("counts file_change events WITHOUT a tool ref (the observeAttemptTelemetry early-return gap)", () => {
    const t = createAttemptTelemetry("off", false);
    observeAttemptTelemetry(t, ev("file_change", { payload: { path: "a.txt" } }));
    observeAttemptTelemetry(t, ev("file_change", { payload: { path: "b.txt" } }));
    expect(t.outputMarkers.fileChanges).toBe(2);
    expect(t.outputMarkers.sawAgentProgress).toBe(true);
  });

  it("telemetry wires the markers for every observed event", () => {
    const t = createAttemptTelemetry("off", false);
    observeAttemptTelemetry(t, ev("message", { text: "prose" }));
    expect(t.outputMarkers.sawAgentProgress).toBe(false);
    observeAttemptTelemetry(t, ev("tool_call", { tool: { name: "grep", kind: "command" } }));
    expect(t.outputMarkers.sawAgentProgress).toBe(true);
  });
});

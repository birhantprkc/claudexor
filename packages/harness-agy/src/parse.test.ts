import { describe, expect, it } from "vitest";
import { parseAgyEvent } from "./parse.js";

const SID = "ses-test";

describe("parseAgyEvent", () => {
  it("maps init to one started with the native conversation id and model", () => {
    const out = parseAgyEvent(
      {
        event: "init",
        conversation_id: "abc-123",
        init: { model: "gemini-3.7-flash-low", cwd: "/w", tools: [], permission_mode: "plan" },
      },
      SID,
    );
    expect(out).toHaveLength(1);
    expect(out![0]).toMatchObject({
      type: "started",
      observed_model: "gemini-3.7-flash-low",
      payload: { native_session_id: "abc-123" },
    });
  });

  it("serializes structured_output as the typed final (Л-20), never the mixed response text", () => {
    const out = parseAgyEvent(
      {
        event: "result",
        result: {
          conversation_id: "abc",
          status: "SUCCESS",
          response: 'prose then JSON {"output":"x"}',
          structured_output: { output: "x", work_report: { state: "completed" } },
          usage: { input_tokens: 10, output_tokens: 2, thinking_tokens: 1, cache_read_tokens: 0 },
        },
      },
      SID,
    );
    const final = out!.find((e) => e.type === "message");
    expect(final).toMatchObject({ final: true, payload: { final_source: "structured_output" } });
    expect(JSON.parse((final as { text?: string }).text!)).toEqual({
      output: "x",
      work_report: { state: "completed" },
    });
    const usage = out!.find((e) => e.type === "usage");
    // thinking_tokens has no schema home and is dropped, never folded (R-9).
    expect(usage?.usage).toEqual({ input_tokens: 10, output_tokens: 2, cached_input_tokens: 0 });
  });

  it("maps a plain SUCCESS response to a result-sourced final", () => {
    const out = parseAgyEvent(
      { event: "result", result: { status: "SUCCESS", response: "OK\n" } },
      SID,
    );
    expect(out![0]).toMatchObject({
      type: "message",
      final: true,
      text: "OK\n",
      payload: { final_source: "result" },
    });
  });

  it("maps SUCCESS with an empty response to a typed soft-deny error (#794)", () => {
    const out = parseAgyEvent(
      { event: "result", result: { status: "SUCCESS", response: "" } },
      SID,
    );
    expect(out).toHaveLength(1);
    expect(out![0].type).toBe("error");
    expect((out![0] as { error?: string }).error).toMatch(/soft-deny/);
  });

  it("maps an ERROR result to a typed error", () => {
    const out = parseAgyEvent(
      {
        event: "result",
        result: { status: "ERROR", response: "", error: "authentication failed or timed out" },
      },
      SID,
    );
    expect(out![0]).toMatchObject({ type: "error", error: "authentication failed or timed out" });
  });

  it("pairs ACTIVE/DONE tool steps as call/result and flags writes as file changes", () => {
    const active = parseAgyEvent(
      {
        event: "step_update",
        step_update: {
          state: "ACTIVE",
          step_type: "tool",
          tool_info: { name: "write_to_file", parameters: { TargetFile: "/w/a.txt" } },
        },
      },
      SID,
    )!;
    expect(active[0]).toMatchObject({ type: "tool_call", tool: { name: "write_to_file" } });
    const done = parseAgyEvent(
      {
        event: "step_update",
        step_update: {
          state: "DONE",
          step_type: "tool",
          tool_info: {
            name: "write_to_file",
            parameters: { TargetFile: "/w/a.txt" },
            output: "ok",
          },
        },
      },
      SID,
    )!;
    expect(done[0]).toMatchObject({ type: "tool_result", tool: { status: "ok" } });
    expect(done[1]).toMatchObject({ type: "file_change", payload: { path: "/w/a.txt" } });
  });

  it("maps a tool_info error to a typed error tool result", () => {
    const out = parseAgyEvent(
      {
        event: "step_update",
        step_update: {
          state: "DONE",
          step_type: "tool",
          tool_info: { name: "run_command", parameters: { CommandLine: "false" }, error: "exit 1" },
        },
      },
      SID,
    )!;
    expect(out[0]).toMatchObject({
      type: "tool_result",
      tool: { status: "error", error_summary: "exit 1" },
    });
  });

  it("treats lifecycle step types as recognized no-ops and never double-counts usage", () => {
    expect(
      parseAgyEvent(
        { event: "step_update", step_update: { state: "DONE", step_type: "user_input" } },
        SID,
      ),
    ).toEqual([]);
    // Step usage is NOT emitted: the recorded fixtures prove per-step usages
    // sum exactly to the terminal aggregate, so emitting both counted every
    // token twice. The one usage event rides `result`.
    expect(
      parseAgyEvent(
        {
          event: "step_update",
          step_update: {
            state: "DONE",
            step_type: "checkpoint",
            usage: { input_tokens: 5, output_tokens: 1 },
          },
        },
        SID,
      ),
    ).toEqual([]);
    // A FUTURE step type stays a recognized no-op, never a dropped line.
    expect(
      parseAgyEvent(
        { event: "step_update", step_update: { state: "DONE", step_type: "totally_new" } },
        SID,
      ),
    ).toEqual([]);
  });

  it("never claims success for a non-DONE tool state (Ф0 review #1)", () => {
    for (const state of ["CANCELLED", "ERROR", "PENDING", ""]) {
      const out = parseAgyEvent(
        {
          event: "step_update",
          step_update: {
            state,
            step_type: "tool",
            tool_info: { name: "write_to_file", parameters: { TargetFile: "/w/a.txt" } },
          },
        },
        SID,
      )!;
      // No fabricated tool_result and — critically — no fabricated file_change.
      expect(out).toEqual([]);
    }
  });

  it("flags a proven writer whose name does not match the convention (#5)", () => {
    const out = parseAgyEvent(
      {
        event: "step_update",
        step_update: {
          state: "DONE",
          step_type: "tool",
          tool_info: {
            name: "generate_image",
            parameters: { TargetFile: "/w/x.png" },
            output: "ok",
          },
        },
      },
      SID,
    )!;
    expect(out.some((e) => e.type === "file_change")).toBe(true);
  });

  it("keeps a non-string vendor error detail instead of a generic message (#7)", () => {
    const out = parseAgyEvent(
      { event: "result", result: { status: "ERROR", error: { message: "boom" } } },
      SID,
    )!;
    expect((out[0] as { error?: string }).error).toContain("boom");
  });

  it("does not treat a falsy structured_output as an envelope (#7)", () => {
    for (const structured of [false, 0, ""]) {
      const out = parseAgyEvent(
        {
          event: "result",
          result: { status: "SUCCESS", response: "prose", structured_output: structured },
        },
        SID,
      )!;
      expect(out[0]).toMatchObject({ text: "prose", payload: { final_source: "result" } });
    }
  });

  it("bounds and redacts the file_change payload path (#8)", () => {
    const out = parseAgyEvent(
      {
        event: "step_update",
        step_update: {
          state: "DONE",
          step_type: "tool",
          tool_info: {
            name: "write_to_file",
            // Runtime-assembled: never a token-shaped literal at rest (the
            // repo-wide secret scan runs on CI's GNU grep, where \b matches).
            parameters: {
              TargetFile: `/w/${["sk", "ant", "api03", "AAAABBBBCCCCDDDDEEEEFFFF"].join("-")}.txt`,
            },
            output: "ok",
          },
        },
      },
      SID,
    )!;
    const change = out.find((e) => e.type === "file_change") as { payload?: { path?: string } };
    expect(change.payload?.path).not.toContain(
      ["sk", "ant", "api03", "AAAABBBBCCCCDDDDEEEEFFFF"].join("-"),
    );
  });

  it("returns null for unknown top-level events so the run loop counts drops", () => {
    expect(parseAgyEvent({ event: "mystery" }, SID)).toBeNull();
    expect(parseAgyEvent({ nonsense: true }, SID)).toBeNull();
  });
});

describe("hostile top-level shapes never abort the run", () => {
  it("refuses to coerce a non-string discriminator instead of throwing", () => {
    // An object whose `toString` is not callable THROWS under String(), and
    // the run loop reports a mid-stream parse failure as "the harness failed
    // to start" — dropping the rest of a run that was going fine.
    const poison = JSON.parse('{"toString": 1}');
    expect(parseAgyEvent({ event: poison }, SID)).toBeNull();
    expect(
      parseAgyEvent({ event: "step_update", step_update: { step_type: poison } }, SID),
    ).toEqual([]);
    expect(
      parseAgyEvent(
        { event: "step_update", step_update: { step_type: "tool", state: poison } },
        SID,
      ),
    ).toEqual([]);
    const result = parseAgyEvent({ event: "result", result: { status: poison } }, SID)!;
    expect(result[0]).toMatchObject({ type: "error" });
  });
});

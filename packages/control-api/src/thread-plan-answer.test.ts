import { describe, expect, it } from "vitest";
import {
  assertPlanAnswerQuestionsArtifact,
  assertPlanAnswerSubmission,
} from "./thread-plan-answer.js";

function failure(fn: () => void): Record<string, unknown> {
  try {
    fn();
  } catch (error) {
    return error as Record<string, unknown>;
  }
  throw new Error("expected plan-answer admission to fail");
}

describe("plan-answer turn admission", () => {
  const base = {
    sourcePlanRunId: "run-plan",
    implementPlanRunId: null,
    mode: "plan",
    headRunId: "run-plan",
    threadRunIds: ["run-plan"],
    turns: [] as Array<Record<string, unknown>>,
  };

  it("accepts the current plan and rejects wrong-mode or stale submissions", () => {
    expect(() => assertPlanAnswerSubmission(base)).not.toThrow();
    expect(failure(() => assertPlanAnswerSubmission({ ...base, mode: "agent" }))["code"]).toBe(
      "plan_answers_mode_invalid",
    );
    expect(
      failure(() => assertPlanAnswerSubmission({ ...base, headRunId: "run-newer" }))["code"],
    ).toBe("plan_answers_stale");
    expect(
      failure(() => assertPlanAnswerSubmission({ ...base, threadRunIds: ["run-other"] }))["code"],
    ).toBe("plan_answers_source_invalid");
  });

  it("rejects a request that also asks to implement a plan", () => {
    expect(
      failure(() => assertPlanAnswerSubmission({ ...base, implementPlanRunId: "run-plan" }))[
        "code"
      ],
    ).toBe("plan_answers_action_conflict");
  });

  it("rejects bound, queued, and retryable duplicate answer turns", () => {
    const duplicates = [
      { answers_plan_run_id: "run-plan", run_id: "run-answer" },
      { answers_plan_run_id: "run-plan", run_id: null, enqueue_error: null },
      {
        answers_plan_run_id: "run-plan",
        run_id: null,
        enqueue_error: { retryable: true },
      },
    ];
    for (const duplicate of duplicates) {
      expect(
        failure(() => assertPlanAnswerSubmission({ ...base, turns: [duplicate] }))["code"],
      ).toBe("plan_answers_already_submitted");
    }
  });

  it("allows a new turn after a non-retryable pre-enqueue refusal", () => {
    expect(() =>
      assertPlanAnswerSubmission({
        ...base,
        turns: [
          {
            answers_plan_run_id: "run-plan",
            run_id: null,
            enqueue_error: { retryable: false },
          },
        ],
      }),
    ).not.toThrow();
  });
});

describe("plan-answer source artifact admission", () => {
  it("accepts only a parsed artifact with open questions", () => {
    expect(() =>
      assertPlanAnswerQuestionsArtifact(
        JSON.stringify({
          parse: "found",
          questions: [
            {
              id: "q1",
              kind: "single",
              prompt: "Which store?",
              options: [{ id: "a", label: "SQLite" }],
              allow_text: true,
            },
          ],
        }),
      ),
    ).not.toThrow();
    for (const artifact of [
      null,
      "not json",
      JSON.stringify({ parse: "none_found", questions: [] }),
      JSON.stringify({ parse: "found", questions: [] }),
    ]) {
      const error = failure(() => assertPlanAnswerQuestionsArtifact(artifact));
      expect(error["code"]).toBe("plan_answers_source_not_open");
      expect(error["status"]).toBe(400);
    }
  });
});

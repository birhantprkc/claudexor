import { PlanQuestionsArtifact } from "@claudexor/schema";

/** Validate the one durable relation created by a plan-answer action. The
 * route owns current-head and duplicate admission so every UI/CLI client gets
 * the same fail-closed behavior; prompt text is deliberately irrelevant. */
export function assertPlanAnswerSubmission(input: {
  sourcePlanRunId: string | null;
  implementPlanRunId: string | null;
  mode: string;
  headRunId: string | null;
  threadRunIds: string[];
  turns: Array<Record<string, unknown>>;
}): void {
  const source = input.sourcePlanRunId;
  if (!source) return;
  if (input.implementPlanRunId) {
    throw Object.assign(
      new Error("a turn cannot answer plan questions and implement a plan at the same time"),
      {
        status: 400,
        code: "plan_answers_action_conflict",
      },
    );
  }
  if (input.mode !== "plan") {
    throw Object.assign(new Error("plan answers must be submitted as a plan turn"), {
      status: 400,
      code: "plan_answers_mode_invalid",
    });
  }
  if (!input.threadRunIds.includes(source)) {
    throw Object.assign(new Error(`answersPlanRunId ${source} is not a run of this thread`), {
      status: 400,
      code: "plan_answers_source_invalid",
    });
  }
  if (input.headRunId !== source) {
    throw Object.assign(
      new Error("the plan is no longer the current thread head; reload before answering"),
      {
        status: 409,
        code: "plan_answers_stale",
        requiredActions: ["reload_thread"],
      },
    );
  }
  const accepted = input.turns.find((turn) => {
    if (turn["answers_plan_run_id"] !== source) return false;
    if (typeof turn["run_id"] === "string") return true;
    const refusal = turn["enqueue_error"] as { retryable?: unknown } | null | undefined;
    return refusal == null || refusal.retryable !== false;
  });
  if (accepted) {
    throw Object.assign(new Error("answers for this plan were already submitted"), {
      status: 409,
      code: "plan_answers_already_submitted",
      requiredActions: ["reload_thread"],
    });
  }
}

/** Prove the referenced current-head run actually owns an open plan-question
 * artifact. Membership alone is not enough: otherwise a client could attach
 * answer provenance to an arbitrary run and suppress the wrong card. */
export function assertPlanAnswerQuestionsArtifact(text: string | null): void {
  let raw: unknown;
  try {
    raw = text == null ? null : JSON.parse(text);
  } catch {
    raw = null;
  }
  const parsed = PlanQuestionsArtifact.safeParse(raw);
  if (!parsed.success || parsed.data.parse !== "found" || parsed.data.questions.length === 0) {
    throw Object.assign(new Error("the referenced run has no readable open plan questions"), {
      status: 400,
      code: "plan_answers_source_not_open",
    });
  }
}

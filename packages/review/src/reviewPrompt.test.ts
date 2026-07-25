import { describe, expect, it } from "vitest";
import { buildReviewPrompt } from "./reviewPrompt.js";

const patch = {
  diffPath: "/evidence/DIFF.patch",
  summaryPath: "/evidence/DIFF_SUMMARY.md",
  diffSha256: "sha256:test",
  summary: "(plan review — no code diff)",
};

describe("typed review subject", () => {
  it("does not ask plan reviewers to find missing implementation/screenshots", () => {
    const prompt = buildReviewPrompt("Plan", "/candidate", "/evidence", patch, false, "plan");
    expect(prompt).toContain("READ-ONLY PLAN");
    expect(prompt).toContain("absence is NOT a finding");
    expect(prompt).toContain("PLAN_ACCEPTED.md");
    expect(prompt).toContain("do not demand a code diff");
  });
});

const CODE_GROUNDING = "grounded in the current patch or in artifacts under Candidate root";
const PLAN_GROUNDING =
  "grounded in the accepted plan in PLAN_ACCEPTED.md or in the evidence packet supplied with it";

describe("finding-discipline rules (pinned clause by clause)", () => {
  // Universal clauses reach every reviewer spawn; the grounding clause names the
  // artifact THAT subject actually reviews, so it is pinned per subject.
  for (const [name, built, grounding, wrongGrounding] of [
    [
      "code",
      buildReviewPrompt("Cand", "/candidate", "/evidence", patch),
      CODE_GROUNDING,
      PLAN_GROUNDING,
    ],
    [
      "sealed code",
      buildReviewPrompt("Cand", "/candidate", "/evidence", patch, true),
      CODE_GROUNDING,
      PLAN_GROUNDING,
    ],
    [
      "plan",
      buildReviewPrompt("Plan", "/candidate", "/evidence", patch, false, "plan"),
      PLAN_GROUNDING,
      CODE_GROUNDING,
    ],
  ] as const) {
    it(`tells the ${name} reviewer the machine decides from typed fields, not prose`, () => {
      // "the ONLY field the consumer reads" would be false: isBlocking also
      // weighs attached evidence, and the same prompt tells the reviewer that
      // BLOCK without evidence is not allowed.
      expect(built).toContain("The machine consumer decides from typed fields, never from prose");
      expect(built).toContain("attached evidence is what lets BLOCK or FIX_FIRST stand");
      expect(built).toContain(
        "A hedge, caveat, or withdrawal written inside claim or proposed_fix",
      );
      // The non-blocking set is named outright, and every blocking severity is
      // listed — an earlier wording said "below BLOCK/FIX_FIRST", which reads
      // NEEDS_HUMAN and INSUFFICIENT_EVIDENCE as safe landing spots.
      expect(built).toContain("non-blocking severity — WARN, NIT, or OUT_OF_SCOPE");
      expect(built).toContain("BLOCK, FIX_FIRST, NEEDS_HUMAN, and INSUFFICIENT_EVIDENCE all block");
    });

    it(`tells the ${name} reviewer not to re-raise one root cause as two findings`, () => {
      expect(built).toContain("One root cause is one finding");
      expect(built).toContain("under different wording");
    });

    it(`grounds the ${name} reviewer's findings in the artifact that subject reviews`, () => {
      expect(built).toContain(grounding);
      expect(built).not.toContain(wrongGrounding);
      expect(built).toContain("Do not manufacture a finding from");
      expect(built).toContain("that contradiction is itself the finding");
    });

    it(`tells the ${name} reviewer to state checkable reasoning for the human reader`, () => {
      expect(built).toContain("The prose is for the human, not for the machine");
      expect(built).toContain(
        "State the reasoning that makes the claim true, not only the conclusion",
      );
      // The two rules divide labor rather than contradict: the machine acts on
      // the typed fields, the human reads the reasoning.
      expect(built).toContain(
        "the consumer never weighs that reasoning, it acts on the typed fields above",
      );
      expect(built).toContain("neither substitutes for the other");
      expect(built).toContain(
        "proposed_fix whose own justification does not survive checking is worse than no finding",
      );
    });
  }

  it("never tells the PLAN reviewer that PLAN_ACCEPTED.md alone is too thin a source", () => {
    // In plan review PLAN_ACCEPTED.md IS the reviewed deliverable and the patch
    // is an acknowledged placeholder, so the code-subject grounding clause would
    // disqualify the only artifact under review.
    const plan = buildReviewPrompt("Plan", "/candidate", "/evidence", patch, false, "plan");
    expect(plan).not.toContain(
      "Do not manufacture a finding from USER_INTENT.md, PLAN_ACCEPTED.md, or TESTS.txt text alone",
    );
    expect(plan).not.toContain("a code defect must be locatable in the reviewed code");
    expect(plan).toContain("a plan defect must be locatable in the plan text you were given");
  });
});

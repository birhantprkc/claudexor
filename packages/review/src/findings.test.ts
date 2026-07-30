import { describe, expect, it } from "vitest";
import { ReviewFinding } from "@claudexor/schema";
import {
  dedupeFindings,
  extractJsonBlocks,
  parseFindingsDetailed,
  parseSealedReviewEnvelopeDetailed,
} from "./findings.js";
import { RELEASE_NATIVE_CHECKLIST_ITEMS } from "./reviewPrompt.js";

describe("extractJsonBlocks", () => {
  it("accepts a final bare JSON array after explanatory reviewer text", () => {
    expect(
      extractJsonBlocks(
        ["I inspected the evidence packet and found no legitimate defects.", "", "[]"].join("\n"),
      ),
    ).toEqual([[]]);
  });

  it("accepts the last complete JSON block when transcript text follows it", () => {
    expect(
      extractJsonBlocks(`status before
[
  {"severity":"FIX_FIRST","category":"regression","claim":"retry inventory"}
]
duplicated transcript text after json`),
    ).toEqual([[{ severity: "FIX_FIRST", category: "regression", claim: "retry inventory" }]]);
  });

  it("accepts object-shaped review payloads", () => {
    expect(
      extractJsonBlocks(`status before
{"findings":[{"severity":"BLOCK","category":"regression","claim":"legacy object"}]}`),
    ).toEqual([
      { findings: [{ severity: "BLOCK", category: "regression", claim: "legacy object" }] },
    ]);
  });

  it("accepts a single finding object with surrounding reviewer text", () => {
    expect(
      extractJsonBlocks(`status before
{"severity":"FIX_FIRST","category":"regression","claim":"single finding with context"}
status after`),
    ).toEqual([
      { severity: "FIX_FIRST", category: "regression", claim: "single finding with context" },
    ]);
  });

  it("accepts a single finding object inside a json fence", () => {
    expect(
      extractJsonBlocks(`summary
\`\`\`json
{"severity":"BLOCK","category":"correctness","claim":"single fenced finding"}
\`\`\``),
    ).toEqual([{ severity: "BLOCK", category: "correctness", claim: "single fenced finding" }]);
  });

  it("prefers a later complete array over an earlier object-shaped example", () => {
    expect(
      extractJsonBlocks(`status before
{"findings":[{"severity":"BLOCK","category":"regression","claim":"legacy object"}]}
[
  {"severity":"WARN","category":"test_gap","claim":"array contract"}
]`),
    ).toEqual([[{ severity: "WARN", category: "test_gap", claim: "array contract" }]]);
  });

  it("returns no payload for a long unclosed fence", () => {
    expect(extractJsonBlocks("```" + " ".repeat(128 * 1024))).toEqual([]);
  });

  it("bounds fallback work across many unclosed line-start candidates", () => {
    expect(extractJsonBlocks(Array.from({ length: 4_096 }, () => "[").join("\n"))).toEqual([]);
  });

  it("still finds the newest valid payload inside the fallback candidate budget", () => {
    const text = [
      ...Array.from({ length: 4_096 }, () => "["),
      '[{"severity":"WARN","category":"correctness","claim":"late payload"}]',
    ].join("\n");
    expect(extractJsonBlocks(text)).toEqual([
      [{ severity: "WARN", category: "correctness", claim: "late payload" }],
    ]);
  });
});

describe("parseFindingsDetailed", () => {
  it("parses object-wrapped and single-object finding payloads", () => {
    const wrapped = parseFindingsDetailed(
      `{"findings":[{"severity":"BLOCK","category":"regression","claim":"wrapped"}]}`,
      { harness_id: "r" },
    );
    expect(wrapped.findings).toHaveLength(1);
    expect(wrapped.findings[0]?.claim).toBe("wrapped");

    const single = parseFindingsDetailed(
      `{"severity":"WARN","category":"correctness","claim":"single"}`,
      { harness_id: "r" },
    );
    expect(single.findings).toHaveLength(1);
    expect(single.findings[0]?.claim).toBe("single");
  });

  it("keeps consuming findings from the sealed release completion envelope", () => {
    const parsed = parseFindingsDetailed(
      JSON.stringify({
        completion: {
          verdict: "PASS",
          checklist: [{ item: "sealed_evidence", completed: true }],
          findingCount: 1,
        },
        findings: [{ severity: "WARN", category: "test_gap", claim: "wrapped release finding" }],
      }),
      { harness_id: "release-reviewer" },
    );
    expect(parsed.malformed).toBe(0);
    expect(parsed.findings.map((finding) => finding.claim)).toEqual(["wrapped release finding"]);
  });
});

function sealedEnvelope(
  findings: unknown[] = [],
  verdict: "PASS" | "FAIL" = findings.some(
    (finding) =>
      !!finding &&
      typeof finding === "object" &&
      ["BLOCK", "FIX_FIRST", "NEEDS_HUMAN", "INSUFFICIENT_EVIDENCE"].includes(
        String((finding as { severity?: unknown }).severity),
      ),
  )
    ? "FAIL"
    : "PASS",
) {
  return {
    completion: {
      verdict,
      checklist: RELEASE_NATIVE_CHECKLIST_ITEMS.map((item) => ({ item, completed: true })),
      findingCount: findings.length,
    },
    findings,
  };
}

const sealedReviewer = { harness_id: "release-reviewer" };

describe("parseSealedReviewEnvelopeDetailed", () => {
  it("accepts an exact clean envelope and an optional checklist note", () => {
    const envelope = sealedEnvelope();
    envelope.completion.checklist[0] = {
      ...envelope.completion.checklist[0]!,
      note: "manifest verified",
    } as (typeof envelope.completion.checklist)[number];
    const parsed = parseSealedReviewEnvelopeDetailed(JSON.stringify(envelope), sealedReviewer);
    expect(parsed).toMatchObject({ findings: [], malformed: 0, error: null });
  });

  it("accepts a FAIL envelope whose count and verdict match a blocker", () => {
    const parsed = parseSealedReviewEnvelopeDetailed(
      JSON.stringify(
        sealedEnvelope([{ severity: "BLOCK", category: "correctness", claim: "real blocker" }]),
      ),
      sealedReviewer,
    );
    expect(parsed.error).toBeNull();
    expect(parsed.findings.map((finding) => finding.claim)).toEqual(["real blocker"]);
  });

  it("rejects repeated semantically identical envelopes", () => {
    const envelope = sealedEnvelope([
      { severity: "WARN", category: "test_gap", claim: "same warning" },
    ]);
    const reordered = { findings: envelope.findings, completion: envelope.completion };
    const parsed = parseSealedReviewEnvelopeDetailed(
      `${JSON.stringify(envelope)}\n${JSON.stringify(reordered)}`,
      sealedReviewer,
    );
    expect(parsed.error).toMatch(/exactly one JSON object/);
    expect(parsed.blocks).toEqual([]);
    expect(parsed.findings).toEqual([]);
  });

  it("rejects divergent or mixed payloads at the one-object boundary", () => {
    const envelope = sealedEnvelope();
    expect(
      parseSealedReviewEnvelopeDetailed(
        `${JSON.stringify(envelope)}\n${JSON.stringify(sealedEnvelope([{ severity: "WARN", claim: "later" }]))}`,
        sealedReviewer,
      ).error,
    ).toMatch(/exactly one JSON object/);
    expect(
      parseSealedReviewEnvelopeDetailed(`${JSON.stringify(envelope)}\n[]`, sealedReviewer).error,
    ).toMatch(/exactly one JSON object/);
  });

  it.each([
    ["missing row", (value: ReturnType<typeof sealedEnvelope>) => value.completion.checklist.pop()],
    [
      "wrong order",
      (value: ReturnType<typeof sealedEnvelope>) => value.completion.checklist.reverse(),
    ],
    [
      "incomplete row",
      (value: ReturnType<typeof sealedEnvelope>) => {
        value.completion.checklist[0]!.completed = false;
      },
    ],
    [
      "unknown row field",
      (value: ReturnType<typeof sealedEnvelope>) => {
        Object.assign(value.completion.checklist[0]!, { extra: true });
      },
    ],
  ])("rejects a %s in the exact checklist", (_name, mutate) => {
    const envelope = sealedEnvelope();
    mutate(envelope);
    expect(
      parseSealedReviewEnvelopeDetailed(JSON.stringify(envelope), sealedReviewer).error,
    ).toMatch(/exact completed items/);
  });

  it.each([
    ["negative", -1],
    ["fractional", 0.5],
    ["mismatched", 2],
  ])("rejects a %s findingCount", (_name, findingCount) => {
    const envelope = sealedEnvelope();
    envelope.completion.findingCount = findingCount;
    expect(
      parseSealedReviewEnvelopeDetailed(JSON.stringify(envelope), sealedReviewer).error,
    ).toMatch(/findingCount/);
  });

  it("rejects PASS with a blocker and FAIL without one", () => {
    const mismatched = parseSealedReviewEnvelopeDetailed(
      JSON.stringify(
        sealedEnvelope(
          [{ severity: "FIX_FIRST", category: "regression", claim: "must fix" }],
          "PASS",
        ),
      ),
      sealedReviewer,
    );
    expect(mismatched.error).toMatch(/must be FAIL/);
    expect(mismatched.findings.map((finding) => finding.claim)).toEqual(["must fix"]);
    expect(
      parseSealedReviewEnvelopeDetailed(JSON.stringify(sealedEnvelope([], "FAIL")), sealedReviewer)
        .error,
    ).toMatch(/must be PASS/);
  });

  it("rejects malformed findings and extra envelope fields", () => {
    const malformed = sealedEnvelope([
      { severity: "WARN", category: "test_gap", claim: "retained warning" },
      { category: "correctness", claim: "missing severity" },
    ]);
    const parsed = parseSealedReviewEnvelopeDetailed(JSON.stringify(malformed), sealedReviewer);
    expect(parsed.error).toMatch(/malformed/);
    expect(parsed.malformed).toBe(1);
    expect(parsed.findings.map((finding) => finding.claim)).toEqual(["retained warning"]);

    const extra = { ...sealedEnvelope(), explanation: "not part of the contract" };
    expect(parseSealedReviewEnvelopeDetailed(JSON.stringify(extra), sealedReviewer).error).toMatch(
      /envelope shape/,
    );
  });

  it.each([
    ["unknown severity", { severity: "CRITICAL", claim: "bad severity" }],
    ["unknown category", { severity: "WARN", category: "style", claim: "bad category" }],
    [
      "malformed file evidence",
      { severity: "WARN", claim: "bad evidence", evidence: { files: [{ path: 42 }] } },
    ],
    ["malformed proposed fix", { severity: "WARN", claim: "bad fix", proposed_fix: 42 }],
  ])("rejects %s before a sealed decision is trusted", (_name, finding) => {
    const parsed = parseSealedReviewEnvelopeDetailed(
      JSON.stringify(sealedEnvelope([finding])),
      sealedReviewer,
    );
    expect(parsed.error).toMatch(/malformed/);
    expect(parsed.findings).toEqual([]);
  });
});

describe("dedupeFindings", () => {
  it("preserves separate insufficient-evidence diagnostics per reviewer", () => {
    const base = {
      id: "f-1",
      severity: "INSUFFICIENT_EVIDENCE",
      category: "correctness",
      claim: "Reviewer produced no parseable JSON findings.",
      evidence: { files: [], logs: [], commands: [], diff_hunks: [] },
      status: "insufficient_evidence",
    } satisfies Partial<ReviewFinding>;
    const findings = [
      ReviewFinding.parse({
        ...base,
        id: "f-1",
        reviewer: {
          harness_id: "claude",
          requested_model: null,
          requested_effort: null,
          observed_model: null,
          route_proof_status: "verified",
        },
      }),
      ReviewFinding.parse({
        ...base,
        id: "f-2",
        reviewer: {
          harness_id: "cursor",
          requested_model: null,
          requested_effort: null,
          observed_model: null,
          route_proof_status: "verified",
        },
      }),
    ];

    expect(dedupeFindings(findings)).toHaveLength(2);
  });
});

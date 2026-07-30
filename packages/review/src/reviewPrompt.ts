import type { DiffEvidence } from "@claudexor/context";
import { RELEASE_NATIVE_CHECKLIST_ITEMS } from "./sealedReviewEnvelope.js";
export { RELEASE_NATIVE_CHECKLIST_ITEMS } from "./sealedReviewEnvelope.js";

/** Provider-strict structural boundary for a frozen release review. Every
 * object is closed and fully required for native structured-output support.
 * This transport shape is intentionally narrower than the backward-compatible
 * dependency-free parser, which remains the semantic authority. */
export const SEALED_REVIEW_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["completion", "findings"],
  properties: {
    completion: {
      type: "object",
      additionalProperties: false,
      required: ["verdict", "checklist", "findingCount"],
      properties: {
        verdict: { type: "string" },
        checklist: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["item", "completed"],
            properties: {
              item: { type: "string" },
              completed: { type: "boolean" },
            },
          },
        },
        findingCount: { type: "integer" },
      },
    },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "category", "claim", "evidence", "proposed_fix"],
        properties: {
          severity: { type: "string" },
          category: { type: "string" },
          claim: { type: "string" },
          evidence: {
            type: "object",
            additionalProperties: false,
            required: ["files", "diff_hunks", "commands", "logs"],
            properties: {
              files: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["path", "lines"],
                  properties: {
                    path: { type: "string" },
                    lines: { type: "string" },
                  },
                },
              },
              diff_hunks: { type: "array", items: { type: "string" } },
              commands: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["command"],
                  properties: { command: { type: "string" } },
                },
              },
              logs: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["path"],
                  properties: { path: { type: "string" } },
                },
              },
            },
          },
          proposed_fix: { type: "string" },
        },
      },
    },
  },
} as const satisfies Record<string, unknown>;

export function buildReviewPrompt(
  label: string,
  candidateRoot: string,
  evidenceDir: string,
  patch: DiffEvidence,
  sealedOrOptions:
    boolean | { sealed?: boolean; candidateInventoryMode?: "git_visible" | "diff_only" } = false,
): string {
  const options =
    typeof sealedOrOptions === "boolean" ? { sealed: sealedOrOptions } : sealedOrOptions;
  const sealed = options.sealed === true;
  const responseContract = sealed
    ? [
        "Output ONLY one JSON object with this exact release-review envelope:",
        '{"completion":{"verdict":"PASS","checklist":[{"item":"...","completed":true}],"findingCount":0},"findings":[]}',
        `The completion.checklist must contain exactly these items in this order: ${RELEASE_NATIVE_CHECKLIST_ITEMS.join(", ")}.`,
        "Every checklist row must set completed=true. findingCount must exactly equal findings.length.",
        "No other envelope fields are allowed.",
        "Use completion.verdict=FAIL for BLOCK, FIX_FIRST, NEEDS_HUMAN, or INSUFFICIENT_EVIDENCE; otherwise PASS.",
        "findings uses the finding schema below. A clean review is the completed envelope with findings=[], never a bare [] or [{}].",
      ]
    : ["Output ONLY a JSON array of findings."];
  const findingContract = sealed
    ? `Each finding: {"severity":"BLOCK|FIX_FIRST|WARN|NIT|OUT_OF_SCOPE|INSUFFICIENT_EVIDENCE|NEEDS_HUMAN","category":"correctness|regression|security|performance|maintainability|test_gap|spec_gap|deploy|architecture|ux","claim":"...","evidence":{"files":[{"path":"...","lines":"..."}],"diff_hunks":[],"commands":[],"logs":[]},"proposed_fix":"..."}. All four evidence arrays are required and may be empty.`
    : `Each finding: {"severity":"BLOCK|FIX_FIRST|WARN|NIT|OUT_OF_SCOPE|INSUFFICIENT_EVIDENCE|NEEDS_HUMAN","category":"correctness|regression|security|performance|maintainability|test_gap|spec_gap|deploy|architecture|ux","claim":"...","evidence":{"files":[{"path":"...","lines":"..."}]},"proposed_fix":"..."}.`;
  return [
    "You are an adversarial code reviewer.",
    `Candidate root: ${candidateRoot}.`,
    sealed
      ? `First verify MANIFEST.sha256 and read every file it seals in ${evidenceDir}, including FREEZE.json and DECIDED_TRADEOFFS.md. If the manifest or a sealed file is missing, return INSUFFICIENT_EVIDENCE.`
      : `First read the evidence packet in ${evidenceDir} (USER_INTENT.md, FORBIDDEN_FINDINGS.md, PLAN_ACCEPTED.md, DECIDED_TRADEOFFS.md, TESTS.txt, DIFF.patch, DIFF_SUMMARY.md). If a mandatory file is missing, return INSUFFICIENT_EVIDENCE.`,
    `Review ${label}'s change from the file-backed patch artifact, not from this prompt. Full patch: ${patch.diffPath}. Summary: ${patch.summaryPath}. Patch digest: ${patch.diffSha256}.`,
    ...(options.candidateInventoryMode === "diff_only"
      ? [
          "Candidate root is a disclosed diff-only projection because no Git inventory was available. It contains changed postimages, not unchanged sibling context. If a concrete claim requires an unavailable sibling, return INSUFFICIENT_EVIDENCE instead of guessing.",
        ]
      : []),
    "All code/file evidence must come from Candidate root or the evidence packet. Do not inspect or cite sibling/base repository paths outside Candidate root; if required evidence is unavailable there, return INSUFFICIENT_EVIDENCE.",
    "Treat TESTS.txt as the gate evidence. Do not rerun full build/test gates from the review; run only small targeted commands when needed to verify a concrete finding.",
    "In finding evidence, cite candidate files with paths relative to Candidate root. Cite evidence packet files by their evidence filename (for example DIFF.patch or TESTS.txt). Do not cite absolute Candidate root, reviewer workspace, or evidenceDir paths; those are disposable transport paths and will be rejected as evidence.",
    ...responseContract,
    findingContract,
    "Rules: no evidence => do NOT use BLOCK. Do not relitigate FORBIDDEN_FINDINGS or DECIDED_TRADEOFFS.",
    "The machine consumer decides from typed fields, never from prose: severity is what makes a finding block, and attached evidence is what lets BLOCK or FIX_FIRST stand. A hedge, caveat, or withdrawal written inside claim or proposed_fix changes nothing mechanically, so a finding you have talked yourself out of must be dropped or carry a non-blocking severity — WARN, NIT, or OUT_OF_SCOPE. BLOCK, FIX_FIRST, NEEDS_HUMAN, and INSUFFICIENT_EVIDENCE all block; never leave a withdrawn finding at any of those four.",
    "One root cause is one finding. Do not re-raise the same underlying defect as a second finding under different wording; emit it once and list every affected location in evidence.",
    "Every finding must be grounded in the current patch or in artifacts under Candidate root. Do not manufacture a finding from USER_INTENT.md, PLAN_ACCEPTED.md, or TESTS.txt text alone; a code defect must be locatable in the reviewed code. If the supplied intent or test evidence contradicts the patch, that contradiction is itself the finding: claim it and cite both sides.",
    "The prose is for the human, not for the machine. State the reasoning that makes the claim true, not only the conclusion, so a person reading the finding can check it against the cited lines; the consumer never weighs that reasoning, it acts on the typed fields above. The two carry different jobs and neither substitutes for the other: a correct severity with unexplained reasoning wastes the reader, and airtight reasoning under a withdrawn-but-blocking severity stops the run anyway. A proposed_fix whose own justification does not survive checking is worse than no finding, because the author will comply with it.",
    "",
    "Patch summary (not a replacement for reading DIFF.patch):",
    patch.summary,
  ].join("\n");
}

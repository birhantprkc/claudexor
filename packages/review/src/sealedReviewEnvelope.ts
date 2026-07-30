export const RELEASE_NATIVE_CHECKLIST_ITEMS = [
  "sealed_evidence",
  "intent_and_scope",
  "runtime_and_security",
  "tests_and_release",
] as const;

export const SEALED_REVIEW_SEVERITY_VALUES = [
  "BLOCK",
  "FIX_FIRST",
  "WARN",
  "NIT",
  "OUT_OF_SCOPE",
  "INSUFFICIENT_EVIDENCE",
  "NEEDS_HUMAN",
] as const;
export const SEALED_REVIEW_CATEGORY_VALUES = [
  "correctness",
  "regression",
  "security",
  "performance",
  "maintainability",
  "test_gap",
  "spec_gap",
  "deploy",
  "architecture",
  "ux",
] as const;
const SEALED_REVIEW_SEVERITIES = new Set<string>(SEALED_REVIEW_SEVERITY_VALUES);
const SEALED_REVIEW_CATEGORIES = new Set<string>(SEALED_REVIEW_CATEGORY_VALUES);
const BLOCKING_SEVERITIES = new Set(["BLOCK", "FIX_FIRST", "NEEDS_HUMAN", "INSUFFICIENT_EVIDENCE"]);

export interface SealedReviewDecisionFinding {
  severity: string;
}

export interface SealedReviewDecisionEnvelopeParse {
  findings: SealedReviewDecisionFinding[];
  rawFindings: unknown[];
  malformed: number;
  error: string | null;
  blocks: unknown[];
}

/** Deterministic persisted transcript projection for sealed native reviews. */
export function sealedReviewTranscriptChunk(event: unknown): string | null {
  if (!isRecord(event) || event["type"] !== "message") return null;
  if (isRecord(event["payload"]) && event["payload"]["auth_switched"] === true) return null;
  const text = event["text"];
  if (typeof text !== "string" || text.length === 0) return null;
  return text.endsWith("\n") ? text : `${text}\n`;
}

export function sealedReviewTranscriptFromEvents(events: readonly unknown[]): string {
  return events
    .map(sealedReviewTranscriptChunk)
    .filter((text): text is string => text !== null)
    .join("");
}

/** Dependency-free decision parser shared by the product and receipt verifier.
 * Full product normalization still runs the canonical ReviewFinding schema. */
export function parseSealedReviewDecisionEnvelopeDetailed(
  text: string,
): SealedReviewDecisionEnvelopeParse {
  const empty = (error: string): SealedReviewDecisionEnvelopeParse => ({
    findings: [],
    rawFindings: [],
    malformed: 0,
    error,
    blocks: [],
  });
  const source = text.trim();
  if (source.length === 0) return empty("no sealed review envelope");

  let envelope: unknown;
  try {
    envelope = JSON.parse(source);
  } catch {
    return empty("sealed review output must be exactly one JSON object with no surrounding prose");
  }
  const blocks = [envelope];
  const fail = (
    error: string,
    rawFindings: unknown[] = [],
    findings: SealedReviewDecisionFinding[] = [],
    malformed = 0,
  ): SealedReviewDecisionEnvelopeParse => ({
    findings,
    rawFindings,
    malformed,
    error,
    blocks,
  });
  if (!isRecord(envelope) || !hasExactKeys(envelope, ["completion", "findings"])) {
    return fail("invalid sealed review envelope shape");
  }
  const completion = envelope["completion"];
  const rawFindings = envelope["findings"];
  if (
    !isRecord(completion) ||
    !hasExactKeys(completion, ["checklist", "findingCount", "verdict"]) ||
    !Array.isArray(rawFindings)
  ) {
    return fail("invalid sealed completion shape");
  }
  const checklist = completion["checklist"];
  if (
    !Array.isArray(checklist) ||
    checklist.length !== RELEASE_NATIVE_CHECKLIST_ITEMS.length ||
    checklist.some((row, index) => {
      if (!isRecord(row) || !hasOnlyKeys(row, ["item", "completed", "note"])) return true;
      if (row["item"] !== RELEASE_NATIVE_CHECKLIST_ITEMS[index] || row["completed"] !== true)
        return true;
      return row["note"] !== undefined && typeof row["note"] !== "string";
    })
  ) {
    return fail(
      "sealed checklist must contain the four exact completed items in order",
      rawFindings,
    );
  }
  const findingCount = completion["findingCount"];
  if (!Number.isSafeInteger(findingCount) || (findingCount as number) < 0) {
    return fail("findingCount must be a non-negative integer", rawFindings);
  }
  if (findingCount !== rawFindings.length) {
    return fail("findingCount does not match findings.length", rawFindings);
  }

  const findings = rawFindings.filter(isSealedReviewFinding).map((finding) => ({
    severity: finding["severity"] as string,
  }));
  const malformed = rawFindings.length - findings.length;
  if (malformed > 0) {
    return fail("sealed findings contain malformed items", rawFindings, findings, malformed);
  }
  const expectedVerdict = findings.some((finding) => BLOCKING_SEVERITIES.has(finding.severity))
    ? "FAIL"
    : "PASS";
  if (completion["verdict"] !== expectedVerdict) {
    return fail(
      `completion verdict must be ${expectedVerdict} for these findings`,
      rawFindings,
      findings,
    );
  }
  return { findings, rawFindings, malformed: 0, error: null, blocks };
}

function isSealedReviewFinding(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || !SEALED_REVIEW_SEVERITIES.has(value["severity"] as string)) return false;
  const id = value["id"];
  if (id != null && (typeof id !== "string" || id.length === 0)) return false;
  const category = value["category"];
  if (category != null && !SEALED_REVIEW_CATEGORIES.has(category as string)) return false;
  const criteria = value["linked_acceptance_criteria"];
  if (
    criteria != null &&
    !isArrayOf(criteria, (item) => typeof item === "string" && item.length > 0)
  )
    return false;
  const proposedFix = value["proposed_fix"];
  if (proposedFix != null && typeof proposedFix !== "string") return false;
  return isFindingEvidence(value["evidence"]);
}

function isFindingEvidence(value: unknown): boolean {
  if (value == null) return true;
  if (!isRecord(value)) return false;
  return (
    isOptionalArrayOf(
      value["files"],
      (item) =>
        isRecord(item) &&
        typeof item["path"] === "string" &&
        (item["lines"] === undefined ||
          item["lines"] === null ||
          typeof item["lines"] === "string"),
    ) &&
    isOptionalArrayOf(value["diff_hunks"], (item) => typeof item === "string") &&
    isOptionalArrayOf(
      value["commands"],
      (item) => isRecord(item) && typeof item["command"] === "string",
    ) &&
    isOptionalArrayOf(value["logs"], (item) => isRecord(item) && typeof item["path"] === "string")
  );
}

function isOptionalArrayOf(value: unknown, predicate: (item: unknown) => boolean): boolean {
  return value === undefined || isArrayOf(value, predicate);
}

function isArrayOf(value: unknown, predicate: (item: unknown) => boolean): boolean {
  return Array.isArray(value) && value.every(predicate);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && hasOnlyKeys(value, keys);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

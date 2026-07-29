import type { ReviewFinding, RouteProofStatus, Severity } from "@claudexor/schema";
import { ReviewFinding as ReviewFindingSchema } from "@claudexor/schema";
import { newId, stableStringify } from "@claudexor/util";
import { RELEASE_NATIVE_CHECKLIST_ITEMS } from "./reviewPrompt.js";

const MAX_BALANCED_JSON_CANDIDATES = 64;

/** Extract JSON payloads from a reviewer's free-text output (fenced or bare). */
export function extractJsonBlocks(text: string): unknown[] {
  const results: unknown[] = [];
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === "object" && !Array.isArray(value);
  const isSingleFindingObject = (value: Record<string, unknown>): boolean =>
    "severity" in value && ("claim" in value || "message" in value || "evidence" in value);
  const isReviewPayload = (value: unknown, allowSingleObject: boolean): boolean => {
    if (Array.isArray(value)) return true;
    if (!isRecord(value)) return false;
    if (Array.isArray(value.findings)) return true;
    return allowSingleObject && isSingleFindingObject(value);
  };
  const tryParse = (candidate: string, allowSingleObject = false): boolean => {
    const trimmed = candidate.trim();
    if (!trimmed) return false;
    try {
      const parsed = JSON.parse(trimmed);
      if (!isReviewPayload(parsed, allowSingleObject)) return false;
      results.push(parsed);
      return true;
    } catch {
      return false;
    }
  };
  const findBalancedJsonEnd = (source: string, start: number): number | null => {
    const open = source[start];
    if (open !== "[" && open !== "{") return null;
    const stack: string[] = [open];
    let inString = false;
    let escaped = false;
    for (let i = start + 1; i < source.length; i += 1) {
      const ch = source[i] ?? "";
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === "[" || ch === "{") {
        stack.push(ch);
        continue;
      }
      if (ch === "]" || ch === "}") {
        const expected = ch === "]" ? "[" : "{";
        if (stack.pop() !== expected) return null;
        if (stack.length === 0) return i + 1;
      }
    }
    return null;
  };
  const isWhitespaceOnly = (source: string, start: number): boolean => {
    for (let i = start; i < source.length; i += 1) {
      const ch = source[i] ?? "";
      if (ch !== " " && ch !== "\t" && ch !== "\n" && ch !== "\r") return false;
    }
    return true;
  };
  const jsonLineStarts = (source: string, open: "[" | "{"): number[] => {
    const starts: number[] = [];
    let lineStart = 0;
    for (let i = 0; i <= source.length; i += 1) {
      if (i < source.length && source[i] !== "\n") continue;
      const lineEnd = i > lineStart && source[i - 1] === "\r" ? i - 1 : i;
      let first = lineStart;
      while (first < lineEnd) {
        const ch = source[first] ?? "";
        if (ch !== " " && ch !== "\t") break;
        first += 1;
      }
      const ch = source[first] ?? "";
      if (first < lineEnd && ch === open) starts.push(first);
      lineStart = i + 1;
    }
    return starts;
  };
  const fence = "```";
  let cursor = 0;
  let found = false;
  while (cursor < text.length) {
    const start = text.indexOf(fence, cursor);
    if (start < 0) break;
    const bodyStart = start + fence.length;
    const end = text.indexOf(fence, bodyStart);
    if (end < 0) break;
    let candidate = text.slice(bodyStart, end);
    if (candidate.startsWith("json")) candidate = candidate.slice("json".length);
    found = tryParse(candidate, true) || found;
    cursor = end + fence.length;
  }
  if (!found) {
    const trimmed = text.trim();
    if (!tryParse(trimmed, true)) {
      const arrayStarts = jsonLineStarts(trimmed, "[");
      const candidateStarts = arrayStarts.length > 0 ? arrayStarts : jsonLineStarts(trimmed, "{");
      // Bound adversarial fallback work while preserving the newest-payload policy.
      const starts = candidateStarts.slice(-MAX_BALANCED_JSON_CANDIDATES);
      for (let i = starts.length - 1; i >= 0; i -= 1) {
        const start = starts[i] ?? 0;
        const end = findBalancedJsonEnd(trimmed, start);
        if (end === null) continue;
        const candidate = trimmed.slice(start, end);
        if (isWhitespaceOnly(trimmed, end)) {
          if (tryParse(candidate, true)) break;
          continue;
        }
        // Some native transcripts duplicate status text after the model's final
        // JSON block. Prefer the last complete line-start JSON block over
        // discarding an otherwise valid reviewer response.
        if (tryParse(candidate, true)) break;
      }
    }
    const lines = trimmed.split(/\r?\n/);
    if (results.length === 0) {
      for (const line of lines) {
        const candidate = line.trim();
        if (
          (candidate.startsWith("[") && candidate.endsWith("]")) ||
          (candidate.startsWith("{") && candidate.endsWith("}"))
        ) {
          if (tryParse(candidate, true)) break;
        }
      }
    }
  }
  return results;
}

export interface ReviewerInfo {
  harness_id: string;
  requested_model?: string | null;
  requested_effort?: string | null;
  observed_model?: string | null;
  route_proof_status?: RouteProofStatus;
}

export function parseFindingsDetailed(
  text: string,
  reviewer: ReviewerInfo,
): { findings: ReviewFinding[]; malformed: number } {
  const raw: any[] = [];
  for (const block of extractJsonBlocks(text)) {
    if (Array.isArray(block)) raw.push(...block);
    else if (block && typeof block === "object") {
      const candidate = block as { findings?: unknown };
      if (Array.isArray(candidate.findings)) raw.push(...candidate.findings);
      else raw.push(block);
    }
  }
  const out: ReviewFinding[] = [];
  let malformed = 0;
  for (const r of raw) {
    if (!r || typeof r !== "object") {
      malformed += 1;
      continue;
    }
    // A finding WITHOUT a severity is malformed, not "WARN by default": the
    // fail-closed verdict parse must never silently downgrade what might have
    // been a blocker into a non-blocking level (the one lenient branch this
    // parser used to have).
    if (r.severity === undefined || r.severity === null) {
      malformed += 1;
      continue;
    }
    try {
      out.push(
        ReviewFindingSchema.parse({
          id: r.id ?? newId("f"),
          severity: r.severity,
          category: r.category ?? "correctness",
          claim: String(r.claim ?? r.message ?? "(no claim)"),
          linked_acceptance_criteria: r.linked_acceptance_criteria ?? [],
          evidence: r.evidence ?? {},
          proposed_fix: r.proposed_fix ?? null,
          reviewer: {
            harness_id: reviewer.harness_id,
            requested_model: reviewer.requested_model ?? null,
            requested_effort: reviewer.requested_effort ?? null,
            observed_model: reviewer.observed_model ?? null,
            route_proof_status: reviewer.route_proof_status ?? "unverified",
          },
          status: "proposed",
        }),
      );
    } catch {
      malformed += 1;
    }
  }
  return { findings: out, malformed };
}

export interface SealedReviewEnvelopeParse {
  findings: ReviewFinding[];
  malformed: number;
  error: string | null;
  blocks: unknown[];
}

/** Strict parser for a frozen release review. Generic/diff review intentionally
 * remains lenient; a sealed verdict is authority only when its completion
 * envelope proves every required checklist row and agrees with its findings. */
export function parseSealedReviewEnvelopeDetailed(
  text: string,
  reviewer: ReviewerInfo,
): SealedReviewEnvelopeParse {
  const blocks = extractAllReviewPayloads(text);
  if (blocks.length === 0) {
    return { findings: [], malformed: 0, error: "no sealed review envelope", blocks };
  }
  const unique = new Map(blocks.map((block) => [stableStringify(block), block]));
  if (unique.size !== 1) {
    return {
      findings: [],
      malformed: 0,
      error: "reviewer emitted divergent or mixed JSON review payloads",
      blocks,
    };
  }
  const envelope = unique.values().next().value as unknown;
  if (!isRecord(envelope) || !hasExactKeys(envelope, ["completion", "findings"])) {
    return { findings: [], malformed: 0, error: "invalid sealed review envelope shape", blocks };
  }
  const completion = envelope["completion"];
  const rawFindings = envelope["findings"];
  if (
    !isRecord(completion) ||
    !hasExactKeys(completion, ["checklist", "findingCount", "verdict"]) ||
    !Array.isArray(rawFindings)
  ) {
    return { findings: [], malformed: 0, error: "invalid sealed completion shape", blocks };
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
    return {
      findings: [],
      malformed: 0,
      error: "sealed checklist must contain the four exact completed items in order",
      blocks,
    };
  }
  const findingCount = completion["findingCount"];
  if (!Number.isSafeInteger(findingCount) || (findingCount as number) < 0) {
    return {
      findings: [],
      malformed: 0,
      error: "findingCount must be a non-negative integer",
      blocks,
    };
  }
  if (findingCount !== rawFindings.length) {
    return {
      findings: [],
      malformed: 0,
      error: "findingCount does not match findings.length",
      blocks,
    };
  }
  const parsed = parseFindingsDetailed(JSON.stringify({ findings: rawFindings }), reviewer);
  if (parsed.malformed > 0 || parsed.findings.length !== rawFindings.length) {
    return {
      findings: parsed.findings,
      malformed: parsed.malformed,
      error: "sealed findings contain malformed items",
      blocks,
    };
  }
  const expectedVerdict = parsed.findings.some((finding) =>
    ["BLOCK", "FIX_FIRST", "NEEDS_HUMAN", "INSUFFICIENT_EVIDENCE"].includes(finding.severity),
  )
    ? "FAIL"
    : "PASS";
  if (completion["verdict"] !== expectedVerdict) {
    return {
      findings: parsed.findings,
      malformed: 0,
      error: `completion verdict must be ${expectedVerdict} for these findings`,
      blocks,
    };
  }
  return { findings: parsed.findings, malformed: 0, error: null, blocks };
}

function extractAllReviewPayloads(text: string): unknown[] {
  const out: unknown[] = [];
  let cursor = 0;
  let attempts = 0;
  while (cursor < text.length) {
    const lineEnd = text.indexOf("\n", cursor);
    const end = lineEnd < 0 ? text.length : lineEnd;
    let start = cursor;
    while (start < end && (text[start] === " " || text[start] === "\t")) start += 1;
    const opener = text[start];
    if (opener !== "{" && opener !== "[") {
      cursor = lineEnd < 0 ? text.length : lineEnd + 1;
      continue;
    }
    attempts += 1;
    if (attempts > MAX_BALANCED_JSON_CANDIDATES) break;
    const jsonEnd = balancedJsonEnd(text, start);
    if (jsonEnd === null) {
      cursor = lineEnd < 0 ? text.length : lineEnd + 1;
      continue;
    }
    try {
      const value = JSON.parse(text.slice(start, jsonEnd));
      if (isReviewPayload(value)) {
        out.push(value);
        cursor = jsonEnd;
        continue;
      }
    } catch {
      // Continue at the next line; a later complete payload may still exist.
    }
    cursor = lineEnd < 0 ? text.length : lineEnd + 1;
  }
  return out;
}

function balancedJsonEnd(source: string, start: number): number | null {
  const first = source[start];
  if (first !== "{" && first !== "[") return null;
  const stack = [first];
  let inString = false;
  let escaped = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index] ?? "";
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{" || character === "[") stack.push(character);
    else if (character === "}" || character === "]") {
      if (stack.pop() !== (character === "}" ? "{" : "[")) return null;
      if (stack.length === 0) return index + 1;
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isReviewPayload(value: unknown): boolean {
  if (Array.isArray(value)) return true;
  if (!isRecord(value)) return false;
  return (
    Array.isArray(value["findings"]) ||
    ("severity" in value && ("claim" in value || "message" in value || "evidence" in value))
  );
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && hasOnlyKeys(value, keys);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

const SEVERITY_ORDER: Severity[] = [
  "INSUFFICIENT_EVIDENCE",
  "NIT",
  "OUT_OF_SCOPE",
  "WARN",
  "NEEDS_HUMAN",
  "FIX_FIRST",
  "BLOCK",
];

function severityRank(s: Severity): number {
  return SEVERITY_ORDER.indexOf(s);
}

/**
 * Merge near-duplicate findings (same category + claim + file set), keeping the
 * most severe. NEEDS_HUMAN is an orthogonal human-gate, not a severity rung — it
 * is never collapsed into (or replaced by) another finding, so a same-key BLOCK
 * from a second reviewer can never silently swallow a human-approval escalation.
 */
export function dedupeFindings(findings: ReviewFinding[]): ReviewFinding[] {
  const seen = new Map<string, ReviewFinding>();
  const humanGates: ReviewFinding[] = [];
  const insufficientEvidence: ReviewFinding[] = [];
  for (const f of findings) {
    if (f.severity === "NEEDS_HUMAN") {
      humanGates.push(f);
      continue;
    }
    if (f.severity === "INSUFFICIENT_EVIDENCE") {
      insufficientEvidence.push(f);
      continue;
    }
    const files = f.evidence.files
      .map((x) => x.path)
      .sort()
      .join(",");
    const key = `${f.category}|${f.claim.toLowerCase().slice(0, 120)}|${files}`;
    const existing = seen.get(key);
    if (!existing || severityRank(f.severity) > severityRank(existing.severity)) {
      seen.set(key, f);
    }
  }
  return [...seen.values(), ...humanGates, ...insufficientEvidence];
}

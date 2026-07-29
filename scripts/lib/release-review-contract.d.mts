export const REQUIRED_TRIAD_MODELS: readonly string[];
export const REQUIRED_SCOPE_MODEL: string;
export const RELEASE_REVIEW_LIMITS_AUTHORITY: Readonly<{ source: string; verifiedAt: string }>;
export const RELEASE_REVIEW_MODEL_LIMITS: Readonly<
  Record<string, Readonly<{ contextTokens: number; maxOutputTokens: number }>>
>;
export const RELEASE_REVIEW_FRAMING_RESERVE_TOKENS: number;
export function reviewPromptContextPreflight(
  model: string,
  prompt: string | Buffer,
  maxOutputTokens: number,
): {
  ok: boolean;
  reasons: string[];
  model?: string;
  promptBytes?: number;
  framingReserveTokens?: number;
  inputTokenUpperBound?: number;
  maxOutputTokens?: number;
  contextTokens?: number;
  modelMaxOutputTokens?: number;
};
export function compactRepositoryAtlas(
  rows: readonly { path: string; bytes: number | null }[],
): string;
export function reviewSplitOptionContract(
  packSubset: unknown,
  diffSubset: unknown,
  subWave: unknown,
): { ok: boolean; reasons: string[]; splitRequested: boolean };
export const TRIAD_ITEMS: readonly string[];
export const SCOPE_ITEMS: readonly string[];
export const RELEASE_REVIEW_ATTESTATION_ALGORITHM: "Ed25519";
export const REVIEWER_MIN_PLAUSIBLE_MS: number;
export function livenessFloorMs(promptChars: number): number;
export const OWNER_REVIEW_ATTESTATION_SCHEMA_VERSION: 4;
export const OWNER_REVIEW_PROTOCOL: "owner-fable-subagents-v1";
export const OWNER_REVIEW_MIN_REVIEWS: 2;
export const OWNER_REVIEW_MAX_ROUNDS: 24;
export const OWNER_REVIEW_VERDICTS: readonly string[];
export const RELEASE_REVIEW_RUNTIME_ARTIFACT_PATHS: readonly string[];
export function validateReleaseReviewRuntimeArtifacts(artifacts: unknown): string[];

export interface ChecklistFinding {
  item: string;
  verdict: "PASS" | "FAIL";
  severity: "critical" | "advisory";
  reason: string;
  model: string;
  /** Blocker contract [INV-139]: violated invariant/criterion citation. */
  invariant?: string;
  /** Blocker contract [INV-139]: reachable in the default configuration. */
  reachable?: boolean;
}

export interface ChecklistValidation {
  status: "responded" | "partial" | "parse_failure" | "empty_response";
  findings: ChecklistFinding[];
  missingItems: string[];
  error: string | null;
}

export function exactPanelMatch(triadModels: readonly string[], scopeModel: string): boolean;
export function panelSubWaves(
  reviews: readonly { panel?: { subWave?: unknown } | null }[],
): Set<string>;
export function validateReviewPanelCoverage(
  reviews: readonly {
    reviewer?: unknown;
    reportSha256?: unknown;
    verdict?: unknown;
    panel?: { slot?: unknown; model?: unknown; subWave?: unknown } | null;
  }[],
): string[];
export function validateCoverageReceipt(
  receipt: unknown,
  expected: { candidateSha: string },
  options: { required: boolean; namedSubWaves?: readonly string[] },
): string[];
export interface PanelLockBinding {
  candidateSha: string;
  candidateTree: string;
  packetManifestSha256: string;
}
export interface ParsedPanelLock {
  triad?: string;
  scope?: string;
  candidate_sha?: string;
  candidate_tree?: string;
  packet_manifest_sha256?: string;
}
export function panelLockText(binding: PanelLockBinding): string;
export function validatePanelLock(
  lock: ParsedPanelLock | null,
  binding: PanelLockBinding,
): { ok: boolean; reasons: string[] };
export function validateReleaseInput(
  mode: unknown,
  ref: string,
): { ok: boolean; reasons: string[] };
export function canonicalJson(value: any): string;
export function releaseAttestationSigningBytes(attestation: any): Buffer;
export function verifyReleaseAttestationSignature(
  attestation: any,
  authority: any,
  expectedSchemaVersion?: number,
): { ok: boolean; reasons: string[] };
export function validateFullGateEvidence(
  gate: any,
  expected: { candidateSha: string; candidateTree: string },
): string[];
export function validateOwnerReviewAttestationPayload(
  payload: any,
  expected: { candidateSha: string; candidateTree: string },
): { ok: boolean; reasons: string[] };
export function validateReleaseAttestation(
  attestation: any,
  authority: any,
  expected: { candidateSha: string; candidateTree: string },
): { ok: boolean; reasons: string[] };
export function pathIsWithin(root: string, target: string): boolean;
export function validateNewReviewOutput(
  candidateRoot: string,
  packetRoot: string,
  outDir: string,
  exists: boolean,
): { ok: boolean; reasons: string[] };
export function validateFrozenReviewBinding(input: {
  candidateSha: string;
  candidateTree: string;
  actualSha: string;
  actualTree: string;
  dirty: boolean;
}): { ok: boolean; reasons: string[] };
export function decodeReviewUtf8(value: string | Buffer, label?: string): string;
export const READABLE_DIFF_SLICE_HEADER: string;
export const READABLE_DIFF_SLICE_FOOTER: string;
export const FULL_TEXT_FILE_HEADER: string;
export const FULL_TEXT_FILE_FOOTER: string;
export const CHANGED_FILE_INVENTORY_HEADER: string;
export const CHANGED_FILE_INVENTORY_FOOTER: string;
export function readableDiffSliceSection(diff: string | Buffer): string;
export function extractReadableDiffSlice(prompt: string | Buffer): {
  ok: boolean;
  error: string | null;
  bytes: Buffer | null;
  sha256: string | null;
};
export function changedFileInventoryBody(
  entries: ReadonlyArray<{
    status: string;
    oldPath?: string;
    path: string;
    deleted: boolean;
  }>,
): string;
export function changedFileInventorySection(
  entries: ReadonlyArray<{
    status: string;
    oldPath?: string;
    path: string;
    deleted: boolean;
  }>,
): string;
export function extractChangedFileInventory(prompt: string | Buffer): {
  ok: boolean;
  error: string | null;
  body: Buffer | null;
  sha256: string | null;
};
export function touchedFileBody(path: string, text: string | Buffer): string;
export function touchedFileSection(path: string, text: string | Buffer): string;
export function extractTouchedFileSections(prompt: string | Buffer): {
  ok: boolean;
  error: string | null;
  sections: Array<{
    body: Buffer;
    sha256: string;
    path: string;
    content: Buffer;
  }>;
};
export const TOUCHED_FILE_OMISSION_MARKER: string;
export function buildTouchedFilePack(
  paths: readonly string[],
  git: (args: string[]) => string | Buffer,
  maxFileBytes: number,
  maxPackBytes: number,
  options?: { onOmission?: "note" | "throw" },
): string;
export function completionTermination(finishReason: unknown): {
  complete: boolean;
  error: string | null;
};
export function parseChecklistJson(raw: unknown): unknown[] | null;
export function validateChecklistResponse(
  items: unknown,
  model: string,
  requiredItems: readonly string[],
): ChecklistValidation;
export function blockingFindings(findings: readonly ChecklistFinding[]): ChecklistFinding[];
export function blockerContractGaps(
  findings: readonly ChecklistFinding[],
): Array<{ finding: ChecklistFinding; gaps: string[] }>;
export interface ReviewerSlotRecord {
  status: string;
  model_id?: string;
  duration_ms?: number;
  findings?: ChecklistFinding[];
}
export function reviewerLiveness(
  actor: ReviewerSlotRecord | null | undefined,
  minPlausibleMs?: number,
): { live: boolean; reason: string | null };
export function reviewDecisionLivenessFloors(
  triadPromptChars: number,
  scopePromptChars: number,
): { minPlausibleMs: number; scopeMinPlausibleMs: number };
export function releaseReviewDecision(input: {
  triadActors: ReviewerSlotRecord[];
  scope: (ReviewerSlotRecord & { metadata?: { duration_ms?: number } }) | null;
  minPlausibleMs?: number;
  scopeMinPlausibleMs?: number;
}): {
  passed: boolean;
  responsiveTriad: number;
  blockingFindings: ChecklistFinding[];
  blockerContractGaps: Array<{ finding: ChecklistFinding; gaps: string[] }>;
  reasons: string[];
};
export function validateSlotRecord(
  record: unknown,
  expected: {
    candidateSha: string;
    candidateTree: string;
    packetManifestSha256?: string | null;
    fullGateReceiptSha256: string;
    reviewRuntimeArtifacts: unknown;
    waveId?: string | null;
  },
): string[];
export function deriveSlotVerdict(
  rawText: string,
  panelSlot: "triad" | "scope",
): "error" | "blocked" | "warn" | "pass";

export interface ReviewDiffEntry {
  status: string;
  oldPath?: string;
  path: string;
  deleted: boolean;
}
export interface FullTextCoverageReport {
  ok: boolean;
  covered: string[];
  uncovered: Array<{ path: string; reason: string }>;
  skipped: Array<{ path: string; rule: string }>;
  deleted: string[];
  duplicates: Array<{ path: string; prompts: number[] }>;
  invalidEnvelopes: Array<{ promptIndex: number; reason: string }>;
  unexpectedSections: Array<{ promptIndex: number; sectionIndex: number }>;
  pathsByPrompt: string[][];
}
export interface DiffCoverageReport {
  ok: boolean;
  covered: number;
  total: number;
  uncovered: string[];
  duplicates: string[];
  invalidSlices: Array<{ promptIndex: number; reason: string }>;
  pathsByPrompt: string[][];
}
export interface InventoryCoverageReport {
  ok: boolean;
  covered: number;
  total: number;
  invalid: Array<{ promptIndex: number; reason: string }>;
}
export type DiffReceiptReport = Omit<DiffCoverageReport, "pathsByPrompt">;
export interface ReviewCoverageReport {
  ok: boolean;
  fullText: { triad: FullTextCoverageReport; scope: FullTextCoverageReport };
  diff: {
    sealedSha256: string;
    sealedBytes: number;
    entries: number;
    triad: DiffCoverageReport;
    scope: DiffCoverageReport;
  };
  inventory: { triad: InventoryCoverageReport; scope: InventoryCoverageReport };
  subWaveMismatches: Array<{ subWave: string; reason: string }>;
}
export interface CoverageReceiptBody {
  schemaVersion: 2;
  ok: boolean;
  base: string;
  candidate: string;
  packs: Array<{
    subWave: string;
    triadPath: string;
    scopePath: string;
    triadSha256: string;
    scopeSha256: string;
  }>;
  wholeFileList: string | null;
  fullText: {
    triad: Pick<
      FullTextCoverageReport,
      "uncovered" | "duplicates" | "invalidEnvelopes" | "unexpectedSections"
    > & { covered: number };
    scope: Pick<
      FullTextCoverageReport,
      "uncovered" | "duplicates" | "invalidEnvelopes" | "unexpectedSections"
    > & { covered: number };
    diffAuthoritativeSkips: number;
    deleted: number;
  };
  diff: {
    sealedSha256: string;
    sealedBytes: number;
    entries: number;
    triad: DiffReceiptReport;
    scope: DiffReceiptReport;
  };
  inventory: ReviewCoverageReport["inventory"];
  subWaveMismatches: Array<{ subWave: string; reason: string }>;
}
export type BoundCoverageReceipt = Omit<CoverageReceiptBody, "packs" | "wholeFileList"> & {
  packs: Array<{ subWave: string; triadSha256: string; scopeSha256: string }>;
};

export const CANONICAL_REVIEW_RENAME_ARG: string;
export const GENERATED_ARTIFACT_ALLOWLIST: readonly string[];
export function diffAuthoritativeRule(path: string, allowlist?: readonly string[]): string | null;
export function fileCoverage(
  path: string,
  currentText: string | Buffer,
  packContents: readonly (string | Buffer)[],
): { covered: boolean; reason: string | null };
export function checkCoverage(input: {
  files: ReadonlyArray<{ path: string; deleted?: boolean }>;
  readCurrentText: (path: string) => string | Buffer;
  packContents: readonly (string | Buffer)[];
  allowlist?: readonly string[];
}): {
  ok: boolean;
  covered: string[];
  uncovered: Array<{ path: string; reason: string }>;
  skipped: Array<{ path: string; rule: string }>;
  deleted: string[];
};
export function checkFullTextPartition(input: {
  files: ReadonlyArray<{ path: string; deleted?: boolean }>;
  readCurrentText: (path: string) => string | Buffer;
  promptContents: readonly (string | Buffer)[];
  allowlist?: readonly string[];
}): FullTextCoverageReport;
export function parseNameStatusEntriesZ(raw: string | Buffer): ReviewDiffEntry[];
export function parseNameStatusZ(raw: string | Buffer): Array<{ path: string; deleted: boolean }>;
export function buildCanonicalDiffPatches(
  entries: ReviewDiffEntry[],
  readPatch: (entry: ReviewDiffEntry) => string | Buffer,
): Array<ReviewDiffEntry & { index: number; bytes: Buffer; sha256: string }>;
export function checkDiffCoverage(input: {
  expectedPatches: ReadonlyArray<ReviewDiffEntry & { index: number; bytes: Buffer }>;
  promptContents: readonly (string | Buffer)[];
}): DiffCoverageReport;
export function checkSubWavePairing(input: {
  requiredPaths: readonly string[];
  diffPathsByPrompt: readonly (readonly string[])[];
  fullTextPathsByPrompt: readonly (readonly string[])[];
  packs: ReadonlyArray<{ subWave: string }>;
  role: string;
}): Array<{ subWave: string; reason: string }>;
export function checkChangedFileInventory(input: {
  expectedEntries: readonly ReviewDiffEntry[];
  promptContents: readonly (string | Buffer)[];
}): InventoryCoverageReport;
export function parseWholeFileList(listText: string): string[];
export function unionWithWholeFileList(
  files: Array<{ path: string; deleted: boolean }>,
  listText: string | null,
): Array<{ path: string; deleted: boolean }>;
export function runCoverage(input: {
  base: string;
  candidate: string;
  packs: ReadonlyArray<{ subWave: string; triadPath: string; scopePath: string }>;
  wholeFileListPath?: string | null;
}): { report: ReviewCoverageReport; sealedDiff: Buffer; receiptBody: CoverageReceiptBody };
export function bindCoverageReceipt(
  receipt: CoverageReceiptBody,
  candidateSha: string,
  authority?: {
    baseSha?: string;
    wholeFileListPath?: string | null;
    diffPath?: string | null;
  },
): BoundCoverageReceipt;
export function coverageReceiptBody(
  report: ReviewCoverageReport,
  input: {
    base: string;
    candidate: string;
    packs: ReadonlyArray<{ subWave: string; triadPath: string; scopePath: string }>;
    triadPrompts: readonly (string | Buffer)[];
    scopePrompts: readonly (string | Buffer)[];
    wholeFileList?: string | null;
  },
): CoverageReceiptBody;

export const RELEASE_REVIEW_ATTESTATION_ALGORITHM: "Ed25519";
export const OWNER_REVIEW_ATTESTATION_SCHEMA_VERSION: 6;
export const OWNER_REVIEW_PROTOCOL: "cursor-operator-fable-sol-v1";
export const OWNER_REVIEW_VERDICTS: readonly ["pass", "warn"];
export const OWNER_REVIEW_SCOPES: readonly ["full"];
export const ARCHIVED_OWNER_REVIEW_SCHEMA_VERSIONS: readonly [2, 3, 4, 5];
export const RELEASE_REVIEW_VERIFIER_ARTIFACT_PATH: "release-review-verifier.mjs";
export const RELEASE_REVIEW_CLI_ARTIFACT_PATH: "claudexor.bundle.cjs";
export const RELEASE_REVIEW_RUNTIME_ARTIFACT_PATHS: readonly [
  "release-review-verifier.mjs",
  "claudexor.bundle.cjs",
];
export const RELEASE_REVIEW_MIN_PLAUSIBLE_MS: 1000;
/** Owner decision 2026-08-06: the review pair runs as Cursor operator
 * subagents; both slots get the full context. Operator decision 2026-08-06
 * ~08:29: each slot accepts one slug from its owner-approved tier set; the
 * actually used slug is sealed, out-of-set membership refuses fail-closed. */
export const OWNER_REVIEW_PANEL: readonly [
  Readonly<{
    slot: "fable";
    allowedModels: readonly ["claude-fable-5-thinking-max", "claude-fable-5-thinking-medium"];
  }>,
  Readonly<{
    slot: "sol";
    allowedModels: readonly ["gpt-5.6-sol-max", "gpt-5.6-sol-medium"];
  }>,
];

export function decodeReviewUtf8(value: string | Buffer, label?: string): string;
export function validateReleaseInput(
  mode: unknown,
  ref: string,
): { ok: boolean; reasons: string[] };
export function canonicalJson(value: unknown): string;
export function releaseAttestationSigningBytes(attestation: any): Buffer;
export function verifyReleaseAttestationSignature(
  attestation: any,
  authority: any,
  expectedSchemaVersion?: number,
): { ok: boolean; reasons: string[] };
export function verifyArchivedReleaseAttestationSignature(
  attestation: any,
  authority: any,
): { ok: boolean; reasons: string[] };
export function validateFullGateEvidence(
  gate: any,
  expected: { candidateSha: string; candidateTree: string },
): string[];
export function validateFullGateReceipt(
  receipt: any,
  expected: { candidateSha: string; candidateTree: string },
): string[];
export function validateReleaseReviewRuntimeArtifacts(value: unknown): string[];
export function validateOwnerReviewAttestationPayload(
  payload: any,
  expected: { candidateSha: string; candidateTree: string; candidateVersion: string },
): { ok: boolean; reasons: string[] };
export function validateReleaseAttestation(
  attestation: any,
  authority: any,
  expected: { candidateSha: string; candidateTree: string; candidateVersion: string },
): { ok: boolean; reasons: string[] };
export function pathIsWithin(root: string, target: string): boolean;
export function hasExactKeys(value: unknown, keys: readonly string[]): boolean;

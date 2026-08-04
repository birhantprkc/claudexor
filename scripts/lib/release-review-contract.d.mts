export const RELEASE_REVIEW_ATTESTATION_ALGORITHM: "Ed25519";
export const OWNER_REVIEW_ATTESTATION_SCHEMA_VERSION: 5;
export const OWNER_REVIEW_PROTOCOL: "native-full-context-v1";
export const OWNER_REVIEW_VERDICTS: readonly ["pass", "warn"];
export const ARCHIVED_OWNER_REVIEW_SCHEMA_VERSIONS: readonly [2, 3, 4];
export const RELEASE_REVIEW_VERIFIER_ARTIFACT_PATH: "release-review-verifier.mjs";
export const RELEASE_REVIEW_CLI_ARTIFACT_PATH: "claudexor.bundle.cjs";
export const RELEASE_REVIEW_RUNTIME_ARTIFACT_PATHS: readonly [
  "release-review-verifier.mjs",
  "claudexor.bundle.cjs",
];
export const RELEASE_REVIEW_MIN_PLAUSIBLE_MS: 1000;
export const REQUIRED_NATIVE_REVIEWERS: readonly Readonly<{
  slot: "fable" | "sol";
  harnessId: "claude" | "cursor";
  providerFamily: "anthropic" | "cursor";
  requestedModel: "claude-fable-5" | "gpt-5.6-sol-xhigh";
  requestedEffort: "max" | null;
}>[];
export const EXPECTED_OBSERVED_MODELS: Readonly<Record<"fable" | "sol", string>>;
export function expectedObservedModel(required: { slot: string; requestedModel: string }): string;

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

export interface ReleaseReviewRuntimeArtifact {
  path: string;
  bytes: number;
  sha256: string;
}

export interface VerifiedReleaseReviewRuntime {
  artifacts: ReleaseReviewRuntimeArtifact[];
  verifierBytes: Buffer;
  cli: ReleaseReviewRuntimeArtifact & { absolutePath: string };
}

export function buildReleaseReviewRuntimeArtifacts(
  repoRoot: string,
  artifactRoot: string,
  candidateSha: string,
): Promise<ReleaseReviewRuntimeArtifact[]>;
export function bundleReleaseReviewVerifier(
  repoRoot: string,
  outfile?: string,
): Promise<{ contents: Uint8Array; inputs: string[] }>;
export function assertExactCandidateInputs(root: string, inputs: readonly string[]): void;
export function readStableReviewFile(path: string, label: string): Buffer;
export function snapshotReleaseReviewRuntimeArtifacts(
  artifactRoot: string,
): ReleaseReviewRuntimeArtifact[];
export function readVerifiedReleaseReviewRuntime(
  artifactRoot: string,
  expected: unknown,
): VerifiedReleaseReviewRuntime;
export function releaseReviewRuntimeArtifactRoot(receiptPath: string): string;

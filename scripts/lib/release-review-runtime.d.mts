export interface ReleaseReviewRuntimeArtifact {
  path: string;
  bytes: number;
  sha256: string;
}

export function buildReleaseReviewRuntimeBundle(
  repoRoot: string,
  artifactRoot: string,
): Promise<ReleaseReviewRuntimeArtifact[]>;
export function readStableReviewFile(path: string, label: string): Buffer;

export function snapshotReleaseReviewRuntimeArtifacts(
  artifactRoot: string,
): ReleaseReviewRuntimeArtifact[];
export function verifyReleaseReviewRuntimeArtifacts(
  artifactRoot: string,
  expected: unknown,
): ReleaseReviewRuntimeArtifact[];
export function readVerifiedReleaseReviewRuntimeArtifact(
  artifactRoot: string,
  expected: unknown,
): { artifacts: ReleaseReviewRuntimeArtifact[]; bytes: Buffer };
export function releaseReviewRuntimeArtifactRoot(receiptPath: string): string;

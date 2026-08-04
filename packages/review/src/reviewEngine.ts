import type { HarnessAdapter } from "@claudexor/core";
import { preflightEvidence, type DiffEvidence, writeDiffEvidence } from "@claudexor/context";
import type {
  AuthPreference,
  EffortHint,
  HarnessEvent,
  ProviderFamily,
  ReviewFinding,
  RouteProof,
} from "@claudexor/schema";
import { HarnessRunSpec, ReviewFinding as ReviewFindingSchema } from "@claudexor/schema";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import {
  appendLine,
  containsSecretLikeToken,
  engineBuildIdentity,
  ensureDir,
  newId,
  nowIso,
  readTextSafe,
  redactSecrets,
  sha256,
  writeJson,
  writeText,
} from "@claudexor/util";
import {
  dedupeFindings,
  extractJsonBlocks,
  parseFindingsDetailed,
  parseSealedReviewEnvelopeDetailed,
  sealedReviewTranscriptChunk,
  type ReviewerInfo,
} from "./findings.js";
import { buildReviewPrompt, SEALED_REVIEW_OUTPUT_SCHEMA } from "./reviewPrompt.js";
import { sealedReviewTranscriptFromEvents } from "./sealedReviewEnvelope.js";
import {
  buildReviewerCandidateInventory,
  cleanupTemporaryReviewerWorkspaceBaseDir,
  copyReviewEvidencePacket,
  extractDiffPostimagePaths,
  isSameOrInside,
  prepareReviewerWorkspace,
  selectReviewerWorkspaceBaseDir,
} from "./reviewerWorkspace.js";
export { extractDiffPostimagePaths as __testExtractDiffPostimagePaths } from "./reviewerWorkspace.js";
import { buildRouteProof, classifyDiversity } from "./route.js";
import type {
  ReviewerArtifactContext,
  ReviewCandidateResult,
  ReviewerOutput,
  ReviewerProgressEvent,
  ReviewerWorkspace,
} from "./reviewRuntimeTypes.js";
export type { ReviewCandidateResult, ReviewerProgressEvent } from "./reviewRuntimeTypes.js";
import { reviewerAuthMode, reviewerAuthSwitchFromEvent } from "./reviewRuntimeTypes.js";
import { ReviewerCostKnowledge } from "./reviewerCostKnowledge.js";
import { ReviewerSpendAccumulator, type PartialReviewerSpend } from "./reviewerSpendAccumulator.js";

export interface ReviewerSpec {
  adapter: HarnessAdapter;
  providerFamily: ProviderFamily;
  requestedModel?: string | null;
  requestedEffort?: EffortHint | null;
  authPreference?: AuthPreference | null;
}

export interface ReviewCandidateInput {
  candidateLabel: string;
  diff: string;
  evidenceDir: string;
  artifactsDir?: string;
  evidenceReadOnly?: boolean;
  frozenIdentity?: {
    candidateSha: string;
    candidateTree: string;
    packetManifestSha256: string;
  };
  /** Owner-amended per-harness delta scope (INV-125 second amendment,
   * 2026-08-04): the named reviewer's review SUBJECT becomes the sealed
   * DELTA.patch (base SHA recorded here) while the full packet stays its
   * context. Sealed-packet mode only; at least one lane stays full-context. */
  deltaScopes?: Readonly<Record<string, string>>;
  cwd: string;
  reviewers: ReviewerSpec[];
  reviewerTimeoutMs?: number;
  transientRetryPolicy?: TransientRetryPolicy;
  envInheritance?: "mirror_native" | "clean";
  env?: Record<string, string>;
  signal?: AbortSignal;
  onReviewerEvent?: (event: ReviewerProgressEvent) => void;
}

const DEFAULT_REVIEWER_TIMEOUT_MS = 10 * 60_000;
export interface TransientRetryPolicy {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
}
const DEFAULT_REVIEWER_TRANSIENT_RETRY_POLICY: TransientRetryPolicy = {
  maxRetries: 2,
  initialDelayMs: 1_000,
  maxDelayMs: 10_000,
};
const REVIEW_WAVE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function readExistingDiffEvidence(dir: string, diff: string): DiffEvidence {
  const diffText = diff.endsWith("\n") ? diff : `${diff}\n`;
  const summaryPath = join(dir, "DIFF_SUMMARY.md");
  const summary = readTextSafe(summaryPath);
  if (summary === null) throw new Error("sealed review packet is missing DIFF_SUMMARY.md");
  return {
    diffPath: join(dir, "DIFF.patch"),
    summaryPath,
    diffSha256: sha256(diffText),
    summary,
  };
}

/** Sealed delta evidence for an owner-amended delta-scope lane: DELTA.patch +
 * DELTA_SUMMARY.md ride the manifest-verified packet like every sealed file. */
function readSealedDeltaEvidence(dir: string): DiffEvidence {
  const diffPath = join(dir, "DELTA.patch");
  const summaryPath = join(dir, "DELTA_SUMMARY.md");
  const diffText = readTextSafe(diffPath);
  const summary = readTextSafe(summaryPath);
  if (diffText === null || summary === null) {
    throw new Error("delta-scope review requires sealed DELTA.patch and DELTA_SUMMARY.md");
  }
  return { diffPath, summaryPath, diffSha256: sha256(diffText), summary };
}

function reviewerRouteProof(
  reviewer: ReviewerSpec,
  modelId: string | null,
  source: RouteProof["observed"]["evidence_source"],
  peerFamilies: ProviderFamily[],
): RouteProof {
  return buildRouteProof(
    {
      harness_id: reviewer.adapter.id,
      provider_family: reviewer.providerFamily,
      model_hint: reviewer.requestedModel ?? null,
    },
    {
      provider: reviewer.providerFamily,
      model_id: modelId,
      evidence_source: modelId ? source : "unavailable",
    },
    peerFamilies,
  );
}

function reviewerInfo(
  reviewer: ReviewerSpec,
  routeProofStatus: RouteProof["status"],
  observedModel: string | null = null,
): ReviewerInfo {
  return {
    harness_id: reviewer.adapter.id,
    requested_model: reviewer.requestedModel ?? null,
    requested_effort: reviewer.requestedEffort ?? null,
    observed_model: observedModel,
    route_proof_status: routeProofStatus,
  };
}

export async function reviewCandidate(input: ReviewCandidateInput): Promise<ReviewCandidateResult> {
  const sourceRoot = resolve(input.cwd);
  const sourceExists = existsSync(sourceRoot);
  const canonicalSourceRoot = sourceExists ? realpathSync(sourceRoot) : sourceRoot;
  const sourceEvidencePath = resolve(input.evidenceDir);
  const sourceEvidenceRoot = existsSync(input.evidenceDir)
    ? realpathSync(input.evidenceDir)
    : sourceEvidencePath;
  if (sourceExists && isSameOrInside(sourceEvidenceRoot, canonicalSourceRoot)) {
    throw new Error("review evidence directory must not contain the candidate root");
  }
  const evidenceInsideLexicalSource =
    sourceExists && isSameOrInside(sourceRoot, sourceEvidencePath);
  const evidenceInsideCanonicalSource =
    sourceExists && isSameOrInside(canonicalSourceRoot, sourceEvidenceRoot);
  const evidencePathInSourceNamespace = evidenceInsideCanonicalSource
    ? resolve(sourceRoot, relative(canonicalSourceRoot, sourceEvidenceRoot))
    : null;
  const candidateEvidenceExcludeRoots =
    evidenceInsideLexicalSource || evidenceInsideCanonicalSource
      ? [
          ...new Set(
            [sourceEvidencePath, sourceEvidenceRoot, evidencePathInSourceNamespace].filter(
              (path): path is string => path !== null,
            ),
          ),
        ]
      : [];
  const findingsByReviewer: ReviewFinding[][] = input.reviewers.map(() => []);
  const reviewerFamilies = input.reviewers.map((reviewer) => reviewer.providerFamily);
  const routeProofs: RouteProof[] = input.reviewers.map((reviewer, index) =>
    reviewerRouteProof(
      reviewer,
      null,
      "unavailable",
      reviewerFamilies.filter((_, otherIndex) => otherIndex !== index),
    ),
  );
  const reviewerRequests: ReviewCandidateResult["reviewerRequests"] = input.reviewers.map(
    (reviewer) => ({
      harness_id: reviewer.adapter.id,
      provider_family: reviewer.providerFamily,
      requested_model: reviewer.requestedModel ?? null,
      requested_effort: reviewer.requestedEffort ?? null,
    }),
  );
  const healthyReviewerIndexes = new Set<number>();
  const reviewerSpend = new ReviewerSpendAccumulator(input.reviewers.length);
  const reviewerTimeoutMs = input.reviewerTimeoutMs ?? DEFAULT_REVIEWER_TIMEOUT_MS;
  const reviewWaveId =
    input.env?.["CLAUDEXOR_REVIEW_WAVE_ID"] ?? process.env["CLAUDEXOR_REVIEW_WAVE_ID"] ?? null;
  if (input.evidenceReadOnly && input.frozenIdentity && !REVIEW_WAVE_ID.test(reviewWaveId ?? "")) {
    throw new Error("sealed release review requires CLAUDEXOR_REVIEW_WAVE_ID UUID");
  }
  const frozenMetadata = input.frozenIdentity
    ? (() => {
        const runtime = engineBuildIdentity();
        const runtimeEntry = realpathSync(runtime.entry);
        const runtimeEntryStat = lstatSync(runtimeEntry);
        if (!runtimeEntryStat.isFile() || runtimeEntryStat.isSymbolicLink()) {
          throw new Error("sealed release review runtime entry is not a regular file");
        }
        return {
          candidate_sha: input.frozenIdentity.candidateSha,
          candidate_tree: input.frozenIdentity.candidateTree,
          packet_manifest_sha256: input.frozenIdentity.packetManifestSha256,
          review_runtime_version: runtime.version,
          review_runtime_build_sha: runtime.sha,
          review_runtime_entry: runtimeEntry,
          review_runtime_entry_sha256: createHash("sha256")
            .update(readFileSync(runtimeEntry))
            .digest("hex"),
          ...(reviewWaveId ? { review_wave_id: reviewWaveId } : {}),
        };
      })()
    : {};
  if (containsSecretLikeToken(input.diff || "(empty diff)\n")) {
    throw new Error(
      "diff evidence contains a secret-like token; refusing to persist raw DIFF.patch",
    );
  }
  if (input.evidenceReadOnly) {
    const packetDiff = readTextSafe(join(input.evidenceDir, "DIFF.patch"));
    const normalizedDiff = input.diff.endsWith("\n") ? input.diff : `${input.diff}\n`;
    if (packetDiff === null || packetDiff !== normalizedDiff) {
      throw new Error("sealed review packet DIFF.patch does not match the verified review diff");
    }
  } else {
    writeDiffEvidence(input.evidenceDir, input.diff);
  }
  const preflight = preflightEvidence(input.evidenceDir);
  if (!preflight.ok) {
    const parts = [
      preflight.missing.length > 0 ? `missing: ${preflight.missing.join(", ")}` : "",
      preflight.empty.length > 0 ? `empty: ${preflight.empty.join(", ")}` : "",
    ].filter(Boolean);
    throw new Error(`mandatory evidence preflight failed (${parts.join("; ")})`);
  }
  const postimagePaths = extractDiffPostimagePaths(input.diff);
  const candidateInventory = await buildReviewerCandidateInventory(
    input.cwd,
    postimagePaths,
    input.evidenceReadOnly === true,
  );
  const artifactsBaseDir = input.artifactsDir ?? join(input.evidenceDir, "reviewer-artifacts");
  if (
    input.evidenceReadOnly &&
    input.frozenIdentity &&
    existsSync(artifactsBaseDir) &&
    readdirSync(artifactsBaseDir).length > 0
  ) {
    throw new Error("sealed release review requires a fresh empty artifacts directory");
  }
  ensureDir(artifactsBaseDir);
  const persistentEvidenceDir = join(artifactsBaseDir, "evidence");
  await copyReviewEvidencePacket(
    input.evidenceDir,
    persistentEvidenceDir,
    input.evidenceReadOnly === true,
  );
  const persistentPatch = input.evidenceReadOnly
    ? readExistingDiffEvidence(persistentEvidenceDir, input.diff)
    : writeDiffEvidence(persistentEvidenceDir, input.diff);
  writeJson(
    input.evidenceReadOnly
      ? join(artifactsBaseDir, "evidence-metadata.json")
      : join(persistentEvidenceDir, "metadata.json"),
    {
      source_evidence_dir: input.evidenceDir,
      candidate_root: input.cwd,
      persistent_evidence_dir: persistentEvidenceDir,
      diff_path: persistentPatch.diffPath,
      summary_path: persistentPatch.summaryPath,
      diff_sha256: persistentPatch.diffSha256,
      candidate_inventory_mode: candidateInventory.mode,
      candidate_inventory_reason: candidateInventory.reason,
      ...frozenMetadata,
    },
  );
  const artifacts: (ReviewerArtifactContext | undefined)[] = input.reviewers.map(() => undefined);
  const reviewerWorkspaceBaseDir = selectReviewerWorkspaceBaseDir(
    input.cwd,
    artifactsBaseDir,
    input.evidenceDir,
  );

  const runReviewer = async (reviewer: ReviewerSpec, index: number): Promise<void> => {
    if (input.signal?.aborted) return;
    const artifact = createReviewerArtifactContext(artifactsBaseDir, index, reviewer);
    artifacts[index] = artifact;
    let reviewerWorkspace: ReviewerWorkspace | null = null;
    let spec: HarnessRunSpec | null = null;
    try {
      reviewerWorkspace = await prepareReviewerWorkspace({
        sourceRoot: input.cwd,
        sourceEvidenceDir: persistentEvidenceDir,
        workspaceBaseDir: reviewerWorkspaceBaseDir,
        reviewerDirName: `${String(index + 1).padStart(2, "0")}-${safeFilePart(reviewer.adapter.id)}`,
        excludeRoots: [artifactsBaseDir, ...candidateEvidenceExcludeRoots],
        postimagePaths,
        candidateCopyPaths: candidateInventory.copyPaths,
        preserveEvidenceBytes: input.evidenceReadOnly === true,
      });
      const deltaBase = input.deltaScopes?.[reviewer.adapter.id];
      if (deltaBase && input.evidenceReadOnly !== true) {
        throw new Error("delta-scope review is only valid against a sealed packet");
      }
      const reviewerPatch = deltaBase
        ? readSealedDeltaEvidence(reviewerWorkspace.evidenceDir)
        : input.evidenceReadOnly
          ? readExistingDiffEvidence(reviewerWorkspace.evidenceDir, input.diff)
          : writeDiffEvidence(reviewerWorkspace.evidenceDir, input.diff);
      updateReviewerMetadata(artifact, {
        candidate_evidence_dir: reviewerWorkspace.evidenceDir,
        candidate_root: reviewerWorkspace.root,
        source_candidate_evidence_dir: input.evidenceDir,
        source_candidate_root: input.cwd,
        reviewer_workspace_root: reviewerWorkspace.root,
        persistent_evidence_dir: persistentEvidenceDir,
        persistent_diff_path: persistentPatch.diffPath,
        persistent_summary_path: persistentPatch.summaryPath,
        diff_sha256: persistentPatch.diffSha256,
        candidate_inventory_mode: candidateInventory.mode,
        candidate_inventory_reason: candidateInventory.reason,
        ...frozenMetadata,
      });
      const runtimePrompt = buildReviewPrompt(
        input.candidateLabel,
        reviewerWorkspace.root,
        reviewerWorkspace.evidenceDir,
        reviewerPatch,
        {
          sealed: input.evidenceReadOnly === true,
          candidateInventoryMode: candidateInventory.mode,
          ...(deltaBase ? { deltaScopeBaseSha: deltaBase } : {}),
        },
      );
      spec = HarnessRunSpec.parse({
        session_id: newId("rev"),
        intent: "review",
        prompt: runtimePrompt,
        cwd: reviewerWorkspace.root,
        access: "readonly",
        ...(input.evidenceReadOnly && input.frozenIdentity
          ? {
              external_context_policy: "live",
              tool_permission_policy: { web: "live", allow: [], deny: [] },
            }
          : {}),
        model_hint: reviewer.requestedModel ?? null,
        effort_hint: reviewer.requestedEffort ?? null,
        auth_preference: reviewer.authPreference ?? "auto",
        env_inheritance: input.envInheritance ?? "mirror_native",
        ...(input.evidenceReadOnly && input.frozenIdentity
          ? { output_schema: SEALED_REVIEW_OUTPUT_SCHEMA }
          : {}),
        ...(input.env ? { env: input.env } : {}),
      });
      writeText(artifact.promptPath, spec.prompt);
      updateReviewerMetadata(artifact, {
        session_id: spec.session_id,
        external_context_policy: spec.external_context_policy,
        tool_web_policy: spec.tool_permission_policy.web,
        submitted_prompt_sha256: createHash("sha256").update(spec.prompt).digest("hex"),
      });
    } catch (err) {
      const failedAt = nowIso();
      const message = redactSecrets(err instanceof Error ? err.message : String(err));
      updateReviewerMetadata(artifact, {
        status: "failed",
        failure_time: failedAt,
        error: `reviewer setup failed: ${message}`,
      });
      writeParseError(artifact, { error: `reviewer setup failed: ${message}` });
      emitReviewerProgress(artifact, reviewer, input.onReviewerEvent, {
        type: "reviewer.failed",
        at: failedAt,
        duration_ms: 0,
        message: `Reviewer setup failed: ${message}`,
      });
      if (reviewerWorkspace) await cleanupReviewerWorkspace(reviewerWorkspace, artifact);
      const proof = reviewerRouteProof(reviewer, null, "unavailable", reviewerFamilies);
      routeProofs[index] = proof;
      findingsByReviewer[index]?.push(
        insufficientEvidenceFinding(
          reviewerInfo(reviewer, proof.status),
          `Reviewer setup failed: ${message}`,
        ),
      );
      return;
    }
    if (!reviewerWorkspace || !spec) return;

    let text = "";
    let streamObservedModel: string | undefined;
    let routeModel: string | undefined;
    let routeSource: RouteProof["observed"]["evidence_source"] = "unavailable";
    let reviewerError: string | null = null;
    let sealedProjectionError: string | null = null;
    try {
      const out = await collectReviewerOutput(
        reviewer,
        spec,
        reviewerTimeoutMs,
        input.evidenceReadOnly && input.frozenIdentity
          ? { maxRetries: 0, initialDelayMs: 0, maxDelayMs: 0 }
          : (input.transientRetryPolicy ?? DEFAULT_REVIEWER_TRANSIENT_RETRY_POLICY),
        artifact,
        input.onReviewerEvent,
        input.signal,
        input.evidenceReadOnly === true,
      );
      text = out.text;
      sealedProjectionError = out.sealedProjectionError ?? null;
      streamObservedModel = out.observedModel;
      routeModel = out.observedModel;
      routeSource = out.observedSource;
      reviewerSpend.record(index, out);
      if (!routeModel && reviewer.requestedModel) {
        routeModel = reviewer.requestedModel;
        routeSource = "metadata";
      }
    } catch (err) {
      reviewerError = redactSecrets(err instanceof Error ? err.message : String(err));
      const partial = err as PartialReviewerSpend & {
        partialObservedModel?: string;
        partialObservedSource?: RouteProof["observed"]["evidence_source"];
        partialSealedProjectionError?: string;
        partialText?: string;
      };
      if (typeof partial?.partialText === "string" && partial.partialText.trim() !== "") {
        text = partial.partialText;
      }
      if (typeof partial?.partialSealedProjectionError === "string") {
        sealedProjectionError = partial.partialSealedProjectionError;
      }
      reviewerSpend.recordPartial(index, partial);
      if (partial?.partialObservedModel) {
        streamObservedModel = partial.partialObservedModel;
        routeModel = partial.partialObservedModel;
        routeSource = partial.partialObservedSource ?? "stream_event";
      }
      writeParseError(artifact, { error: reviewerError });
    } finally {
      await cleanupReviewerWorkspace(reviewerWorkspace, artifact);
    }

    const proof = reviewerRouteProof(
      reviewer,
      routeModel ?? null,
      routeSource,
      reviewerFamilies.filter((_, i) => i !== index),
    );
    routeProofs[index] = proof;

    const info = reviewerInfo(reviewer, proof.status, streamObservedModel ?? null);
    const sealedParse = input.evidenceReadOnly
      ? parseSealedReviewEnvelopeDetailed(text, info)
      : null;
    const jsonBlocks = sealedParse?.blocks ?? extractJsonBlocks(text);
    writeJson(artifact.parsedPath, redactValue(jsonBlocks));
    if (sealedParse && (sealedProjectionError || sealedParse.error)) {
      const detail = sealedProjectionError ?? sealedParse.error ?? "invalid sealed review output";
      writeParseError(artifact, {
        error: "invalid_sealed_review_envelope",
        detail,
        malformed: sealedParse.malformed,
        text_sha256: sha256(text),
        ...(reviewerError ? { reviewer_error: reviewerError } : {}),
      });
      findingsByReviewer[index]?.push(...sealedParse.findings);
      findingsByReviewer[index]?.push(
        insufficientEvidenceFinding(info, `Invalid sealed review envelope: ${detail}.`),
      );
      return;
    }
    if (reviewerError && (text.trim() === "" || jsonBlocks.length === 0)) {
      findingsByReviewer[index]?.push(
        insufficientEvidenceFinding(info, `Reviewer failed: ${reviewerError}`),
      );
      return;
    }
    if (text.trim() === "" || jsonBlocks.length === 0) {
      writeParseError(artifact, { error: "no_parseable_json", text_sha256: sha256(text) });
      findingsByReviewer[index]?.push(
        insufficientEvidenceFinding(info, "Reviewer produced no parseable JSON findings."),
      );
      return;
    }
    const parsed = sealedParse ?? parseFindingsDetailed(text, info);
    const parseError: Record<string, unknown> = {};
    let parsedFindingsRecorded = false;
    const recordParsedFindings = () => {
      if (parsedFindingsRecorded) return;
      findingsByReviewer[index]?.push(...parsed.findings);
      parsedFindingsRecorded = true;
    };
    if (parsed.malformed > 0 && !sealedParse?.error) {
      Object.assign(parseError, {
        error: "malformed_findings",
        malformed: parsed.malformed,
        text_sha256: sha256(text),
      });
      recordParsedFindings();
      findingsByReviewer[index]?.push(
        insufficientEvidenceFinding(
          info,
          `Reviewer produced ${parsed.malformed} malformed finding item(s).`,
        ),
      );
    }
    if (reviewerError) {
      Object.assign(parseError, {
        error: reviewerError,
        recovered_json_blocks: jsonBlocks.length,
        text_sha256: sha256(text),
      });
      recordParsedFindings();
      findingsByReviewer[index]?.push(
        insufficientEvidenceFinding(
          info,
          parsed.findings.length === 0
            ? `Reviewer failed after parseable JSON with no findings: ${reviewerError}`
            : `Reviewer failed after parseable JSON output: ${reviewerError}`,
        ),
      );
    }
    if (Object.keys(parseError).length > 0) {
      writeParseError(artifact, parseError);
      return;
    }
    healthyReviewerIndexes.add(index);
    findingsByReviewer[index]?.push(...parsed.findings);
  };

  try {
    const reviewerRuns = await Promise.allSettled(
      input.reviewers.map((reviewer, index) => runReviewer(reviewer, index)),
    );
    const failedRun = reviewerRuns.find(
      (run): run is PromiseRejectedResult => run.status === "rejected",
    );
    if (failedRun) throw failedRun.reason;
    const classifiedProofs = classifyDiversity(routeProofs);
    for (const [index, proof] of classifiedProofs.entries()) {
      const artifact = artifacts[index];
      if (artifact) {
        updateReviewerMetadata(artifact, {
          route_proof_status: proof.status,
          route_proof: proof,
        });
      }
    }
    const findings = findingsByReviewer.flatMap((items, index) => {
      const status = classifiedProofs[index]?.status;
      return items.map((f) => {
        if (!status || f.reviewer.route_proof_status === status) return f;
        return ReviewFindingSchema.parse({
          ...f,
          reviewer: { ...f.reviewer, route_proof_status: status },
        });
      });
    });
    const healthyProviders = [
      ...new Set(
        input.reviewers
          .filter((_, index) => healthyReviewerIndexes.has(index))
          .map((reviewer) => reviewer.providerFamily)
          .filter((family) => family !== "unknown"),
      ),
    ];
    const observedFamilies = [
      ...new Set(
        classifiedProofs
          .filter((p, index) => p.status === "verified" && healthyReviewerIndexes.has(index))
          .map((p) => p.requested.provider_family)
          .filter((f) => f !== "unknown"),
      ),
    ];
    return {
      findings: dedupeFindings(findings),
      routeProofs: classifiedProofs,
      reviewerRequests,
      crossFamilyHealthy: healthyProviders.length >= 2,
      healthyProviders,
      crossFamilyVerified: observedFamilies.length >= 2,
      distinctProviders: observedFamilies,
      ...reviewerSpend.summary(),
    };
  } finally {
    await cleanupTemporaryReviewerWorkspaceBaseDir(reviewerWorkspaceBaseDir, artifactsBaseDir);
  }
}

async function collectReviewerOutput(
  reviewer: ReviewerSpec,
  spec: ReturnType<typeof HarnessRunSpec.parse>,
  timeoutMs: number,
  transientRetryPolicy: TransientRetryPolicy,
  artifact: ReviewerArtifactContext,
  onReviewerEvent: ReviewCandidateInput["onReviewerEvent"],
  signal?: AbortSignal,
  sealed = false,
): Promise<ReviewerOutput> {
  const controller = new AbortController();
  spec.extra["abortSignal"] = controller.signal;
  const startMs = Date.now();
  const startTime = nowIso();
  updateReviewerMetadata(artifact, {
    status: "started",
    start_time: startTime,
    requested_model: reviewer.requestedModel ?? null,
    requested_effort: reviewer.requestedEffort ?? null,
    provider_family: reviewer.providerFamily,
    harness_id: reviewer.adapter.id,
    prompt_path: artifact.promptPath,
  });
  emitReviewerProgress(artifact, reviewer, onReviewerEvent, {
    type: "reviewer.started",
    at: startTime,
  });
  let runSpec = spec;
  let currentIter: AsyncIterable<HarnessEvent> | null = null;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let settled = false;
  let timedOut = false;
  let cancelledBySignal = false;
  let firstEventTime: string | null = null;
  let observedModel: string | undefined;
  let observedSource: RouteProof["observed"]["evidence_source"] = "unavailable";
  let observedAuthMode: "local_session" | "api_key" | null = null;
  let currentAuthMode: "local_session" | "api_key" | null = null;
  const observedAuthModes = new Set<"local_session" | "api_key">();
  const ignoredSettings = new Set<string>();
  let costUsd = 0;
  let costEstimated = false;
  let cashUsd = 0;
  let valuationUsd = 0;
  let unknownUsd = 0;
  const costKnowledge = new ReviewerCostKnowledge();
  let partialText = "";
  const isCancelled = () =>
    cancelledBySignal || signal?.aborted === true || controller.signal.aborted;

  const consumeOnce = async (nativeTry: number): Promise<ReviewerOutput> => {
    currentAuthMode = null;
    costKnowledge.startAttempt();
    const iter = (reviewer.adapter.review ?? reviewer.adapter.run).call(reviewer.adapter, runSpec);
    currentIter = iter;
    let text = "";
    let sawTransient = false;
    let sawError = false;
    let lastError: string | null = null;
    let attemptObservedModel: string | undefined;
    let attemptObservedSource: RouteProof["observed"]["evidence_source"] = "unavailable";
    const sealedMessageEvents: unknown[] = [];
    for await (const ev of iter) {
      const eventTime = nowIso();
      const persistedEvent = redactValue(ev);
      appendLine(artifact.eventsPath, JSON.stringify(persistedEvent));
      const ignored = ev.payload?.["ignored_settings"];
      if (Array.isArray(ignored)) {
        for (const item of ignored) if (typeof item === "string") ignoredSettings.add(item);
        if (ignoredSettings.size > 0) {
          updateReviewerMetadata(artifact, { ignored_settings: [...ignoredSettings] });
        }
      }
      if (ev.transient) sawTransient = true;
      if (ev.type === "error") {
        sawError = true;
        lastError = redactSecrets(ev.error ?? ev.text ?? "reviewer emitted an error event");
      }
      if (ev.type === "message" && ev.payload?.["auth_switched"] === true) {
        const authSwitch = reviewerAuthSwitchFromEvent(ev);
        if (authSwitch.to_auth_mode === "subscription") currentAuthMode = "local_session";
        if (authSwitch.to_auth_mode === "api_key") currentAuthMode = "api_key";
        updateReviewerMetadata(artifact, { auth_switch: authSwitch });
        emitReviewerProgress(artifact, reviewer, onReviewerEvent, {
          type: "reviewer.auth_switched",
          at: eventTime,
          ...authSwitch,
        });
      }
      const disclosedAuthMode = reviewerAuthMode(ev.credential_route);
      if (disclosedAuthMode) {
        currentAuthMode = disclosedAuthMode;
        observedAuthModes.add(disclosedAuthMode);
        updateReviewerMetadata(artifact, { auth_modes: [...observedAuthModes] });
      }
      costKnowledge.observeEvent(currentAuthMode);
      if (!observedAuthMode) {
        observedAuthMode = disclosedAuthMode;
        if (observedAuthMode) updateReviewerMetadata(artifact, { auth_mode: observedAuthMode });
      }
      if (!firstEventTime) {
        firstEventTime = eventTime;
        updateReviewerMetadata(artifact, { first_event_time: firstEventTime });
        emitReviewerProgress(artifact, reviewer, onReviewerEvent, {
          type: "reviewer.first_event",
          at: firstEventTime,
        });
      }
      if (
        ev.type === "usage" &&
        typeof ev.usage?.cost_usd === "number" &&
        Number.isFinite(ev.usage.cost_usd) &&
        ev.usage.cost_usd >= 0
      ) {
        costUsd += ev.usage.cost_usd;
        if (ev.usage.estimated) costEstimated = true;
        costKnowledge.observeUsage(currentAuthMode, ev.usage.estimated === true);
        if (currentAuthMode === "local_session") {
          valuationUsd += ev.usage.cost_usd;
        } else if (currentAuthMode === "api_key") {
          cashUsd += ev.usage.cost_usd;
        } else {
          unknownUsd += ev.usage.cost_usd;
        }
        updateReviewerMetadata(artifact, {
          cost_usd: costUsd,
          cost_estimated: costEstimated,
          cash_usd: cashUsd,
          valuation_usd: valuationUsd,
          unknown_usd: unknownUsd,
        });
      }
      if (sealed && ev.type === "message" && ev.final === true) {
        sealedMessageEvents.push(persistedEvent);
      }
      if (ev.type === "message" && ev.text && ev.payload?.["auth_switched"] !== true) {
        const safeText = sealedReviewTranscriptChunk(persistedEvent);
        if (safeText !== null) {
          if (sealed) {
            // Keep the long-running transcript visibly active for monitors. A
            // clean completion replaces these progress bytes with the exact
            // typed-final projection used by the sealed parser and sealer.
            appendLine(artifact.transcriptPath, safeText);
          } else {
            text += safeText;
            partialText += safeText;
            appendLine(artifact.transcriptPath, safeText);
          }
        }
      }
      if (ev.observed_model) {
        observedModel = ev.observed_model;
        const source = ev.payload?.["observed_model_source"];
        observedSource =
          source === "metadata" || source === "model_catalog" || source === "transcript"
            ? source
            : "stream_event";
        attemptObservedModel = observedModel;
        attemptObservedSource = observedSource;
        updateReviewerMetadata(artifact, {
          observed_model: observedModel,
          observed_source: observedSource,
        });
      }
    }
    if (isCancelled()) {
      throw new Error("Reviewer cancelled");
    }
    let sealedProjectionError: string | undefined;
    if (sealed) {
      try {
        text = sealedReviewTranscriptFromEvents(sealedMessageEvents);
        partialText = text;
        writeText(artifact.transcriptPath, text);
      } catch (error) {
        sealedProjectionError = error instanceof Error ? error.message : String(error);
      }
    }
    if (
      sawTransient &&
      text.trim() === "" &&
      nativeTry < transientRetryPolicy.maxRetries &&
      !timedOut &&
      !isCancelled()
    ) {
      const retryAt = nowIso();
      const delayMs = transientRetryDelayMs(transientRetryPolicy, nativeTry);
      updateReviewerMetadata(artifact, { transient_retry: nativeTry + 1 });
      emitReviewerProgress(artifact, reviewer, onReviewerEvent, {
        type: "reviewer.failed",
        at: retryAt,
        duration_ms: Date.now() - startMs,
        observed_model: attemptObservedModel ?? null,
        observed_source: attemptObservedSource,
        message: `Reviewer transient failure produced no output; retrying (${nativeTry + 1}/${transientRetryPolicy.maxRetries})`,
      });
      const remaining = Math.max(1, timeoutMs - (Date.now() - startMs));
      await sleep(Math.min(delayMs, remaining));
      if (timedOut) {
        throw new Error(`Reviewer timed out after ${timeoutMs}ms`);
      }
      if (isCancelled()) {
        throw new Error("Reviewer cancelled");
      }
      runSpec = HarnessRunSpec.parse({
        ...runSpec,
        session_id: newId("ses"),
        extra: { ...runSpec.extra, abortSignal: controller.signal },
      });
      costKnowledge.finishAttempt();
      return consumeOnce(nativeTry + 1);
    }
    if (sawError && !timedOut) {
      throw Object.assign(
        new Error(`Reviewer emitted error event: ${lastError ?? "unknown error"}`),
        {
          ...(sealedProjectionError ? { partialSealedProjectionError: sealedProjectionError } : {}),
        },
      );
    }
    if (!timedOut && !isCancelled()) {
      const completedTime = nowIso();
      const durationMs = Date.now() - startMs;
      updateReviewerMetadata(artifact, {
        status: "completed",
        completion_time: completedTime,
        duration_ms: durationMs,
        observed_model: attemptObservedModel ?? null,
        observed_source: attemptObservedSource,
        raw_normalized_stream_path: artifact.eventsPath,
        transcript_path: artifact.transcriptPath,
      });
      emitReviewerProgress(artifact, reviewer, onReviewerEvent, {
        type: "reviewer.completed",
        at: completedTime,
        duration_ms: durationMs,
        observed_model: attemptObservedModel ?? null,
        observed_source: attemptObservedSource,
      });
    }
    const knowledge = costKnowledge.snapshot();
    costKnowledge.finishAttempt();
    return {
      text,
      ...(sealedProjectionError ? { sealedProjectionError } : {}),
      observedModel: attemptObservedModel,
      observedSource: attemptObservedSource,
      costUsd,
      costEstimated,
      cashUsd,
      valuationUsd,
      unknownUsd,
      ...knowledge,
    };
  };
  const consume = consumeOnce(0);

  let removeExternalAbortListener = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    if (!signal) return;
    const onAbort = () => {
      if (settled) return;
      cancelledBySignal = true;
      controller.abort();
      void (currentIter as unknown as AsyncIterator<unknown> | null)?.return?.();
      const knowledge = costKnowledge.snapshot();
      reject(
        Object.assign(new Error("Reviewer cancelled"), {
          partialCostUsd: costUsd,
          partialCostEstimated: costEstimated,
          partialCashUsd: cashUsd,
          partialValuationUsd: valuationUsd,
          partialUnknownUsd: unknownUsd,
          partialCashKnowledge: knowledge.cashKnowledge,
          partialValuationKnowledge: knowledge.valuationKnowledge,
          partialObservedModel: observedModel,
          partialObservedSource: observedSource,
          partialText,
        }),
      );
    };
    if (signal.aborted) queueMicrotask(onAbort);
    else signal.addEventListener("abort", onAbort, { once: true });
    removeExternalAbortListener = () => signal.removeEventListener("abort", onAbort);
  });

  const timed = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => {
        if (settled) return;
        timedOut = true;
        const timedOutAt = nowIso();
        const durationMs = Date.now() - startMs;
        controller.abort();
        void (currentIter as unknown as AsyncIterator<unknown> | null)?.return?.();
        updateReviewerMetadata(artifact, {
          status: "timed_out",
          timeout_time: timedOutAt,
          duration_ms: durationMs,
          observed_model: observedModel ?? null,
          observed_source: observedSource,
          raw_normalized_stream_path: artifact.eventsPath,
          transcript_path: artifact.transcriptPath,
        });
        emitReviewerProgress(artifact, reviewer, onReviewerEvent, {
          type: "reviewer.timed_out",
          at: timedOutAt,
          duration_ms: durationMs,
          observed_model: observedModel ?? null,
          observed_source: observedSource,
          message: `Reviewer timed out after ${timeoutMs}ms`,
        });
        const knowledge = costKnowledge.snapshot();
        reject(
          Object.assign(new Error(`Reviewer timed out after ${timeoutMs}ms`), {
            partialCostUsd: costUsd,
            partialCostEstimated: costEstimated,
            partialCashUsd: cashUsd,
            partialValuationUsd: valuationUsd,
            partialUnknownUsd: unknownUsd,
            partialCashKnowledge: knowledge.cashKnowledge,
            partialValuationKnowledge: knowledge.valuationKnowledge,
            partialObservedModel: observedModel,
            partialObservedSource: observedSource,
            partialText,
          }),
        );
      },
      Math.max(1, timeoutMs),
    );
  });

  try {
    return await Promise.race([consume, timed, cancelled]);
  } catch (err) {
    if (!timedOut) {
      const failedAt = nowIso();
      const durationMs = Date.now() - startMs;
      const rawMessage = err instanceof Error ? err.message : String(err);
      const message = cancelledBySignal ? "Reviewer cancelled" : rawMessage;
      updateReviewerMetadata(artifact, {
        status: "failed",
        failure_time: failedAt,
        duration_ms: durationMs,
        error: redactSecrets(message),
        raw_normalized_stream_path: artifact.eventsPath,
        transcript_path: artifact.transcriptPath,
      });
      emitReviewerProgress(artifact, reviewer, onReviewerEvent, {
        type: "reviewer.failed",
        at: failedAt,
        duration_ms: durationMs,
        message,
      });
    }
    if (err && typeof err === "object") {
      const knowledge = costKnowledge.snapshot();
      Object.assign(err as Record<string, unknown>, {
        partialCostUsd: costUsd,
        partialCostEstimated: costEstimated,
        partialCashUsd: cashUsd,
        partialValuationUsd: valuationUsd,
        partialUnknownUsd: unknownUsd,
        partialCashKnowledge: knowledge.cashKnowledge,
        partialValuationKnowledge: knowledge.valuationKnowledge,
        partialObservedModel: observedModel,
        partialObservedSource: observedSource,
        partialText,
      });
    }
    throw err;
  } finally {
    settled = true;
    if (timeout) clearTimeout(timeout);
    removeExternalAbortListener();
    consume.catch(() => {
      /* timeout path: consume may reject after the race already returned */
    });
  }
}

async function cleanupReviewerWorkspace(
  workspace: ReviewerWorkspace,
  artifact: ReviewerArtifactContext,
): Promise<void> {
  try {
    await rm(workspace.root, { recursive: true, force: true });
    tryUpdateReviewerMetadata(artifact, { reviewer_workspace_cleanup: "removed" });
  } catch (err) {
    tryUpdateReviewerMetadata(artifact, {
      reviewer_workspace_cleanup: "failed",
      reviewer_workspace_cleanup_error: redactSecrets(
        err instanceof Error ? err.message : String(err),
      ),
    });
  }
}

function createReviewerArtifactContext(
  baseDir: string,
  index: number,
  reviewer: ReviewerSpec,
): ReviewerArtifactContext {
  const dir = join(
    baseDir,
    `${String(index + 1).padStart(2, "0")}-${safeFilePart(reviewer.adapter.id)}`,
  );
  ensureDir(dir);
  const progressPath = join(baseDir, "reviewer-progress.jsonl");
  const metadata = {
    harness_id: reviewer.adapter.id,
    provider_family: reviewer.providerFamily,
    requested_model: reviewer.requestedModel ?? null,
    requested_effort: reviewer.requestedEffort ?? null,
    artifact_dir: dir,
  };
  const ctx: ReviewerArtifactContext = {
    dir,
    progressPath,
    metadataPath: join(dir, "metadata.json"),
    eventsPath: join(dir, "raw-normalized-stream.jsonl"),
    transcriptPath: join(dir, "transcript.md"),
    promptPath: join(dir, "prompt.md"),
    parsedPath: join(dir, "parsed-json-blocks.json"),
    parseErrorPath: join(dir, "parse-error.json"),
    metadata,
  };
  writeJson(ctx.metadataPath, metadata);
  writeText(ctx.eventsPath, "");
  writeText(ctx.transcriptPath, "");
  return ctx;
}

function safeFilePart(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+/, "");
  let end = safe.length;
  while (end > 0 && safe[end - 1] === "-") end -= 1;
  return safe.slice(0, end) || "reviewer";
}

function emitReviewerProgress(
  artifact: ReviewerArtifactContext,
  reviewer: ReviewerSpec,
  onReviewerEvent: ReviewCandidateInput["onReviewerEvent"],
  patch: Omit<
    ReviewerProgressEvent,
    "harness_id" | "provider_family" | "requested_model" | "requested_effort" | "artifact_dir"
  >,
): void {
  const event: ReviewerProgressEvent = {
    harness_id: reviewer.adapter.id,
    provider_family: reviewer.providerFamily,
    requested_model: reviewer.requestedModel ?? null,
    requested_effort: reviewer.requestedEffort ?? null,
    artifact_dir: artifact.dir,
    ...(typeof artifact.metadata["review_wave_id"] === "string"
      ? { review_wave_id: artifact.metadata["review_wave_id"] }
      : {}),
    ...patch,
  };
  const redacted = redactValue(event);
  appendLine(artifact.progressPath, JSON.stringify(redacted));
  try {
    onReviewerEvent?.(redacted);
  } catch {
    /* progress observers must never affect review state */
  }
}

function transientRetryDelayMs(policy: TransientRetryPolicy, retryIndex: number): number {
  return Math.min(policy.initialDelayMs * 2 ** retryIndex, policy.maxDelayMs);
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function updateReviewerMetadata(
  artifact: ReviewerArtifactContext,
  patch: Record<string, unknown>,
): void {
  artifact.metadata = { ...artifact.metadata, ...redactValue(patch) };
  writeJson(artifact.metadataPath, artifact.metadata);
}

function tryUpdateReviewerMetadata(
  artifact: ReviewerArtifactContext,
  patch: Record<string, unknown>,
): void {
  try {
    updateReviewerMetadata(artifact, patch);
  } catch {
    // Cleanup telemetry must never hide the review result or original error.
  }
}

function writeParseError(artifact: ReviewerArtifactContext, value: Record<string, unknown>): void {
  writeJson(artifact.parseErrorPath, redactValue(value));
}

function redactValue<T>(value: T): T {
  try {
    return JSON.parse(redactSecrets(JSON.stringify(value))) as T;
  } catch {
    return value;
  }
}

function insufficientEvidenceFinding(reviewer: ReviewerInfo, claim: string): ReviewFinding {
  return ReviewFindingSchema.parse({
    id: newId("f"),
    severity: "INSUFFICIENT_EVIDENCE",
    category: "test_gap",
    claim,
    evidence: {},
    proposed_fix: "Treat this review as inconclusive and rerun with a healthy reviewer.",
    reviewer: {
      harness_id: reviewer.harness_id,
      requested_model: reviewer.requested_model ?? null,
      requested_effort: reviewer.requested_effort ?? null,
      observed_model: reviewer.observed_model ?? null,
      route_proof_status: reviewer.route_proof_status ?? "unverified",
    },
    status: "insufficient_evidence",
  });
}

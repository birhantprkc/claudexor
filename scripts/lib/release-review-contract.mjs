/**
 * Fail-closed publishing contract for the two full-context owner reviews,
 * executed as Cursor operator subagents (owner decision 2026-08-06).
 * Historical schemas remain verifiable as signed archive bytes, but only
 * schema v6 can authorize publication.
 */
import { createPublicKey, verify } from "node:crypto";
import { relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";

const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const SEMVER_TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const REVIEW_WAVE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

export const RELEASE_REVIEW_ATTESTATION_ALGORITHM = "Ed25519";
export const OWNER_REVIEW_ATTESTATION_SCHEMA_VERSION = 6;
// v6 transport (owner decision 2026-08-06, program
// claudexor-runtime-delivery-337, verbatim: «не надо вообще codex
// использовать… Используй своих субагентов, ты же можешь у себя разные модели
// вызывать так как ты cursor»): the formal release review pair executes as
// Cursor OPERATOR SUBAGENTS, not as native Claude Code/Cursor CLI runs
// through Claudexor. Each slot produces a markdown report plus metadata
// (model slug, exact ISO-8601 start/finish, pass|warn verdict, review scope,
// report digest); the two executions must genuinely overlap in wall time. The
// native-harness protocol `native-fable-full-sol-delta-v2` (schema v5) is
// retired to the archive list below alongside v2-v4.
export const OWNER_REVIEW_PROTOCOL = "cursor-operator-fable-sol-v1";
export const OWNER_REVIEW_VERDICTS = Object.freeze(["pass", "warn"]);
// Owner-locked: BOTH slots review the full context under this protocol. A
// delta, packet-split, or any other partial scope can never satisfy either
// slot, so "full" is the only value a review entry may carry.
export const OWNER_REVIEW_SCOPES = Object.freeze(["full"]);
export const ARCHIVED_OWNER_REVIEW_SCHEMA_VERSIONS = Object.freeze([2, 3, 4, 5]);
export const RELEASE_REVIEW_VERIFIER_ARTIFACT_PATH = "release-review-verifier.mjs";
export const RELEASE_REVIEW_CLI_ARTIFACT_PATH = "claudexor.bundle.cjs";
export const RELEASE_REVIEW_RUNTIME_ARTIFACT_PATHS = Object.freeze([
  RELEASE_REVIEW_VERIFIER_ARTIFACT_PATH,
  RELEASE_REVIEW_CLI_ARTIFACT_PATH,
]);
export const RELEASE_REVIEW_MIN_PLAUSIBLE_MS = 1_000;
// Exactly two slots; both receive the full context. No substitute model,
// packet split, or extra critic can satisfy either slot. Each slot accepts
// exactly one slug from its owner-approved tier set (operator decision
// 2026-08-06 ~08:29 MSK under the owner authorization of 08:04 MSK «меня
// удовлетворяют модели fable-5 и gpt-5.6-sol»: two subagent-model catalog
// flaps within one hour; a hard single-tier pin would have blocked the
// formal pair on the frozen SHA; the same-family `high` Sol tier joined on
// 2026-08-16, owner-ratified the same day, after the live catalog exposed
// only that Sol tier — it sits above the already-approved `medium`, so the
// assurance floor does not drop). The actually used slug is recorded in the
// reviewer metadata and the signed review entry; a slug outside the set
// refuses fail-closed. This constant is the single source for BOTH
// comparison points: the semantic validator below and the sealer.
export const OWNER_REVIEW_PANEL = Object.freeze([
  Object.freeze({
    slot: "fable",
    allowedModels: Object.freeze([
      "claude-fable-5-thinking-max",
      "claude-fable-5-thinking-medium",
      "claude-fable-5-thinking-high",
    ]),
  }),
  Object.freeze({
    slot: "sol",
    allowedModels: Object.freeze([
      "gpt-5.6-sol-xhigh",
      "gpt-5.6-sol-max",
      "gpt-5.6-sol-high",
      "gpt-5.6-sol-medium",
    ]),
  }),
]);

export function decodeReviewUtf8(value, label = "review evidence") {
  if (typeof value === "string") return value;
  try {
    return UTF8.decode(value);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}

/** Validate the only two release workflow entry modes before fetching refs. */
export function validateReleaseInput(mode, ref) {
  const reasons = [];
  if (mode !== "candidate" && mode !== "publish") reasons.push("mode must be candidate or publish");
  if (mode === "candidate" && !SHA1.test(ref)) {
    reasons.push("candidate ref must be a full lowercase 40-character commit SHA");
  }
  if (mode === "publish" && !SEMVER_TAG.test(ref)) {
    reasons.push("publish ref must be an exact stable vMAJOR.MINOR.PATCH tag");
  }
  return { ok: reasons.length === 0, reasons };
}

/** Stable JSON is the byte contract signed by the offline review authority. */
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

export function releaseAttestationSigningBytes(attestation) {
  return Buffer.from(
    canonicalJson({
      schemaVersion: attestation.schemaVersion,
      keyId: attestation.keyId,
      algorithm: attestation.algorithm,
      payload: attestation.payload,
    }),
    "utf8",
  );
}

/** Verify authority and signed bytes without assigning current publish meaning. */
export function verifyReleaseAttestationSignature(
  attestation,
  authority,
  expectedSchemaVersion = OWNER_REVIEW_ATTESTATION_SCHEMA_VERSION,
) {
  const reasons = [];
  if (!isRecord(attestation))
    return { ok: false, reasons: ["review attestation is not an object"] };
  if (attestation.schemaVersion !== expectedSchemaVersion) {
    reasons.push(`review attestation schemaVersion must be ${expectedSchemaVersion}`);
  }
  if (!isRecord(authority) || attestation.keyId !== authority.keyId) {
    reasons.push("review attestation keyId is unknown");
  }
  if (attestation.algorithm !== RELEASE_REVIEW_ATTESTATION_ALGORITHM) {
    reasons.push(`review attestation algorithm must be ${RELEASE_REVIEW_ATTESTATION_ALGORITHM}`);
  }
  if (!isRecord(attestation.payload)) reasons.push("review attestation payload is missing");
  if (typeof attestation.signature !== "string" || !BASE64.test(attestation.signature)) {
    reasons.push("review attestation signature is missing or malformed");
  }
  if (reasons.length > 0) return { ok: false, reasons };
  try {
    const key = createPublicKey(authority.publicKeyPem);
    const signature = Buffer.from(attestation.signature, "base64");
    if (
      key.asymmetricKeyType !== "ed25519" ||
      signature.length !== 64 ||
      !verify(null, releaseAttestationSigningBytes(attestation), key, signature)
    ) {
      throw new Error("invalid signature");
    }
  } catch {
    return { ok: false, reasons: ["review attestation signature is invalid"] };
  }
  return { ok: true, reasons: [] };
}

/** Schemas 2-5 are historical signed records, never publishing authority. */
export function verifyArchivedReleaseAttestationSignature(attestation, authority) {
  if (!ARCHIVED_OWNER_REVIEW_SCHEMA_VERSIONS.includes(attestation?.schemaVersion)) {
    return {
      ok: false,
      reasons: [
        `archived review attestation schemaVersion must be one of: ${ARCHIVED_OWNER_REVIEW_SCHEMA_VERSIONS.join(", ")}`,
      ],
    };
  }
  return verifyReleaseAttestationSignature(attestation, authority, attestation.schemaVersion);
}

export function validateFullGateEvidence(gate, expected) {
  if (
    !isRecord(gate) ||
    !hasExactKeys(gate, [
      "receiptSha256",
      "program",
      "argv",
      "exitCode",
      "candidateUnchanged",
      "beforeSha",
      "beforeTree",
      "afterSha",
      "afterTree",
      "stdoutSha256",
      "stderrSha256",
    ]) ||
    !SHA256.test(gate.receiptSha256 ?? "") ||
    gate.program !== "pnpm" ||
    canonicalJson(gate.argv) !== canonicalJson(["pnpm", "release:verify"]) ||
    gate.exitCode !== 0 ||
    gate.candidateUnchanged !== true ||
    gate.beforeSha !== expected.candidateSha ||
    gate.afterSha !== expected.candidateSha ||
    gate.beforeTree !== expected.candidateTree ||
    gate.afterTree !== expected.candidateTree ||
    !SHA256.test(gate.stdoutSha256 ?? "") ||
    !SHA256.test(gate.stderrSha256 ?? "")
  ) {
    return ["review attestation full deterministic gate is invalid"];
  }
  return [];
}

/** Validate the exact receipt emitted by run-full-gate-receipt.mjs.
 *
 * This is intentionally stricter than validateFullGateEvidence: the latter
 * validates the compact gate facts carried by the signed attestation, while
 * this function validates the complete pre-signing receipt. Callers still own
 * resolving the two log paths beneath the receipt directory and comparing the
 * recorded digests with their actual bytes.
 */
export function validateFullGateReceipt(receipt, expected) {
  const reasons = [];
  if (
    !isRecord(receipt) ||
    !hasExactKeys(receipt, [
      "program",
      "argv",
      "exitCode",
      "gateExitCode",
      "candidateUnchanged",
      "before",
      "after",
      "stdout",
      "stderr",
      "reviewRuntimeArtifacts",
      "reviewRuntimeArtifactError",
      "finishedAt",
    ])
  ) {
    return ["full-gate receipt shape is invalid"];
  }
  if (
    receipt.program !== "pnpm" ||
    canonicalJson(receipt.argv) !== canonicalJson(["pnpm", "release:verify"]) ||
    receipt.exitCode !== 0 ||
    receipt.gateExitCode !== 0 ||
    receipt.candidateUnchanged !== true
  ) {
    reasons.push("full-gate receipt did not complete pnpm release:verify successfully");
  }
  for (const phase of ["before", "after"]) {
    const identity = receipt[phase];
    if (
      !isRecord(identity) ||
      !hasExactKeys(identity, ["head", "tree", "status"]) ||
      identity.head !== expected.candidateSha ||
      identity.tree !== expected.candidateTree ||
      identity.status !== ""
    ) {
      reasons.push(`full-gate receipt ${phase} identity is invalid`);
    }
  }
  for (const stream of ["stdout", "stderr"]) {
    const metadata = receipt[stream];
    if (
      !isRecord(metadata) ||
      !hasExactKeys(metadata, ["path", "sha256"]) ||
      typeof metadata.path !== "string" ||
      metadata.path.trim() === "" ||
      !SHA256.test(metadata.sha256 ?? "")
    ) {
      reasons.push(`full-gate receipt ${stream} metadata is invalid`);
    }
  }
  reasons.push(...validateReleaseReviewRuntimeArtifacts(receipt.reviewRuntimeArtifacts));
  if (receipt.reviewRuntimeArtifactError !== null) {
    reasons.push("full-gate receipt reports a release review runtime artifact error");
  }
  if (parseExactIso(receipt.finishedAt) === null) {
    reasons.push("full-gate receipt finishedAt is invalid");
  }
  return reasons;
}

export function validateReleaseReviewRuntimeArtifacts(value) {
  if (!Array.isArray(value) || value.length !== RELEASE_REVIEW_RUNTIME_ARTIFACT_PATHS.length) {
    return ["full-gate receipt must bind the verifier and packaged review CLI"];
  }
  const reasons = [];
  for (const [index, path] of RELEASE_REVIEW_RUNTIME_ARTIFACT_PATHS.entries()) {
    const artifact = value[index];
    if (
      !isRecord(artifact) ||
      !hasExactKeys(artifact, ["path", "bytes", "sha256"]) ||
      artifact.path !== path ||
      !Number.isSafeInteger(artifact.bytes) ||
      artifact.bytes <= 0 ||
      !SHA256.test(artifact.sha256 ?? "")
    ) {
      reasons.push(`release review runtime artifact ${path} is invalid`);
    }
  }
  return reasons;
}

export function validateOwnerReviewAttestationPayload(payload, expected) {
  const reasons = [];
  if (!isRecord(payload)) {
    return { ok: false, reasons: ["review attestation payload is not an object"] };
  }
  if (
    !hasExactKeys(payload, [
      "contract",
      "reviewProtocol",
      "candidateSha",
      "candidateTree",
      "candidateVersion",
      "evidence",
      "fullGate",
      "reviews",
      "sealedAt",
    ])
  ) {
    reasons.push("review attestation payload shape is invalid");
  }
  if (payload.contract !== "owner-review-v6") reasons.push("owner review contract must be v6");
  if (payload.reviewProtocol !== OWNER_REVIEW_PROTOCOL) {
    reasons.push(`owner review protocol must be ${OWNER_REVIEW_PROTOCOL}`);
  }
  if (payload.candidateSha !== expected.candidateSha || !SHA1.test(payload.candidateSha ?? "")) {
    reasons.push("review attestation candidate SHA mismatch");
  }
  if (payload.candidateTree !== expected.candidateTree || !SHA1.test(payload.candidateTree ?? "")) {
    reasons.push("review attestation candidate tree mismatch");
  }
  if (
    typeof payload.candidateVersion !== "string" ||
    payload.candidateVersion.length === 0 ||
    payload.candidateVersion !== expected.candidateVersion
  ) {
    reasons.push("review attestation candidate version mismatch");
  }
  if (
    !isRecord(payload.evidence) ||
    !hasExactKeys(payload.evidence, ["manifestSha256", "diffSha256", "reviewWaveId"]) ||
    !SHA256.test(payload.evidence.manifestSha256 ?? "") ||
    !SHA256.test(payload.evidence.diffSha256 ?? "") ||
    !REVIEW_WAVE_ID.test(payload.evidence.reviewWaveId ?? "")
  ) {
    reasons.push("review attestation evidence binding is invalid");
  }
  reasons.push(...validateFullGateEvidence(payload.fullGate, expected));

  const reviews = Array.isArray(payload.reviews) ? payload.reviews : [];
  if (reviews.length !== OWNER_REVIEW_PANEL.length) {
    reasons.push("owner review attestation requires exactly two operator reviewer reports");
  }
  for (const [index, required] of OWNER_REVIEW_PANEL.entries()) {
    const review = reviews[index];
    if (
      !isRecord(review) ||
      !hasExactKeys(review, [
        "slot",
        "model",
        "startedAt",
        "completedAt",
        "verdict",
        "reviewScope",
        "reportSha256",
        "metadataSha256",
      ])
    ) {
      reasons.push(`owner review ${required.slot} entry shape is invalid`);
      continue;
    }
    if (review.slot !== required.slot || !required.allowedModels.includes(review.model)) {
      reasons.push(
        `owner review ${required.slot} slot/model is outside the owner-approved panel (${required.slot}: ${required.allowedModels.join(" | ")})`,
      );
    }
    const startedMs = parseExactIso(review.startedAt);
    const completedMs = parseExactIso(review.completedAt);
    if (
      startedMs === null ||
      completedMs === null ||
      completedMs < startedMs ||
      completedMs - startedMs < RELEASE_REVIEW_MIN_PLAUSIBLE_MS
    ) {
      reasons.push(`owner review ${required.slot} liveness evidence is invalid`);
    }
    for (const key of ["reportSha256", "metadataSha256"]) {
      if (!SHA256.test(review[key] ?? "")) {
        reasons.push(`owner review ${required.slot} ${key} is missing or malformed`);
      }
    }
    if (!OWNER_REVIEW_VERDICTS.includes(review.verdict)) {
      reasons.push(`owner review ${required.slot} verdict must be pass or warn`);
    }
    if (!OWNER_REVIEW_SCOPES.includes(review.reviewScope)) {
      reasons.push(`owner review ${required.slot} review scope must be full`);
    }
  }
  if (reviews.length === OWNER_REVIEW_PANEL.length && reviews.every((review) => isRecord(review))) {
    const starts = reviews.map((review) => Date.parse(review.startedAt));
    const completions = reviews.map((review) => Date.parse(review.completedAt));
    if (
      starts.some((value) => !Number.isFinite(value)) ||
      completions.some((value) => !Number.isFinite(value)) ||
      Math.max(...starts) >= Math.min(...completions)
    ) {
      reasons.push("owner review operator reviewer executions did not overlap");
    }
    if (new Set(reviews.map((review) => review.reportSha256)).size !== reviews.length) {
      reasons.push("owner review operator reviewer reports must be distinct");
    }
  }
  if (
    typeof payload.sealedAt !== "string" ||
    !Number.isFinite(Date.parse(payload.sealedAt)) ||
    new Date(payload.sealedAt).toISOString() !== payload.sealedAt
  ) {
    reasons.push("review attestation sealedAt is invalid");
  }
  return { ok: reasons.length === 0, reasons };
}

export function validateReleaseAttestation(attestation, authority, expected) {
  if (attestation?.schemaVersion !== OWNER_REVIEW_ATTESTATION_SCHEMA_VERSION) {
    return {
      ok: false,
      reasons: [
        `review attestation schemaVersion ${attestation?.schemaVersion ?? "(missing)"} is not accepted for publish; schemas 2-5 are archive-signature-only`,
      ],
    };
  }
  if (!hasExactKeys(attestation, ["schemaVersion", "keyId", "algorithm", "payload", "signature"])) {
    return { ok: false, reasons: ["review attestation envelope shape is invalid"] };
  }
  const signature = verifyReleaseAttestationSignature(attestation, authority);
  if (!signature.ok) return signature;
  return validateOwnerReviewAttestationPayload(attestation.payload, expected);
}

export function pathIsWithin(root, target) {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Exact-shape check shared with the sealer's on-disk metadata validation. */
export function hasExactKeys(value, keys) {
  if (!isRecord(value) || Object.keys(value).length !== keys.length) return false;
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function parseExactIso(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  const date = new Date(value);
  return date.toISOString() === value ? date.getTime() : null;
}

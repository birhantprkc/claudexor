/**
 * Fail-closed publishing contract for the two native, full-context owner
 * reviews. Historical schemas remain verifiable as signed archive bytes, but
 * only schema v5 can authorize publication.
 */
import { createPublicKey, verify } from "node:crypto";
import { relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";

const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const SEMVER_TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const REVIEW_WAVE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OBSERVED_SOURCES = new Set(["stream_event", "transcript"]);
const UTF8 = new TextDecoder("utf-8", { fatal: true });

export const RELEASE_REVIEW_ATTESTATION_ALGORITHM = "Ed25519";
export const OWNER_REVIEW_ATTESTATION_SCHEMA_VERSION = 5;
// v2 (owner decision 2026-08-04, session transcript
// 5349be54-a1d2-46bb-a6ef-52a2e43b91ee.jsonl line 1824, verbatim: «C (моя
// текущая рекомендация): cursor-полоса ревьюит только дельту с прошлого
// прогона — три маленьких фикс-коммита; сходимость почти гарантирована за
// круг, два вердикта сохраняются. и одного агента на fable собсвенного
// прогони тоже»): after a completed full-context sol review of the candidate
// line, subsequent sol executions may take the delta since that review as
// their subject (sealed DELTA.patch, full packet as context); the fable slot
// always reviews the full context.
export const OWNER_REVIEW_PROTOCOL = "native-fable-full-sol-delta-v2";
export const OWNER_REVIEW_VERDICTS = Object.freeze(["pass", "warn"]);
export const ARCHIVED_OWNER_REVIEW_SCHEMA_VERSIONS = Object.freeze([2, 3, 4]);
export const RELEASE_REVIEW_VERIFIER_ARTIFACT_PATH = "release-review-verifier.mjs";
export const RELEASE_REVIEW_CLI_ARTIFACT_PATH = "claudexor.bundle.cjs";
export const RELEASE_REVIEW_RUNTIME_ARTIFACT_PATHS = Object.freeze([
  RELEASE_REVIEW_VERIFIER_ARTIFACT_PATH,
  RELEASE_REVIEW_CLI_ARTIFACT_PATH,
]);
export const RELEASE_REVIEW_MIN_PLAUSIBLE_MS = 1_000;
export const REQUIRED_NATIVE_REVIEWERS = Object.freeze([
  Object.freeze({
    slot: "fable",
    harnessId: "claude",
    providerFamily: "anthropic",
    requestedModel: "claude-fable-5",
    requestedEffort: "max",
    // INV-125 second amendment integrity pin: the fable lane ALWAYS reviews
    // the full context — a delta-scoped fable artifact cannot seal.
    allowedScopes: Object.freeze(["full"]),
  }),
  // Owner decision 2026-08-04 («зачем тебе кодекс? Ревьюй курсором и клод
  // кодом» — the owner's typed reply, answering the explanation that this
  // slot required a codex-native session; full provenance is recorded in the
  // release evidence packet): the sol slot
  // rides the cursor harness. The MODEL is unchanged — cursor has no effort
  // flag, so `xhigh` is carried inside cursor's native model id and
  // requestedEffort is honestly null. providerFamily is cursor's manifest
  // family; the two slots remain distinct families and must still overlap.
  Object.freeze({
    slot: "sol",
    harnessId: "cursor",
    providerFamily: "cursor",
    requestedModel: "gpt-5.6-sol-xhigh",
    requestedEffort: null,
    // INV-125 second amendment: the sol lane may review either the full
    // context or the sealed exact delta — nothing else.
    allowedScopes: Object.freeze(["full", "delta"]),
  }),
]);

/**
 * Slot-expected STREAM-OBSERVED model string. Cursor reports a display name,
 * never the requested id (re-measured 2026-08-06 from the live native catalog:
 * `gpt-5.6-sol-xhigh - GPT-5.6 Sol 1M Extra High`), so the observed-model checks
 * pin the exact measured string for that slot instead of the id — equality
 * stays as strong as before, against the form the harness genuinely emits.
 */
export const EXPECTED_OBSERVED_MODELS = Object.freeze({
  fable: "claude-fable-5",
  sol: "GPT-5.6 Sol 1M Extra High",
});

export function expectedObservedModel(required) {
  return EXPECTED_OBSERVED_MODELS[required.slot] ?? required.requestedModel;
}

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

/** Schemas 2-4 are historical signed records, never publishing authority. */
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
      "evidence",
      "fullGate",
      "reviews",
      "sealedAt",
    ])
  ) {
    reasons.push("review attestation payload shape is invalid");
  }
  if (payload.contract !== "owner-review-v5") reasons.push("owner review contract must be v5");
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
    !isRecord(payload.evidence) ||
    !hasExactKeys(payload.evidence, [
      "manifestSha256",
      "diffSha256",
      "reviewWaveId",
      "metadataSha256",
    ]) ||
    !SHA256.test(payload.evidence.manifestSha256 ?? "") ||
    !SHA256.test(payload.evidence.diffSha256 ?? "") ||
    !REVIEW_WAVE_ID.test(payload.evidence.reviewWaveId ?? "") ||
    !SHA256.test(payload.evidence.metadataSha256 ?? "")
  ) {
    reasons.push("review attestation evidence binding is invalid");
  }
  reasons.push(...validateFullGateEvidence(payload.fullGate, expected));

  const reviews = Array.isArray(payload.reviews) ? payload.reviews : [];
  if (reviews.length !== REQUIRED_NATIVE_REVIEWERS.length) {
    reasons.push("owner review attestation requires exactly two native reviewer reports");
  }
  for (const [index, required] of REQUIRED_NATIVE_REVIEWERS.entries()) {
    const review = reviews[index];
    if (
      !isRecord(review) ||
      !hasExactKeys(review, [
        "slot",
        "harnessId",
        "providerFamily",
        "requestedModel",
        "requestedEffort",
        "sessionId",
        "externalContextPolicy",
        "toolWebPolicy",
        "observedModel",
        "observedSource",
        "routeProofStatus",
        "authMode",
        "authSwitched",
        "effortHonored",
        "reviewRuntimeVersion",
        "reviewRuntimeBuildSha",
        "reviewRuntimeEntrySha256",
        "startedAt",
        "completedAt",
        "durationMs",
        "promptSha256",
        "reportSha256",
        "metadataSha256",
        "eventsSha256",
        "parsedSha256",
        "verdict",
        "reviewScope",
        "deltaBaseSha",
        "deltaSha256",
      ])
    ) {
      reasons.push(`owner review ${required.slot} entry shape is invalid`);
      continue;
    }
    if (!required.allowedScopes.includes(review.reviewScope)) {
      reasons.push(
        `owner review ${required.slot} scope ${JSON.stringify(review.reviewScope ?? null)} is not allowed (INV-125 second amendment: fable is always full-context; sol is full or the sealed exact delta)`,
      );
    }
    if (review.reviewScope === "delta") {
      if (!GIT_SHA.test(review.deltaBaseSha ?? "") || !SHA256.test(review.deltaSha256 ?? "")) {
        reasons.push(
          `owner review ${required.slot} delta scope is missing its base/digest binding`,
        );
      }
    } else if (review.deltaBaseSha !== null || review.deltaSha256 !== null) {
      reasons.push(`owner review ${required.slot} full scope must not carry delta bindings`);
    }
    for (const key of [
      "slot",
      "harnessId",
      "providerFamily",
      "requestedModel",
      "requestedEffort",
    ]) {
      if (review[key] !== required[key]) {
        reasons.push(
          `owner review ${required.slot} ${key} does not match the required native route`,
        );
      }
    }
    if (review.observedModel !== expectedObservedModel(required)) {
      reasons.push(
        `owner review ${required.slot} observed model ${JSON.stringify(review.observedModel)} does not match expected ${JSON.stringify(expectedObservedModel(required))}`,
      );
    }
    if (typeof review.sessionId !== "string" || review.sessionId.length === 0) {
      reasons.push(`owner review ${required.slot} session identity is missing`);
    }
    if (review.externalContextPolicy !== "live" || review.toolWebPolicy !== "live") {
      reasons.push(`owner review ${required.slot} did not run with live web policy`);
    }
    if (!OBSERVED_SOURCES.has(review.observedSource)) {
      reasons.push(`owner review ${required.slot} has no execution-observed model source`);
    }
    if (review.routeProofStatus !== "verified") {
      reasons.push(`owner review ${required.slot} route proof is not verified`);
    }
    if (
      review.authMode !== "local_session" ||
      review.authSwitched !== false ||
      review.effortHonored !== true
    ) {
      reasons.push(`owner review ${required.slot} changed auth or ignored requested effort`);
    }
    if (
      typeof review.reviewRuntimeVersion !== "string" ||
      review.reviewRuntimeVersion !== expected.candidateVersion ||
      review.reviewRuntimeBuildSha !== expected.candidateSha
    ) {
      reasons.push(`owner review ${required.slot} runtime is not the exact candidate build`);
    }
    if (!SHA256.test(review.reviewRuntimeEntrySha256 ?? "")) {
      reasons.push(`owner review ${required.slot} runtime entry digest is invalid`);
    }
    const startedMs = parseExactIso(review.startedAt);
    const completedMs = parseExactIso(review.completedAt);
    if (
      startedMs === null ||
      completedMs === null ||
      completedMs < startedMs ||
      completedMs - startedMs < RELEASE_REVIEW_MIN_PLAUSIBLE_MS ||
      !Number.isSafeInteger(review.durationMs) ||
      review.durationMs < RELEASE_REVIEW_MIN_PLAUSIBLE_MS ||
      Math.abs(completedMs - startedMs - review.durationMs) > 1_000
    ) {
      reasons.push(`owner review ${required.slot} liveness evidence is invalid`);
    }
    for (const key of [
      "promptSha256",
      "reportSha256",
      "metadataSha256",
      "eventsSha256",
      "parsedSha256",
    ]) {
      if (!SHA256.test(review[key] ?? "")) {
        reasons.push(`owner review ${required.slot} ${key} is missing or malformed`);
      }
    }
    if (!OWNER_REVIEW_VERDICTS.includes(review.verdict)) {
      reasons.push(`owner review ${required.slot} verdict must be pass or warn`);
    }
  }
  if (
    reviews.length === REQUIRED_NATIVE_REVIEWERS.length &&
    reviews.every((review) => isRecord(review))
  ) {
    const starts = reviews.map((review) => Date.parse(review.startedAt));
    const completions = reviews.map((review) => Date.parse(review.completedAt));
    if (
      starts.some((value) => !Number.isFinite(value)) ||
      completions.some((value) => !Number.isFinite(value)) ||
      Math.max(...starts) >= Math.min(...completions)
    ) {
      reasons.push("owner review native reviewer executions did not overlap");
    }
    if (new Set(reviews.map((review) => review.sessionId)).size !== reviews.length) {
      reasons.push("owner review native reviewer session identities must be distinct");
    }
    if (new Set(reviews.map((review) => review.reviewRuntimeEntrySha256)).size !== 1) {
      reasons.push("owner review native reviewers did not use the same packaged CLI bytes");
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
        `review attestation schemaVersion ${attestation?.schemaVersion ?? "(missing)"} is not accepted for publish; schemas 2-4 are archive-signature-only`,
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

function hasExactKeys(value, keys) {
  if (!isRecord(value) || Object.keys(value).length !== keys.length) return false;
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function parseExactIso(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  const date = new Date(value);
  return date.toISOString() === value ? date.getTime() : null;
}

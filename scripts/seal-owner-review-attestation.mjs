#!/usr/bin/env node
/** Seal schema-v5 evidence from one frozen native Fable/Codex review wave. */
import { createHash, createPrivateKey, sign } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  OWNER_REVIEW_ATTESTATION_SCHEMA_VERSION,
  OWNER_REVIEW_PROTOCOL,
  RELEASE_REVIEW_ATTESTATION_ALGORITHM,
  REQUIRED_NATIVE_REVIEWERS,
  expectedObservedModel,
  canonicalJson,
  decodeReviewUtf8,
  pathIsWithin,
  releaseAttestationSigningBytes,
  validateFullGateEvidence,
  validateFullGateReceipt,
  validateReleaseAttestation,
} from "./lib/release-review-contract.mjs";
import { readPrivateSigningKey } from "./lib/private-signing-key.mjs";
import {
  readVerifiedReleaseReviewRuntime,
  releaseReviewRuntimeArtifactRoot,
} from "./lib/release-review-runtime.mjs";

const options = parseArgs(process.argv.slice(2));

try {
  const git = (...args) =>
    execFileSync("git", args, { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 }).trim();
  const candidateSha = git("rev-parse", "HEAD");
  const candidateTree = git("rev-parse", "HEAD^{tree}");
  const candidateRoot = realpathSync(git("rev-parse", "--show-toplevel"));
  const candidateVersion = parseJson(
    readStable(join(candidateRoot, "package.json"), "candidate package.json"),
    "candidate package.json",
  ).version;
  if (typeof candidateVersion !== "string" || candidateVersion.length === 0) {
    throw new Error("candidate package.json has no version");
  }
  if (git("status", "--porcelain=v1", "--untracked-files=all")) {
    throw new Error("candidate worktree is dirty; only a committed tree can be sealed");
  }

  const evidenceDir = realDirectory(options["evidence-dir"], "evidence directory");
  const artifactsDir = realDirectory(options["review-artifacts"], "review artifacts directory");
  if (
    pathIsWithin(candidateRoot, evidenceDir) ||
    pathIsWithin(candidateRoot, artifactsDir) ||
    pathsOverlap(evidenceDir, artifactsDir)
  ) {
    throw new Error("candidate, evidence and review artifacts must be separate directories");
  }
  const outputs = [options.out, options["base64-out"]]
    .filter(Boolean)
    .map((output) => canonicalFuturePath(output));
  if (new Set(outputs).size !== outputs.length) {
    throw new Error("attestation JSON and base64 outputs must be different paths");
  }
  for (const target of outputs) {
    if (
      pathIsWithin(candidateRoot, target) ||
      pathIsWithin(evidenceDir, target) ||
      pathIsWithin(artifactsDir, target) ||
      existsSync(target)
    ) {
      throw new Error("attestation output must be a new path outside candidate and evidence");
    }
  }

  const receiptPath = resolve(options["full-gate-receipt"]);
  const runtimeRoot = releaseReviewRuntimeArtifactRoot(receiptPath);
  if ([candidateRoot, evidenceDir, artifactsDir].some((root) => pathsOverlap(root, runtimeRoot))) {
    throw new Error(
      "full-gate receipt and review runtime artifacts must be external and non-overlapping",
    );
  }
  const receiptBytes = readStable(receiptPath, "full-gate receipt");
  const receipt = parseJson(receiptBytes, "full-gate receipt");
  const receiptReasons = validateFullGateReceipt(receipt, { candidateSha, candidateTree });
  if (receiptReasons.length > 0) throw new Error(receiptReasons.join("; "));
  const stdoutBytes = readReceiptLog(
    runtimeRoot,
    receipt.stdout.path,
    receipt.stdout.sha256,
    "full-gate stdout",
  );
  const stderrBytes = readReceiptLog(
    runtimeRoot,
    receipt.stderr.path,
    receipt.stderr.sha256,
    "full-gate stderr",
  );
  const runtime = readVerifiedReleaseReviewRuntime(runtimeRoot, receipt.reviewRuntimeArtifacts);
  const fullGate = {
    receiptSha256: sha256(receiptBytes),
    program: receipt.program,
    argv: receipt.argv,
    exitCode: receipt.exitCode,
    candidateUnchanged: receipt.candidateUnchanged,
    beforeSha: receipt.before?.head,
    beforeTree: receipt.before?.tree,
    afterSha: receipt.after?.head,
    afterTree: receipt.after?.tree,
    stdoutSha256: sha256(stdoutBytes),
    stderrSha256: sha256(stderrBytes),
  };
  const gateReasons = validateFullGateEvidence(fullGate, { candidateSha, candidateTree });
  if (gateReasons.length > 0) throw new Error(gateReasons.join("; "));

  // Execute only the full-gate receipt's verified, self-contained candidate
  // verifier bytes. Mutable workspace dist is never release authority.
  const verifierUrl = `data:text/javascript;base64,${runtime.verifierBytes.toString("base64")}`;
  const {
    containsSecretLikeToken,
    parseSealedReviewEnvelopeDetailed,
    sealedReviewTranscriptFromEvents,
    verifySealedEvidencePacket,
  } = await import(verifierUrl);

  const packet = verifySealedEvidencePacket({ evidenceDir, candidateSha, candidateTree });
  const freeze = parseJson(
    readStable(join(evidenceDir, "FREEZE.json"), "FREEZE.json"),
    "FREEZE.json",
  );
  if (!isUuidV4(freeze.waveId)) throw new Error("FREEZE.json has no UUID-v4 review wave");
  const actualDiff = execFileSync(
    "git",
    ["diff", "--binary", `${packet.baseSha}..${candidateSha}`],
    {
      maxBuffer: 512 * 1024 * 1024,
    },
  );
  const packetDiff = readStable(join(evidenceDir, "DIFF.patch"), "sealed diff");
  if (!packetDiff.equals(actualDiff))
    throw new Error("DIFF.patch is not the exact base..candidate diff");
  const packetReceipt = readStable(
    join(evidenceDir, "context/gates/FULL_GATE_RECEIPT.json"),
    "packet full-gate receipt",
  );
  if (!packetReceipt.equals(receiptBytes)) {
    throw new Error("review packet did not contain the exact supplied full-gate receipt");
  }

  const persistentEvidenceDir = realDirectory(
    join(artifactsDir, "evidence"),
    "persistent reviewer evidence directory",
  );
  verifySealedEvidencePacket({
    evidenceDir: persistentEvidenceDir,
    candidateSha,
    candidateTree,
    expectedManifestSha256: packet.manifestSha256,
  });
  const evidenceMetadataBytes = readArtifact(
    join(artifactsDir, "evidence-metadata.json"),
    "review evidence metadata",
    containsSecretLikeToken,
  );
  const evidenceMetadata = parseJson(evidenceMetadataBytes, "review evidence metadata");
  validateEvidenceMetadata(evidenceMetadata, {
    candidateSha,
    candidateTree,
    evidenceDir,
    persistentEvidenceDir,
    manifestSha256: packet.manifestSha256,
    diffSha256: sha256(packetDiff),
    reviewWaveId: freeze.waveId,
  });

  const reviewerEntries = readdirSync(artifactsDir, { withFileTypes: true }).filter((entry) =>
    /^\d{2}-/.test(entry.name),
  );
  if (
    reviewerEntries.length !== REQUIRED_NATIVE_REVIEWERS.length ||
    reviewerEntries.some((entry) => !entry.isDirectory() || entry.isSymbolicLink())
  ) {
    throw new Error("review artifacts must contain exactly two real reviewer directories");
  }
  const artifacts = reviewerEntries.map((entry) =>
    readReviewerArtifact(
      realDirectory(join(artifactsDir, entry.name), `reviewer ${entry.name}`),
      containsSecretLikeToken,
    ),
  );
  const reviews = REQUIRED_NATIVE_REVIEWERS.map((required) => {
    const matches = artifacts.filter(
      (artifact) => artifact.metadata.harness_id === required.harnessId,
    );
    if (matches.length !== 1)
      throw new Error(`expected exactly one ${required.harnessId} reviewer`);
    return validateReviewerArtifact(matches[0], required, {
      candidateSha,
      candidateTree,
      evidenceDir,
      persistentEvidenceDir,
      manifestSha256: packet.manifestSha256,
      diffSha256: sha256(packetDiff),
      reviewWaveId: freeze.waveId,
      parseSealedReviewEnvelopeDetailed,
      sealedReviewTranscriptFromEvents,
      reviewRuntime: runtime.cli,
    });
  });

  validateReviewerOverlap(reviews);

  const authority = parseJson(readStable(resolve(options.authority), "authority"), "authority");
  if (authority.algorithm !== RELEASE_REVIEW_ATTESTATION_ALGORITHM) {
    throw new Error("authority algorithm is not Ed25519");
  }
  const attestation = {
    schemaVersion: OWNER_REVIEW_ATTESTATION_SCHEMA_VERSION,
    keyId: authority.keyId,
    algorithm: RELEASE_REVIEW_ATTESTATION_ALGORITHM,
    payload: {
      contract: "owner-review-v5",
      reviewProtocol: OWNER_REVIEW_PROTOCOL,
      candidateSha,
      candidateTree,
      evidence: {
        manifestSha256: packet.manifestSha256,
        diffSha256: sha256(packetDiff),
        reviewWaveId: freeze.waveId,
        metadataSha256: sha256(evidenceMetadataBytes),
      },
      fullGate,
      reviews,
      sealedAt: new Date().toISOString(),
    },
  };
  const key = createPrivateKey(readPrivateSigningKey(options["private-key"]));
  attestation.signature = sign(null, releaseAttestationSigningBytes(attestation), key).toString(
    "base64",
  );
  const verified = validateReleaseAttestation(attestation, authority, {
    candidateSha,
    candidateTree,
    candidateVersion,
  });
  if (!verified.ok) throw new Error(`self-verification failed: ${verified.reasons.join("; ")}`);

  const json = `${JSON.stringify(attestation, null, 2)}\n`;
  atomicWrite(outputs[0], json);
  if (options["base64-out"]) {
    atomicWrite(outputs[1], `${Buffer.from(json.trim()).toString("base64")}\n`);
  }
  console.log(`signed native owner-review attestation sealed: ${options.out}`);
} catch (error) {
  console.error(
    `owner-review attestation refused: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}

function validateEvidenceMetadata(metadata, expected) {
  requireIdentity(metadata, expected, "review evidence metadata");
  requireSamePath(metadata.source_evidence_dir, expected.evidenceDir, "source evidence root");
  requireSamePath(
    metadata.persistent_evidence_dir,
    expected.persistentEvidenceDir,
    "persistent evidence root",
  );
  requireGitCandidate(metadata.candidate_root, expected);
}

function readReviewerArtifact(dir, containsSecretLikeToken) {
  if (existsSync(join(dir, "parse-error.json")))
    throw new Error(`${dir} contains parse-error.json`);
  const read = (name, label) => readArtifact(join(dir, name), label, containsSecretLikeToken);
  const metadataBytes = read("metadata.json", "reviewer metadata");
  const promptBytes = read("prompt.md", "reviewer prompt");
  const reportBytes = read("transcript.md", "reviewer transcript");
  const eventsBytes = read("raw-normalized-stream.jsonl", "reviewer events");
  const parsedBytes = read("parsed-json-blocks.json", "reviewer parsed blocks");
  return {
    dir,
    metadata: parseJson(metadataBytes, "reviewer metadata"),
    metadataBytes,
    promptBytes,
    reportBytes,
    eventsBytes,
    parsedBytes,
  };
}

function validateReviewerArtifact(artifact, required, expected) {
  const metadata = artifact.metadata;
  requireIdentity(metadata, expected, `${required.slot} reviewer metadata`);
  for (const [field, value] of [
    ["harness_id", required.harnessId],
    ["provider_family", required.providerFamily],
    ["requested_model", required.requestedModel],
    ["requested_effort", required.requestedEffort],
    // Cursor reports a display name, not the id — the expected observed form
    // is pinned per slot in the contract (owner decision 2026-08-04).
    ["observed_model", expectedObservedModel(required)],
    ["route_proof_status", "verified"],
    ["auth_mode", "local_session"],
    ["status", "completed"],
    ["reviewer_workspace_cleanup", "removed"],
    ["review_runtime_build_sha", expected.candidateSha],
    ["external_context_policy", "live"],
    ["tool_web_policy", "live"],
  ]) {
    if (metadata[field] !== value) throw new Error(`${required.slot} metadata ${field} mismatch`);
  }
  if (
    typeof metadata.review_runtime_version !== "string" ||
    !metadata.review_runtime_version ||
    canonicalJson(metadata.auth_modes) !== canonicalJson(["local_session"]) ||
    metadata.auth_switch != null ||
    metadata.error != null ||
    metadata.transient_retry != null ||
    !Number.isSafeInteger(metadata.duration_ms) ||
    metadata.duration_ms < 1_000 ||
    typeof metadata.session_id !== "string" ||
    metadata.session_id.length === 0 ||
    metadata.submitted_prompt_sha256 !== sha256(artifact.promptBytes) ||
    metadata.review_runtime_entry_sha256 !== expected.reviewRuntime.sha256
  ) {
    throw new Error(`${required.slot} reviewer is not a clean native completion`);
  }
  requireSamePath(
    metadata.review_runtime_entry,
    expected.reviewRuntime.absolutePath,
    `${required.slot} review runtime entry`,
  );
  const startMs = exactIsoMs(metadata.start_time, `${required.slot} start_time`);
  const firstEventMs = exactIsoMs(metadata.first_event_time, `${required.slot} first_event_time`);
  const completionMs = exactIsoMs(metadata.completion_time, `${required.slot} completion_time`);
  if (
    firstEventMs < startMs ||
    firstEventMs > completionMs ||
    completionMs < startMs ||
    completionMs - startMs < 1_000 ||
    Math.abs(completionMs - startMs - metadata.duration_ms) > 1_000
  ) {
    throw new Error(`${required.slot} reviewer timestamps are inconsistent`);
  }
  const ignored = metadata.ignored_settings ?? [];
  if (!Array.isArray(ignored) || ignored.length > 0) {
    throw new Error(`${required.slot} reviewer ignored requested settings`);
  }
  requireSamePath(metadata.artifact_dir, artifact.dir, `${required.slot} artifact directory`);
  requireSamePath(
    metadata.source_candidate_evidence_dir,
    expected.evidenceDir,
    `${required.slot} source evidence root`,
  );
  requireSamePath(
    metadata.persistent_evidence_dir,
    expected.persistentEvidenceDir,
    `${required.slot} persistent evidence root`,
  );
  requireGitCandidate(metadata.source_candidate_root, expected);

  const proof = metadata.route_proof;
  if (
    proof?.status !== "verified" ||
    proof.requested?.harness_id !== required.harnessId ||
    proof.requested?.provider_family !== required.providerFamily ||
    proof.requested?.model_hint !== required.requestedModel ||
    proof.observed?.provider !== required.providerFamily ||
    proof.observed?.model_id !== expectedObservedModel(required) ||
    proof.observed?.evidence_source !== metadata.observed_source ||
    !["stream_event", "transcript"].includes(metadata.observed_source)
  ) {
    throw new Error(
      `${required.slot} route proof is incomplete or inconsistent: expected {harness_id: ${JSON.stringify(required.harnessId)}, provider_family: ${JSON.stringify(required.providerFamily)}, model_hint: ${JSON.stringify(required.requestedModel)}, observed model_id: ${JSON.stringify(expectedObservedModel(required))}}, got ${JSON.stringify(proof ?? null)}`,
    );
  }

  const events = validateEvents(
    artifact.eventsBytes,
    required,
    metadata.observed_source,
    metadata.session_id,
  );
  const reportText = decodeReviewUtf8(artifact.reportBytes, `${required.slot} transcript`);
  const replayedTranscript = expected.sealedReviewTranscriptFromEvents(events);
  if (!artifact.reportBytes.equals(Buffer.from(replayedTranscript, "utf8"))) {
    throw new Error(`${required.slot} transcript is not the exact normalized event projection`);
  }
  const parsed = expected.parseSealedReviewEnvelopeDetailed(reportText, {
    harness_id: required.harnessId,
    requested_model: required.requestedModel,
    requested_effort: required.requestedEffort,
    observed_model: required.requestedModel,
    route_proof_status: "verified",
  });
  if (parsed.error || parsed.malformed > 0) {
    throw new Error(`${required.slot} report cannot seal: ${parsed.error ?? "malformed findings"}`);
  }
  if (
    canonicalJson(parseJson(artifact.parsedBytes, "reviewer parsed blocks")) !==
    canonicalJson(parsed.blocks)
  ) {
    throw new Error(`${required.slot} parsed blocks do not match the transcript`);
  }
  const blocking = new Set(["BLOCK", "FIX_FIRST", "NEEDS_HUMAN", "INSUFFICIENT_EVIDENCE"]);
  if (parsed.findings.some((finding) => blocking.has(finding.severity))) {
    throw new Error(`${required.slot} report contains a blocking or inconclusive finding`);
  }
  return {
    ...required,
    sessionId: metadata.session_id,
    externalContextPolicy: metadata.external_context_policy,
    toolWebPolicy: metadata.tool_web_policy,
    observedModel: metadata.observed_model,
    observedSource: metadata.observed_source,
    routeProofStatus: metadata.route_proof_status,
    authMode: metadata.auth_mode,
    authSwitched: false,
    effortHonored: true,
    reviewRuntimeVersion: metadata.review_runtime_version,
    reviewRuntimeBuildSha: metadata.review_runtime_build_sha,
    reviewRuntimeEntrySha256: metadata.review_runtime_entry_sha256,
    startedAt: metadata.start_time,
    completedAt: metadata.completion_time,
    durationMs: metadata.duration_ms,
    promptSha256: sha256(artifact.promptBytes),
    reportSha256: sha256(artifact.reportBytes),
    metadataSha256: sha256(artifact.metadataBytes),
    eventsSha256: sha256(artifact.eventsBytes),
    parsedSha256: sha256(artifact.parsedBytes),
    verdict: parsed.findings.length === 0 ? "pass" : "warn",
  };
}

function validateEvents(bytes, required, observedSource, sessionId) {
  const lines = decodeReviewUtf8(bytes, `${required.slot} events`).split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) throw new Error(`${required.slot} reviewer emitted no events`);
  const events = lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`${required.slot} event ${index + 1} is malformed JSON`);
    }
  });
  for (const [index, event] of events.entries()) {
    if (event.session_id !== sessionId) {
      throw new Error(`${required.slot} event ${index + 1} session identity mismatch`);
    }
    exactIsoMs(event.ts, `${required.slot} event ${index + 1} timestamp`);
  }
  const ignoredSettings = events.some((event) => event.payload?.ignored_settings !== undefined);
  if (
    ignoredSettings ||
    events.some(
      (event) =>
        event.type === "error" || event.transient != null || event.payload?.auth_switched === true,
    ) ||
    !events.some((event) => event.type === "completed" && event.payload?.exit_code === 0)
  ) {
    throw new Error(`${required.slot} events contain a failure, auth switch or ignored setting`);
  }
  const routed = events.filter((event) => event.credential_route != null);
  // Cursor's routed events carry credential_route but omit credential_source
  // (measured 2026-08-04, run-d2bffab59d74) — the native-session fact for that
  // slot lives in telemetry auth_mode/auth_source, both still checked. When the
  // key IS present it must still say native_session; only its absence is
  // tolerated, and only for the cursor slot (owner decision 2026-08-04).
  const nativeCredentialSource = (event) =>
    event.credential_source === "native_session" ||
    (required.harnessId === "cursor" && event.credential_source == null);
  if (
    routed.length === 0 ||
    routed.some(
      (event) => event.credential_route !== "vendor_native" || !nativeCredentialSource(event),
    )
  ) {
    const offender = routed.find(
      (event) => event.credential_route !== "vendor_native" || !nativeCredentialSource(event),
    );
    throw new Error(
      `${required.slot} events do not prove a native local session (routed events: ${routed.length}, offending event: ${JSON.stringify(offender ? { credential_route: offender.credential_route ?? null, credential_source: offender.credential_source ?? null } : null)})`,
    );
  }
  const observed = events.filter((event) => event.observed_model != null);
  const sources = new Set(
    observed.map((event) =>
      event.payload?.observed_model_source === "transcript" ? "transcript" : "stream_event",
    ),
  );
  if (
    observed.length === 0 ||
    observed.some((event) => event.observed_model !== expectedObservedModel(required)) ||
    !sources.has(observedSource)
  ) {
    const mismatch = observed.find(
      (event) => event.observed_model !== expectedObservedModel(required),
    );
    throw new Error(
      `${required.slot} events do not prove the exact observed model (expected ${JSON.stringify(expectedObservedModel(required))}, observed events: ${observed.length}, first mismatch: ${JSON.stringify(mismatch?.observed_model ?? null)})`,
    );
  }
  if (events.every((event) => event.type !== "message" || typeof event.text !== "string")) {
    throw new Error(`${required.slot} events contain no reviewer transcript messages`);
  }
  return events;
}

function validateReviewerOverlap(reviews) {
  const starts = reviews.map((review) => exactIsoMs(review.startedAt, `${review.slot} start`));
  const completions = reviews.map((review) =>
    exactIsoMs(review.completedAt, `${review.slot} completion`),
  );
  if (Math.max(...starts) >= Math.min(...completions)) {
    throw new Error("native reviewer executions did not overlap");
  }
  if (new Set(reviews.map((review) => review.sessionId)).size !== reviews.length) {
    throw new Error("native reviewer session identities are not distinct");
  }
}

function requireIdentity(metadata, expected, label) {
  for (const [field, value] of [
    ["candidate_sha", expected.candidateSha],
    ["candidate_tree", expected.candidateTree],
    ["packet_manifest_sha256", expected.manifestSha256],
    ["review_wave_id", expected.reviewWaveId],
    ["diff_sha256", `sha256:${expected.diffSha256}`],
  ]) {
    if (metadata?.[field] !== value) throw new Error(`${label} ${field} mismatch`);
  }
}

function requireGitCandidate(path, expected) {
  const root = realDirectory(path, "review source candidate");
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  if (
    git("rev-parse", "HEAD") !== expected.candidateSha ||
    git("rev-parse", "HEAD^{tree}") !== expected.candidateTree ||
    git("status", "--porcelain=v1", "--untracked-files=all")
  ) {
    throw new Error("review source is not the exact clean candidate");
  }
}

function readArtifact(path, label, containsSecretLikeToken) {
  const bytes = readStable(path, label);
  const text = decodeReviewUtf8(bytes, label);
  if (containsSecretLikeToken(text)) throw new Error(`${label} contains a secret-like token`);
  return bytes;
}

function readStable(path, label, allowEmpty = false) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile()) throw new Error(`${label} is not a regular file`);
    const bytes = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    for (const key of ["dev", "ino", "size", "mtimeNs", "ctimeNs"]) {
      if (before[key] !== after[key]) throw new Error(`${label} changed while it was read`);
    }
    if ((!allowEmpty && bytes.length === 0) || BigInt(bytes.length) !== before.size) {
      throw new Error(`${label} has an invalid byte length`);
    }
    return bytes;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function readReceiptLog(root, rawPath, expectedSha256, label) {
  if (typeof rawPath !== "string" || rawPath.trim() === "") {
    throw new Error(`${label} path is missing from the full-gate receipt`);
  }
  const lexical = resolve(root, rawPath);
  const stat = lstatSync(lexical);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} is not a regular file`);
  const canonical = realpathSync(lexical);
  if (!pathIsWithin(root, canonical)) {
    throw new Error(`${label} escapes the full-gate receipt directory`);
  }
  const bytes = readStable(canonical, label, true);
  if (sha256(bytes) !== expectedSha256) {
    throw new Error(`${label} digest does not match the full-gate receipt`);
  }
  return bytes;
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(decodeReviewUtf8(bytes, label));
  } catch (error) {
    throw new Error(
      `${label} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function realDirectory(path, label) {
  const lexical = resolve(path);
  const stat = lstatSync(lexical);
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error(`${label} must be a real directory`);
  return realpathSync(lexical);
}

function canonicalFuturePath(path) {
  const lexical = resolve(path);
  const parent = realDirectory(dirname(lexical), "attestation output directory");
  return join(parent, basename(lexical));
}

function exactIsoMs(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} is not an exact ISO timestamp`);
  }
  const date = new Date(value);
  if (date.toISOString() !== value) throw new Error(`${label} is not an exact ISO timestamp`);
  return date.getTime();
}

function requireSamePath(raw, expected, label) {
  if (typeof raw !== "string" || realpathSync(raw) !== expected)
    throw new Error(`${label} mismatch`);
}

function pathsOverlap(left, right) {
  return pathIsWithin(left, right) || pathIsWithin(right, left);
}

function isUuidV4(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value ?? "");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function atomicWrite(path, data) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, data, { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
}

function parseArgs(argv) {
  const required = [
    "full-gate-receipt",
    "evidence-dir",
    "review-artifacts",
    "private-key",
    "authority",
    "out",
  ];
  const allowed = new Set([...required, "base64-out"]);
  const parsed = {};
  if (argv.length % 2 !== 0) usage();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const key = flag?.startsWith("--") ? flag.slice(2) : "";
    if (!allowed.has(key) || parsed[key] !== undefined || !argv[index + 1]) usage();
    parsed[key] = argv[index + 1];
  }
  if (required.some((key) => !parsed[key])) usage();
  return parsed;
}

function usage() {
  console.error(
    "usage: seal-owner-review-attestation.mjs --full-gate-receipt FILE --evidence-dir DIR --review-artifacts DIR --private-key FILE --authority FILE --out FILE [--base64-out FILE]",
  );
  process.exit(2);
}

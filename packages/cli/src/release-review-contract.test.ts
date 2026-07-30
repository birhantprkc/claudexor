import { execFileSync, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { FROZEN_REVIEW_EVIDENCE_FILES } from "../../context/src/evidence.js";
import { describe, expect, it } from "vitest";
import {
  ARCHIVED_OWNER_REVIEW_SCHEMA_VERSIONS,
  OWNER_REVIEW_ATTESTATION_SCHEMA_VERSION,
  OWNER_REVIEW_PROTOCOL,
  REQUIRED_NATIVE_REVIEWERS,
  decodeReviewUtf8,
  pathIsWithin,
  releaseAttestationSigningBytes,
  validateFullGateReceipt,
  validateReleaseAttestation,
  validateReleaseInput,
  verifyArchivedReleaseAttestationSignature,
} from "../../../scripts/lib/release-review-contract.mjs";
import { bundleReleaseReviewVerifier } from "../../../scripts/lib/release-review-runtime.mjs";

const candidateSha = "a".repeat(40);
const candidateTree = "b".repeat(40);
const digest = "d".repeat(64);
const expected = { candidateSha, candidateTree, candidateVersion: "3.2.0" };
const repoRoot = resolve(import.meta.dirname, "../../..");
const sealer = resolve(repoRoot, "scripts/seal-owner-review-attestation.mjs");
const fullGateReceiptRunner = resolve(repoRoot, "scripts/run-full-gate-receipt.mjs");

const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

function write(path: string, contents: string | Buffer) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function fixture() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const authority = {
    schemaVersion: 1,
    keyId: "fixture-key",
    algorithm: "Ed25519",
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
  const reviews = REQUIRED_NATIVE_REVIEWERS.map((required, index) => ({
    ...required,
    sessionId: `session-${index + 1}`,
    externalContextPolicy: "live",
    toolWebPolicy: "live",
    observedModel: required.requestedModel,
    observedSource: index === 0 ? "stream_event" : "transcript",
    routeProofStatus: "verified",
    authMode: "local_session",
    authSwitched: false,
    effortHonored: true,
    reviewRuntimeVersion: "3.2.0",
    reviewRuntimeBuildSha: candidateSha,
    reviewRuntimeEntrySha256: digest,
    startedAt: `2026-07-30T00:00:0${index}.000Z`,
    completedAt: `2026-07-30T00:00:0${index + 5}.000Z`,
    durationMs: 5_000,
    promptSha256: digest,
    reportSha256: digest,
    metadataSha256: digest,
    eventsSha256: digest,
    parsedSha256: digest,
    verdict: index === 0 ? "pass" : "warn",
  }));
  const payload = {
    contract: "owner-review-v5",
    reviewProtocol: OWNER_REVIEW_PROTOCOL,
    candidateSha,
    candidateTree,
    evidence: {
      manifestSha256: digest,
      diffSha256: digest,
      reviewWaveId: "11111111-1111-4111-8111-111111111111",
      metadataSha256: digest,
    },
    fullGate: {
      receiptSha256: digest,
      program: "pnpm",
      argv: ["pnpm", "release:verify"],
      exitCode: 0,
      candidateUnchanged: true,
      beforeSha: candidateSha,
      beforeTree: candidateTree,
      afterSha: candidateSha,
      afterTree: candidateTree,
      stdoutSha256: digest,
      stderrSha256: digest,
    },
    reviews,
    sealedAt: "2026-07-30T00:00:00.000Z",
  };
  const resign = (unsigned: any) => ({
    ...unsigned,
    signature: sign(null, releaseAttestationSigningBytes(unsigned), privateKey).toString("base64"),
  });
  const attestation = resign({
    schemaVersion: OWNER_REVIEW_ATTESTATION_SCHEMA_VERSION,
    keyId: authority.keyId,
    algorithm: "Ed25519",
    payload,
  });
  return { attestation, authority, resign };
}

describe("native owner-review publishing contract", () => {
  it("requires the exact successful full-gate receipt shape", () => {
    const receipt = {
      program: "pnpm",
      argv: ["pnpm", "release:verify"],
      exitCode: 0,
      gateExitCode: 0,
      candidateUnchanged: true,
      before: { head: candidateSha, tree: candidateTree, status: "" },
      after: { head: candidateSha, tree: candidateTree, status: "" },
      stdout: { path: "/external/full-gate.stdout.log", sha256: digest },
      stderr: { path: "/external/full-gate.stderr.log", sha256: digest },
      reviewRuntimeArtifacts: [
        { path: "release-review-verifier.mjs", bytes: 1, sha256: digest },
        { path: "claudexor.bundle.cjs", bytes: 1, sha256: digest },
      ],
      reviewRuntimeArtifactError: null,
      finishedAt: "2026-07-30T00:00:00.000Z",
    };
    const identity = { candidateSha, candidateTree };
    expect(validateFullGateReceipt(receipt, identity)).toEqual([]);
    for (const mutate of [
      (value: any) => delete value.gateExitCode,
      (value: any) => (value.gateExitCode = 1),
      (value: any) => (value.before.status = " M package.json"),
      (value: any) => (value.reviewRuntimeArtifactError = "bundle failed"),
      (value: any) => delete value.stdout.path,
      (value: any) => (value.finishedAt = "today"),
      (value: any) => value.reviewRuntimeArtifacts.pop(),
      (value: any) => (value.extra = true),
    ]) {
      const invalid = structuredClone(receipt);
      mutate(invalid);
      expect(validateFullGateReceipt(invalid, identity)).not.toEqual([]);
    }
  });

  it("freezes the exact two native routes and accepts their signed v5 evidence", () => {
    expect(OWNER_REVIEW_ATTESTATION_SCHEMA_VERSION).toBe(5);
    expect(OWNER_REVIEW_PROTOCOL).toBe("native-full-context-v1");
    expect(REQUIRED_NATIVE_REVIEWERS).toEqual([
      {
        slot: "fable",
        harnessId: "claude",
        providerFamily: "anthropic",
        requestedModel: "claude-fable-5",
        requestedEffort: "max",
      },
      {
        slot: "codex",
        harnessId: "codex",
        providerFamily: "openai",
        requestedModel: "gpt-5.6-sol",
        requestedEffort: "xhigh",
      },
    ]);
    const { attestation, authority } = fixture();
    expect(validateReleaseAttestation(attestation, authority, expected)).toEqual({
      ok: true,
      reasons: [],
    });
  });

  it.each([
    ["requested route", (a: any) => (a.payload.reviews[0].requestedModel = "claude-opus-5")],
    ["observed model", (a: any) => (a.payload.reviews[1].observedModel = "gpt-5.5")],
    ["observed source", (a: any) => (a.payload.reviews[0].observedSource = "request")],
    ["route proof", (a: any) => (a.payload.reviews[1].routeProofStatus = "unverified")],
    ["auth switch", (a: any) => (a.payload.reviews[0].authSwitched = true)],
    ["ignored effort", (a: any) => (a.payload.reviews[1].effortHonored = false)],
    ["cached context", (a: any) => (a.payload.reviews[0].externalContextPolicy = "cached")],
    ["missing live web", (a: any) => (a.payload.reviews[1].toolWebPolicy = "deny")],
    ["implausible duration", (a: any) => (a.payload.reviews[0].durationMs = 999)],
    [
      "implausible wall time",
      (a: any) => {
        a.payload.reviews[0].completedAt = a.payload.reviews[0].startedAt;
        a.payload.reviews[0].durationMs = 1_000;
      },
    ],
    ["reused session", (a: any) => (a.payload.reviews[1].sessionId = "session-1")],
    [
      "different runtime bytes",
      (a: any) => (a.payload.reviews[1].reviewRuntimeEntrySha256 = "e".repeat(64)),
    ],
    [
      "non-overlapping execution",
      (a: any) => {
        a.payload.reviews[1].startedAt = "2026-07-30T00:00:10.000Z";
        a.payload.reviews[1].completedAt = "2026-07-30T00:00:15.000Z";
      },
    ],
    [
      "zero overlap boundary",
      (a: any) => {
        a.payload.reviews[1].startedAt = "2026-07-30T00:00:05.000Z";
        a.payload.reviews[1].completedAt = "2026-07-30T00:00:10.000Z";
      },
    ],
    ["runtime build", (a: any) => (a.payload.reviews[0].reviewRuntimeBuildSha = "c".repeat(40))],
    ["blocking verdict", (a: any) => (a.payload.reviews[1].verdict = "block")],
    ["evidence manifest", (a: any) => (a.payload.evidence.manifestSha256 = "bad")],
    ["review wave", (a: any) => (a.payload.evidence.reviewWaveId = "wave-1")],
    ["failed full gate", (a: any) => (a.payload.fullGate.exitCode = 1)],
    ["changed candidate", (a: any) => (a.payload.candidateSha = "c".repeat(40))],
    ["extra retired field", (a: any) => (a.payload.coverageReceipt = {})],
  ])("rejects a freshly signed semantic forgery: %s", (_label, mutate) => {
    const { attestation, authority, resign } = fixture();
    const forged = structuredClone(attestation);
    mutate(forged);
    expect(validateReleaseAttestation(resign(forged), authority, expected).ok).toBe(false);
  });

  it("requires exactly the ordered Fable and Codex pair", () => {
    const { attestation, authority, resign } = fixture();
    for (const reviews of [
      attestation.payload.reviews.slice(0, 1),
      [...attestation.payload.reviews, attestation.payload.reviews[0]],
      [...attestation.payload.reviews].reverse(),
    ]) {
      const changed = structuredClone(attestation);
      changed.payload.reviews = reviews;
      expect(validateReleaseAttestation(resign(changed), authority, expected).ok).toBe(false);
    }
  });

  it("detects post-signature tampering", () => {
    const { attestation, authority } = fixture();
    attestation.payload.reviews[0].verdict = "warn";
    expect(validateReleaseAttestation(attestation, authority, expected).reasons).toContain(
      "review attestation signature is invalid",
    );
  });

  it("verifies schemas 2-4 only as historical signed bytes and never publishes them", () => {
    const { attestation, authority, resign } = fixture();
    for (const schemaVersion of ARCHIVED_OWNER_REVIEW_SCHEMA_VERSIONS) {
      const archived = resign({ ...attestation, schemaVersion, payload: { historical: true } });
      expect(verifyArchivedReleaseAttestationSignature(archived, authority)).toEqual({
        ok: true,
        reasons: [],
      });
      expect(validateReleaseAttestation(archived, authority, expected).reasons.join(" ")).toContain(
        "archive-signature-only",
      );
    }
    expect(verifyArchivedReleaseAttestationSignature(attestation, authority).ok).toBe(false);
  });

  it("keeps input, path and strict UTF-8 checks small and fail-closed", () => {
    expect(validateReleaseInput("candidate", candidateSha).ok).toBe(true);
    expect(validateReleaseInput("candidate", "main").ok).toBe(false);
    expect(validateReleaseInput("publish", "v3.2.0").ok).toBe(true);
    expect(validateReleaseInput("publish", "v3.2.0-rc.1").ok).toBe(false);
    expect(pathIsWithin("/candidate", "/candidate/evidence")).toBe(true);
    expect(pathIsWithin("/candidate", "/candidate-sibling")).toBe(false);
    expect(() => decodeReviewUtf8(Buffer.from([0xc3, 0x28]))).toThrow(/not valid UTF-8/);
  });

  it("requires the full-gate receipt output directory argument", () => {
    const result = spawnSync(process.execPath, [fullGateReceiptRunner], { encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("OUT_DIR");
  });

  it("refuses an in-candidate full-gate output before creating it", () => {
    const root = mkdtempSync(join(tmpdir(), "claudexor-gate-boundary-"));
    const candidate = join(root, "candidate");
    const outDir = join(candidate, "ignored-gate");
    try {
      mkdirSync(candidate);
      execFileSync("git", ["init", "-q"], { cwd: candidate });
      const result = spawnSync(process.execPath, [fullGateReceiptRunner, outDir], {
        cwd: candidate,
        encoding: "utf8",
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("must be external");
      expect(existsSync(outDir)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("native owner-review sealer", () => {
  it("derives a signed pass/warn pair from clean on-disk artifacts", async () => {
    const root = mkdtempSync(join(tmpdir(), "claudexor-v5-sealer-"));
    const candidate = join(root, "candidate");
    const evidence = join(root, "evidence");
    const artifacts = join(root, "artifacts");
    const gateDir = join(root, "gate");
    const gatePath = join(gateDir, "full-gate-receipt.json");
    const authorityPath = join(root, "authority.json");
    const privateKeyPath = join(root, "private.pem");
    const out = join(root, "attestation.json");
    const wave = "11111111-1111-4111-8111-111111111111";
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: candidate, encoding: "utf8" }).trim();
    try {
      mkdirSync(candidate);
      git("init", "-q");
      git("config", "user.email", "fixture@example.invalid");
      git("config", "user.name", "fixture");
      write(join(candidate, "file.txt"), "base\n");
      write(join(candidate, "package.json"), json({ version: "3.2.0" }));
      git("add", "file.txt");
      git("add", "package.json");
      git("commit", "-qm", "base");
      const baseSha = git("rev-parse", "HEAD");
      write(join(candidate, "file.txt"), "candidate\n");
      git("add", "file.txt");
      git("commit", "-qm", "candidate");
      const sha = git("rev-parse", "HEAD");
      const tree = git("rev-parse", "HEAD^{tree}");
      const diff = execFileSync("git", ["diff", "--binary", `${baseSha}..${sha}`], {
        cwd: candidate,
      });
      const verifierPath = join(gateDir, "release-review-verifier.mjs");
      const cliPath = join(gateDir, "claudexor.bundle.cjs");
      const verifierBuild = await bundleReleaseReviewVerifier(repoRoot, verifierPath);
      write(verifierPath, Buffer.from(verifierBuild.contents));
      const reviewEnginePath = resolve(repoRoot, "packages/review/src/reviewEngine.ts");
      write(
        cliPath,
        `#!/usr/bin/env node
// Candidate ${sha}
const { readFileSync } = require("node:fs");
const { pathToFileURL } = require("node:url");
(async () => {
  const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const { reviewCandidate } = await import(pathToFileURL(config.reviewEnginePath).href);
  const reviewers = config.reviewers.map((required, index) => ({
    providerFamily: required.providerFamily,
    requestedModel: required.requestedModel,
    requestedEffort: required.requestedEffort,
    authPreference: "subscription",
    adapter: {
      id: required.harnessId,
      async *run(spec) {
        const started = new Date().toISOString();
        const observedSource = index === 0 ? "stream_event" : "transcript";
        yield {
          type: "started",
          session_id: spec.session_id,
          ts: started,
          observed_model: required.requestedModel,
          credential_route: "vendor_native",
          credential_source: "native_session",
          payload: observedSource === "transcript" ? { observed_model_source: "transcript" } : {},
        };
        await new Promise((resolve) => setTimeout(resolve, 1_100));
        const findings = index === 0 ? [] : [{
          severity: "WARN",
          category: "correctness",
          claim: "Non-blocking fixture finding",
          evidence: { files: [{ path: "file.txt", lines: "1" }] },
        }];
        const envelope = {
          completion: {
            verdict: "PASS",
            checklist: [
              "sealed_evidence",
              "intent_and_scope",
              "runtime_and_security",
              "tests_and_release",
            ].map((item) => ({ item, completed: true })),
            findingCount: findings.length,
          },
          findings,
        };
        const completed = new Date().toISOString();
        yield {
          type: "message",
          session_id: spec.session_id,
          ts: completed,
          text: JSON.stringify(envelope) + "\\n",
        };
        yield {
          type: "completed",
          session_id: spec.session_id,
          ts: completed,
          payload: { exit_code: 0 },
        };
      },
    },
  }));
  await reviewCandidate({
    candidateLabel: "Release candidate",
    diff: readFileSync(config.diffPath, "utf8"),
    evidenceDir: config.evidenceDir,
    evidenceReadOnly: true,
    frozenIdentity: config.frozenIdentity,
    env: { CLAUDEXOR_REVIEW_WAVE_ID: config.wave },
    artifactsDir: config.artifactsDir,
    cwd: config.candidate,
    reviewers,
  });
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`,
      );
      const reviewRuntimeArtifacts = [verifierPath, cliPath].map((path) => ({
        path: path.endsWith(".mjs") ? "release-review-verifier.mjs" : "claudexor.bundle.cjs",
        bytes: readFileSync(path).length,
        sha256: hash(readFileSync(path)),
      }));
      const gateStdoutPath = join(gateDir, "full-gate.stdout.log");
      const gateStderrPath = join(gateDir, "full-gate.stderr.log");
      write(gateStdoutPath, "release gate passed\n");
      write(gateStderrPath, "");
      const gate = {
        program: "pnpm",
        argv: ["pnpm", "release:verify"],
        exitCode: 0,
        gateExitCode: 0,
        candidateUnchanged: true,
        before: { head: sha, tree, status: "" },
        after: { head: sha, tree, status: "" },
        stdout: { path: gateStdoutPath, sha256: hash(readFileSync(gateStdoutPath)) },
        stderr: { path: gateStderrPath, sha256: hash(readFileSync(gateStderrPath)) },
        reviewRuntimeArtifacts,
        reviewRuntimeArtifactError: null,
        finishedAt: "2026-07-30T00:00:00.000Z",
      };
      const gateBytes = json(gate);
      write(gatePath, gateBytes);

      for (const file of FROZEN_REVIEW_EVIDENCE_FILES) write(join(evidence, file), "fixture\n");
      write(
        join(evidence, "FREEZE.json"),
        json({ candidateSha: sha, candidateTree: tree, baseSha, waveId: wave }),
      );
      write(join(evidence, "DIFF.patch"), diff);
      write(join(evidence, "context/gates/FULL_GATE_RECEIPT.json"), gateBytes);
      const packetFiles = [
        ...FROZEN_REVIEW_EVIDENCE_FILES,
        "context/gates/FULL_GATE_RECEIPT.json",
      ].sort();
      write(
        join(evidence, "MANIFEST.sha256"),
        packetFiles
          .map((file) => `${hash(readFileSync(join(evidence, file)))}  ${file}`)
          .join("\n") + "\n",
      );
      const manifestSha256 = hash(readFileSync(join(evidence, "MANIFEST.sha256")));
      const reviewConfigPath = join(root, "review-config.json");
      write(
        reviewConfigPath,
        json({
          reviewEnginePath,
          candidate,
          evidenceDir: evidence,
          artifactsDir: artifacts,
          diffPath: join(evidence, "DIFF.patch"),
          wave,
          frozenIdentity: {
            candidateSha: sha,
            candidateTree: tree,
            packetManifestSha256: manifestSha256,
          },
          reviewers: REQUIRED_NATIVE_REVIEWERS,
        }),
      );
      const engine = spawnSync(process.execPath, ["--import", "tsx", cliPath, reviewConfigPath], {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...process.env, CLAUDEXOR_BUILD_SHA: sha },
      });
      expect(engine.stderr).toBe("");
      expect(engine.status).toBe(0);

      const keys = generateKeyPairSync("ed25519");
      write(
        authorityPath,
        json({
          schemaVersion: 1,
          keyId: "fixture-key",
          algorithm: "Ed25519",
          publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
        }),
      );
      write(privateKeyPath, keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString());
      chmodSync(privateKeyPath, 0o600);
      const runSealer = (output: string, receipt = gatePath) =>
        spawnSync(
          process.execPath,
          [
            sealer,
            "--full-gate-receipt",
            receipt,
            "--evidence-dir",
            evidence,
            "--review-artifacts",
            artifacts,
            "--private-key",
            privateKeyPath,
            "--authority",
            authorityPath,
            "--out",
            output,
          ],
          { cwd: candidate, encoding: "utf8" },
        );
      const result = runSealer(out);
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(JSON.parse(readFileSync(out, "utf8"))).toMatchObject({
        schemaVersion: 5,
        payload: { candidateSha: sha, reviews: [{ verdict: "pass" }, { verdict: "warn" }] },
      });
      const partialGatePath = join(gateDir, "partial-full-gate-receipt.json");
      const partialGate = structuredClone(gate) as any;
      delete partialGate.gateExitCode;
      write(partialGatePath, json(partialGate));
      const partialGateRefused = runSealer(
        join(root, "partial-gate-refused.json"),
        partialGatePath,
      );
      expect(partialGateRefused.status).toBe(1);
      expect(partialGateRefused.stderr).toContain("full-gate receipt shape is invalid");

      write(gateStdoutPath, "tampered gate output\n");
      const logDriftRefused = runSealer(join(root, "log-drift-refused.json"));
      expect(logDriftRefused.status).toBe(1);
      expect(logDriftRefused.stderr).toContain("digest does not match");
      write(gateStdoutPath, "release gate passed\n");

      const inTreeGate = join(candidate, ".git", "review-gate");
      const inTreeReceipt = join(inTreeGate, "full-gate-receipt.json");
      write(inTreeReceipt, readFileSync(gatePath));
      write(join(inTreeGate, "release-review-verifier.mjs"), readFileSync(verifierPath));
      write(join(inTreeGate, "claudexor.bundle.cjs"), readFileSync(cliPath));
      const inTreeGateRefused = runSealer(join(root, "in-tree-gate-refused.json"), inTreeReceipt);
      expect(inTreeGateRefused.status).toBe(1);
      expect(inTreeGateRefused.stderr).toContain("must be external and non-overlapping");
      const verifierBytes = readFileSync(verifierPath);
      write(verifierPath, Buffer.concat([verifierBytes, Buffer.from("\n// drift\n")]));
      const runtimeDriftRefused = runSealer(join(root, "runtime-drift-refused.json"));
      expect(runtimeDriftRefused.status).toBe(1);
      expect(runtimeDriftRefused.stderr).toContain("drifted after full gate");
      write(verifierPath, verifierBytes);
      const sameOutput = join(root, "same-output.json");
      const sameOutputRefused = spawnSync(
        process.execPath,
        [
          sealer,
          "--full-gate-receipt",
          gatePath,
          "--evidence-dir",
          evidence,
          "--review-artifacts",
          artifacts,
          "--private-key",
          privateKeyPath,
          "--authority",
          authorityPath,
          "--out",
          sameOutput,
          "--base64-out",
          `${root}/unused/../same-output.json`,
        ],
        { cwd: candidate, encoding: "utf8" },
      );
      expect(sameOutputRefused.status).toBe(1);
      expect(sameOutputRefused.stderr).toContain("must be different paths");

      const codexMetadataPath = join(artifacts, "02-codex", "metadata.json");
      const codexMetadata = JSON.parse(readFileSync(codexMetadataPath, "utf8"));
      write(codexMetadataPath, json({ ...codexMetadata, ignored_settings: ["effort=xhigh"] }));
      const refused = runSealer(join(root, "refused.json"));
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain("ignored requested settings");

      write(codexMetadataPath, json(codexMetadata));
      const codexTranscriptPath = join(artifacts, "02-codex", "transcript.md");
      const codexTranscript = readFileSync(codexTranscriptPath);
      write(codexTranscriptPath, Buffer.concat([codexTranscript, Buffer.from("drift\n")]));
      const transcriptRefused = runSealer(join(root, "transcript-refused.json"));
      expect(transcriptRefused.status).toBe(1);
      expect(transcriptRefused.stderr).toContain("exact normalized event projection");

      write(codexTranscriptPath, codexTranscript);
      write(
        codexMetadataPath,
        json({
          ...codexMetadata,
          start_time: "2026-07-30T00:00:10.000Z",
          first_event_time: "2026-07-30T00:00:11.000Z",
          completion_time: "2026-07-30T00:00:15.000Z",
          duration_ms: 5_000,
        }),
      );
      const overlapRefused = runSealer(join(root, "overlap-refused.json"));
      expect(overlapRefused.status).toBe(1);
      expect(overlapRefused.stderr).toContain("did not overlap");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

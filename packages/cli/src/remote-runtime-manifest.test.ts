import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  REMOTE_RUNTIME_MANIFEST_KIND,
  REMOTE_RUNTIME_TARGETS,
  remoteRuntimeArchiveName,
  remoteRuntimeArchiveUrl,
  remoteRuntimeManifestSigningBytes,
  signRemoteRuntimeManifest,
  validateRemoteRuntimeManifestShape,
  verifyRemoteRuntimeManifest,
} from "../../../scripts/lib/remote-runtime-manifest-contract.mjs";

const PEM_LABEL = "PRIVATE KEY";
const TEST_PRIVATE_KEY_PEM = `-----BEGIN ${PEM_LABEL}-----\nMC4CAQAwBQYDK2VwBCIEIJcml9Acg6+XssPo8BxmJyg1dTrW8oxBc7FgWTVsxOji\n-----END ${PEM_LABEL}-----\n`;
const TEST_AUTHORITY = {
  schemaVersion: 1,
  keyId: "claudexor-runtime-update-TESTVECTOR-ed25519",
  algorithm: "Ed25519",
  publicKeyPem:
    "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAPQA1OS9cjhmVsQC2T34MbYHoY7UeKyS3B6zoNy79Sm0=\n-----END PUBLIC KEY-----\n",
};

function unsignedManifest() {
  const version = "3.2.0";
  return {
    version,
    buildSha: "1".repeat(40),
    protocolMajor: 3 as const,
    minAppVersion: "3.2.0",
    notes: "test",
    assets: REMOTE_RUNTIME_TARGETS.map((target) => {
      return {
        target,
        platform: target.startsWith("linux") ? ("linux" as const) : ("darwin" as const),
        arch: target.endsWith("x64") ? ("x64" as const) : ("arm64" as const),
        nodeVersion: "24.16.0",
        archiveName: remoteRuntimeArchiveName(version, target),
        archiveUrl: remoteRuntimeArchiveUrl(version, target),
        sha256: target.startsWith("linux") ? "a".repeat(64) : "b".repeat(64),
      };
    }),
  };
}

describe("remote runtime manifest", () => {
  it("signs and verifies all four ordered platform assets", () => {
    const signed = signRemoteRuntimeManifest(
      unsignedManifest(),
      TEST_PRIVATE_KEY_PEM,
      TEST_AUTHORITY,
    );
    expect(signed.kind).toBe(REMOTE_RUNTIME_MANIFEST_KIND);
    expect(signed.assets.map((asset: { target: string }) => asset.target)).toEqual(
      REMOTE_RUNTIME_TARGETS,
    );
    expect(verifyRemoteRuntimeManifest(signed, TEST_AUTHORITY)).toEqual({
      ok: true,
      reasons: [],
    });
    expect(remoteRuntimeManifestSigningBytes(signed).length).toBeGreaterThan(100);
  });

  it("refuses missing targets, redirected assets and tampering", () => {
    const missing = unsignedManifest();
    missing.assets.pop();
    expect(
      validateRemoteRuntimeManifestShape({
        ...missing,
        schemaVersion: 1,
        kind: REMOTE_RUNTIME_MANIFEST_KIND,
        keyId: TEST_AUTHORITY.keyId,
        algorithm: "Ed25519",
      }).ok,
    ).toBe(false);

    const signed = signRemoteRuntimeManifest(
      unsignedManifest(),
      TEST_PRIVATE_KEY_PEM,
      TEST_AUTHORITY,
    );
    const redirected = structuredClone(signed);
    redirected.assets[0].archiveUrl = "https://evil.example/runtime.tar.gz";
    expect(verifyRemoteRuntimeManifest(redirected, TEST_AUTHORITY).ok).toBe(false);
    expect(verifyRemoteRuntimeManifest({ ...signed, protocolMajor: 4 }, TEST_AUTHORITY).ok).toBe(
      false,
    );
  });

  // The Swift verifier signs a hard-coded seven-field asset projection; the
  // JS side signs the same explicit projection and REFUSES unknown asset
  // fields, so a new field can never be signed here and dropped there.
  it("refuses an asset with an unknown field instead of silently signing it", () => {
    const widenedInput = unsignedManifest();
    (widenedInput.assets[0] as unknown as Record<string, unknown>).mirrorUrl =
      "https://evil.example/alt.tar.gz";
    expect(() =>
      signRemoteRuntimeManifest(widenedInput, TEST_PRIVATE_KEY_PEM, TEST_AUTHORITY),
    ).toThrow(/unknown field/);

    const signed = signRemoteRuntimeManifest(
      unsignedManifest(),
      TEST_PRIVATE_KEY_PEM,
      TEST_AUTHORITY,
    );
    const widened = structuredClone(signed);
    (widened.assets[0] as unknown as Record<string, unknown>).mirrorUrl =
      "https://evil.example/alt.tar.gz";
    const verdict = verifyRemoteRuntimeManifest(widened, TEST_AUTHORITY);
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join("; ")).toMatch(/unknown field/);
  });

  it("canonicalizes caller-provided asset order before signing", () => {
    const input = unsignedManifest();
    input.assets.reverse();
    const signed = signRemoteRuntimeManifest(input, TEST_PRIVATE_KEY_PEM, TEST_AUTHORITY);
    expect(signed.assets.map((asset: { target: string }) => asset.target)).toEqual(
      REMOTE_RUNTIME_TARGETS,
    );
  });

  // Byte-for-byte lock against the Swift mirror (RemoteRuntime.signingBytes).
  // The shared fixture scrambles key order and stresses raw multibyte UTF-8, a
  // char present both raw and \u-escaped, every shorthand escape,
  // U+0000/U+0007/U+001F, raw DEL, and raw U+2028/U+2029. The recorded .bin
  // vector is asserted by BOTH this test and the ClaudexorKit test
  // canonicalSigningBytesMatchTheRecordedCrossLanguageVector, so either
  // canonicalizer drifting breaks its suite.
  it("produces the recorded cross-language canonical signing bytes", () => {
    const vectorDir = resolve(
      import.meta.dirname,
      "../../../apps/macos/ClaudexorKit/Tests/ClaudexorKitTests/Fixtures/remote-runtime-update",
    );
    const manifest = JSON.parse(
      readFileSync(resolve(vectorDir, "canonical-signing-manifest.json"), "utf8"),
    );
    const expected = readFileSync(resolve(vectorDir, "canonical-signing-bytes.bin"));
    const produced = remoteRuntimeManifestSigningBytes(manifest);
    expect(produced.toString("utf8")).toBe(expected.toString("utf8"));
    expect(produced.equals(expected)).toBe(true);
  });
});

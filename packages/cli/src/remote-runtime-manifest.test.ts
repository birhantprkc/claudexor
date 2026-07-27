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

  it("canonicalizes caller-provided asset order before signing", () => {
    const input = unsignedManifest();
    input.assets.reverse();
    const signed = signRemoteRuntimeManifest(input, TEST_PRIVATE_KEY_PEM, TEST_AUTHORITY);
    expect(signed.assets.map((asset: { target: string }) => asset.target)).toEqual(
      REMOTE_RUNTIME_TARGETS,
    );
  });
});

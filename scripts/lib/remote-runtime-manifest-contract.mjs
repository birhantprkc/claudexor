/**
 * Signed manifest for the self-contained SSH runtime.
 *
 * This is deliberately a separate wire contract from runtime-manifest.json:
 * the local app updater installs a Darwin-only closure and reuses app-owned
 * Node, while this manifest describes four complete, remotely installable
 * runtimes that include Node. The signed `kind` field prevents a signature
 * created for one protocol from being replayed in the other.
 */
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import {
  RUNTIME_MANIFEST_ALGORITHM,
  RUNTIME_MANIFEST_SCHEMA_VERSION,
  RUNTIME_RELEASE_REPO,
  canonicalJson,
  isSemver,
} from "./runtime-manifest-contract.mjs";

export const REMOTE_RUNTIME_MANIFEST_KIND = "claudexor-remote-runtime";
export const REMOTE_RUNTIME_PROTOCOL_MAJOR = 3;
export const REMOTE_RUNTIME_TARGETS = Object.freeze([
  "linux-x64",
  "linux-arm64",
  "darwin-x64",
  "darwin-arm64",
]);

const SHA256_HEX = /^[0-9a-f]{64}$/;
const GIT_SHA_HEX = /^[0-9a-f]{40}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function remoteRuntimeArchiveName(version, target) {
  return `claudexor-remote-runtime-${version}-${target}.tar.gz`;
}

export function remoteRuntimeArchiveUrl(version, target) {
  return `https://github.com/${RUNTIME_RELEASE_REPO}/releases/download/v${version}/${remoteRuntimeArchiveName(version, target)}`;
}

function targetParts(target) {
  const [platform, arch] = String(target).split("-");
  return { platform, arch };
}

export function remoteRuntimeManifestSignedFields(manifest) {
  return {
    schemaVersion: manifest.schemaVersion,
    kind: manifest.kind,
    version: manifest.version,
    buildSha: manifest.buildSha,
    protocolMajor: manifest.protocolMajor,
    minAppVersion: manifest.minAppVersion,
    notes: manifest.notes,
    assets: manifest.assets,
    keyId: manifest.keyId,
    algorithm: manifest.algorithm,
  };
}

export function remoteRuntimeManifestSigningBytes(manifest) {
  return Buffer.from(canonicalJson(remoteRuntimeManifestSignedFields(manifest)), "utf8");
}

export function validateRemoteRuntimeManifestShape(manifest, { expectVersion } = {}) {
  const reasons = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { ok: false, reasons: ["manifest is not an object"] };
  }
  if (manifest.schemaVersion !== RUNTIME_MANIFEST_SCHEMA_VERSION) {
    reasons.push(`schemaVersion must be ${RUNTIME_MANIFEST_SCHEMA_VERSION}`);
  }
  if (manifest.kind !== REMOTE_RUNTIME_MANIFEST_KIND) {
    reasons.push(`kind must be ${REMOTE_RUNTIME_MANIFEST_KIND}`);
  }
  if (!isSemver(manifest.version)) reasons.push("version must be an x.y.z semver");
  if (typeof manifest.buildSha !== "string" || !GIT_SHA_HEX.test(manifest.buildSha)) {
    reasons.push("buildSha must be a 40-char lowercase hex git sha");
  }
  if (manifest.protocolMajor !== REMOTE_RUNTIME_PROTOCOL_MAJOR) {
    reasons.push(`protocolMajor must be ${REMOTE_RUNTIME_PROTOCOL_MAJOR}`);
  }
  if (!isSemver(manifest.minAppVersion)) reasons.push("minAppVersion must be an x.y.z semver");
  if (typeof manifest.notes !== "string") reasons.push("notes must be a string");
  if (typeof manifest.keyId !== "string" || manifest.keyId.length === 0) {
    reasons.push("keyId must be a non-empty string");
  }
  if (manifest.algorithm !== RUNTIME_MANIFEST_ALGORITHM) {
    reasons.push(`algorithm must be ${RUNTIME_MANIFEST_ALGORITHM}`);
  }

  if (!Array.isArray(manifest.assets)) {
    reasons.push("assets must be an array");
  } else {
    const seen = new Set();
    for (const asset of manifest.assets) {
      if (!asset || typeof asset !== "object" || Array.isArray(asset)) {
        reasons.push("every asset must be an object");
        continue;
      }
      const target = asset.target;
      if (!REMOTE_RUNTIME_TARGETS.includes(target)) {
        reasons.push(`unsupported asset target ${String(target)}`);
        continue;
      }
      if (seen.has(target)) reasons.push(`duplicate asset target ${target}`);
      seen.add(target);
      const parts = targetParts(target);
      if (asset.platform !== parts.platform) {
        reasons.push(`${target} platform must be ${parts.platform}`);
      }
      if (asset.arch !== parts.arch) reasons.push(`${target} arch must be ${parts.arch}`);
      if (!isSemver(asset.nodeVersion)) reasons.push(`${target} nodeVersion must be semver`);
      if (typeof asset.sha256 !== "string" || !SHA256_HEX.test(asset.sha256)) {
        reasons.push(`${target} sha256 must be 64 lowercase hex chars`);
      }
      if (isSemver(manifest.version)) {
        const name = remoteRuntimeArchiveName(manifest.version, target);
        const url = remoteRuntimeArchiveUrl(manifest.version, target);
        if (asset.archiveName !== name) reasons.push(`${target} archiveName must be ${name}`);
        if (asset.archiveUrl !== url) reasons.push(`${target} archiveUrl must be ${url}`);
      }
    }
    for (const target of REMOTE_RUNTIME_TARGETS) {
      if (!seen.has(target)) reasons.push(`missing asset target ${target}`);
    }
    if (
      manifest.assets.length === REMOTE_RUNTIME_TARGETS.length &&
      manifest.assets.some((asset, index) => asset.target !== REMOTE_RUNTIME_TARGETS[index])
    ) {
      reasons.push(`assets must be ordered: ${REMOTE_RUNTIME_TARGETS.join(", ")}`);
    }
  }
  if (expectVersion !== undefined && manifest.version !== expectVersion) {
    reasons.push(`version ${manifest.version} does not match the expected ${expectVersion}`);
  }
  return { ok: reasons.length === 0, reasons };
}

export function verifyRemoteRuntimeManifest(manifest, authority, opts = {}) {
  const shape = validateRemoteRuntimeManifestShape(manifest, opts);
  const reasons = [...shape.reasons];
  if (!authority || typeof authority !== "object") {
    reasons.push("runtime-update authority is missing");
  } else {
    if (authority.algorithm !== RUNTIME_MANIFEST_ALGORITHM) {
      reasons.push(`authority algorithm must be ${RUNTIME_MANIFEST_ALGORITHM}`);
    }
    if (manifest?.keyId !== authority.keyId) {
      reasons.push("manifest keyId is not the pinned runtime-update authority");
    }
  }
  if (typeof manifest?.signature !== "string" || !BASE64.test(manifest.signature)) {
    reasons.push("signature is missing or not base64");
  }
  if (reasons.length > 0) return { ok: false, reasons };
  try {
    const key = createPublicKey(authority.publicKeyPem);
    const signature = Buffer.from(manifest.signature, "base64");
    if (
      key.asymmetricKeyType !== "ed25519" ||
      signature.length !== 64 ||
      !verify(null, remoteRuntimeManifestSigningBytes(manifest), key, signature)
    ) {
      return { ok: false, reasons: ["signature is invalid for the pinned key"] };
    }
  } catch {
    return { ok: false, reasons: ["signature verification failed"] };
  }
  return { ok: true, reasons: [] };
}

export function signRemoteRuntimeManifest(unsigned, privateKeyPem, authority) {
  const assets = Array.isArray(unsigned.assets)
    ? [...unsigned.assets].sort(
        (a, b) =>
          REMOTE_RUNTIME_TARGETS.indexOf(a.target) - REMOTE_RUNTIME_TARGETS.indexOf(b.target),
      )
    : unsigned.assets;
  const withKey = {
    schemaVersion: RUNTIME_MANIFEST_SCHEMA_VERSION,
    kind: REMOTE_RUNTIME_MANIFEST_KIND,
    version: unsigned.version,
    buildSha: unsigned.buildSha,
    protocolMajor: unsigned.protocolMajor ?? REMOTE_RUNTIME_PROTOCOL_MAJOR,
    minAppVersion: unsigned.minAppVersion,
    notes: typeof unsigned.notes === "string" ? unsigned.notes : "",
    assets,
    keyId: authority.keyId,
    algorithm: RUNTIME_MANIFEST_ALGORITHM,
  };
  const shape = validateRemoteRuntimeManifestShape(withKey);
  if (!shape.ok) {
    throw new Error(`refusing to sign a malformed remote manifest: ${shape.reasons.join("; ")}`);
  }
  const key = createPrivateKey(privateKeyPem);
  const signature = sign(null, remoteRuntimeManifestSigningBytes(withKey), key).toString("base64");
  const signed = { ...withKey, signature };
  const verified = verifyRemoteRuntimeManifest(signed, authority);
  if (!verified.ok) {
    throw new Error(
      `sealed remote manifest fails its own verifier: ${verified.reasons.join("; ")}`,
    );
  }
  return signed;
}

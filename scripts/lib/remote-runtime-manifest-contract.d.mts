export interface RemoteRuntimeAsset {
  target: "linux-x64" | "linux-arm64" | "darwin-x64" | "darwin-arm64";
  platform: "linux" | "darwin";
  arch: "x64" | "arm64";
  nodeVersion: string;
  archiveName: string;
  archiveUrl: string;
  sha256: string;
}

export interface RemoteRuntimeManifest {
  schemaVersion: 1;
  kind: "claudexor-remote-runtime";
  version: string;
  buildSha: string;
  protocolMajor: 3;
  minAppVersion: string;
  notes: string;
  assets: RemoteRuntimeAsset[];
  keyId: string;
  algorithm: "Ed25519";
  signature: string;
}

export interface RuntimeUpdateAuthority {
  schemaVersion?: number;
  keyId: string;
  algorithm: string;
  publicKeyPem: string;
}

export const REMOTE_RUNTIME_MANIFEST_KIND: "claudexor-remote-runtime";
export const REMOTE_RUNTIME_PROTOCOL_MAJOR: 3;
export const REMOTE_RUNTIME_TARGETS: readonly RemoteRuntimeAsset["target"][];
export function remoteRuntimeArchiveName(version: string, target: string): string;
export function remoteRuntimeArchiveUrl(version: string, target: string): string;
export function remoteRuntimeManifestSignedFields(
  manifest: RemoteRuntimeManifest,
): Omit<RemoteRuntimeManifest, "signature">;
export function remoteRuntimeManifestSigningBytes(manifest: RemoteRuntimeManifest): Buffer;
export function validateRemoteRuntimeManifestShape(
  manifest: unknown,
  opts?: { expectVersion?: string },
): { ok: boolean; reasons: string[] };
export function verifyRemoteRuntimeManifest(
  manifest: unknown,
  authority: RuntimeUpdateAuthority,
  opts?: { expectVersion?: string },
): { ok: boolean; reasons: string[] };
export function signRemoteRuntimeManifest(
  unsigned: Omit<
    RemoteRuntimeManifest,
    "schemaVersion" | "kind" | "keyId" | "algorithm" | "signature"
  > & { schemaVersion?: 1; kind?: "claudexor-remote-runtime" },
  privateKeyPem: string,
  authority: RuntimeUpdateAuthority,
): RemoteRuntimeManifest;

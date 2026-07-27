#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  REMOTE_RUNTIME_PROTOCOL_MAJOR,
  REMOTE_RUNTIME_TARGETS,
  validateRemoteRuntimeManifestShape,
} from "./lib/remote-runtime-manifest-contract.mjs";

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

try {
  const version = option("version");
  const buildSha = option("build-sha");
  const minAppVersion = option("min-app-version");
  const assetsDir = option("assets-dir");
  const out = option("out");
  if (!version || !buildSha || !minAppVersion || !assetsDir || !out) {
    throw new Error(
      "usage: build-remote-runtime-manifest.mjs --version X --build-sha SHA --min-app-version X --assets-dir DIR --out FILE",
    );
  }
  const assets = REMOTE_RUNTIME_TARGETS.map((target) => {
    const file = resolve(assetsDir, `claudexor-remote-runtime-${version}-${target}.json`);
    if (!existsSync(file)) throw new Error(`missing asset metadata ${file}`);
    return JSON.parse(readFileSync(file, "utf8"));
  });
  const manifest = {
    schemaVersion: 1,
    kind: "claudexor-remote-runtime",
    version,
    buildSha,
    protocolMajor: REMOTE_RUNTIME_PROTOCOL_MAJOR,
    minAppVersion,
    notes: `Claudexor SSH runtime ${version}.`,
    assets,
    keyId: "unsigned",
    algorithm: "Ed25519",
  };
  // Validate the complete asset set now. The offline signer replaces only
  // keyId and adds signature, so build mistakes cannot reach the owner.
  const shape = validateRemoteRuntimeManifestShape(manifest, { expectVersion: version });
  const buildReasons = shape.reasons.filter(
    (reason) => reason !== "keyId must be a non-empty string",
  );
  if (buildReasons.length > 0) throw new Error(buildReasons.join("; "));
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(resolve(out), `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o644,
    flag: "wx",
  });
} catch (error) {
  process.stderr.write(`build-remote-runtime-manifest failed: ${String(error)}\n`);
  process.exit(1);
}

#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  REMOTE_RUNTIME_TARGETS,
  verifyRemoteRuntimeManifest,
} from "./lib/remote-runtime-manifest-contract.mjs";

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

try {
  const signedPath = option("signed");
  const unsignedPath = option("unsigned");
  const assetsDir = option("assets-dir");
  const version = option("version");
  const expectedBuildSha = option("expected-build-sha");
  if (!signedPath || !unsignedPath || !assetsDir || !version || !expectedBuildSha) {
    throw new Error(
      "usage: verify-signed-remote-runtime-manifest.mjs --signed FILE --unsigned FILE --assets-dir DIR --version X --expected-build-sha SHA",
    );
  }
  const authority = JSON.parse(
    readFileSync(new URL("../release/runtime-update-authority.json", import.meta.url), "utf8"),
  );
  const signed = JSON.parse(readFileSync(resolve(signedPath), "utf8"));
  const unsigned = JSON.parse(readFileSync(resolve(unsignedPath), "utf8"));
  const verified = verifyRemoteRuntimeManifest(signed, authority);
  if (!verified.ok) throw new Error(verified.reasons.join("; "));
  if (signed.version !== version || signed.buildSha !== expectedBuildSha) {
    throw new Error("signed manifest release identity mismatch");
  }
  for (const field of [
    "schemaVersion",
    "kind",
    "version",
    "buildSha",
    "protocolMajor",
    "minAppVersion",
    "notes",
    "algorithm",
  ]) {
    if (JSON.stringify(signed[field]) !== JSON.stringify(unsigned[field])) {
      throw new Error(`signed manifest changed candidate field ${field}`);
    }
  }
  if (JSON.stringify(signed.assets) !== JSON.stringify(unsigned.assets)) {
    throw new Error("signed manifest changed candidate assets");
  }
  if (signed.assets.length !== REMOTE_RUNTIME_TARGETS.length) {
    throw new Error("signed manifest does not contain all remote targets");
  }
  for (const asset of signed.assets) {
    const archive = join(resolve(assetsDir), basename(asset.archiveName));
    if (sha256(archive) !== asset.sha256) {
      throw new Error(`archive digest mismatch for ${asset.target}`);
    }
  }
} catch (error) {
  process.stderr.write(`remote runtime manifest verification refused: ${String(error)}\n`);
  process.exit(1);
}

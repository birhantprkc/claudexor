#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  REMOTE_RUNTIME_TARGETS,
  remoteRuntimeArchiveName,
  signRemoteRuntimeManifest,
  verifyRemoteRuntimeManifest,
} from "./lib/remote-runtime-manifest-contract.mjs";

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

try {
  const input = option("in");
  const assetsDir = option("assets-dir");
  const privateKey = option("private-key");
  const authorityPath = option("authority");
  const out = option("out");
  if (!input || !assetsDir || !privateKey || !authorityPath || !out) {
    throw new Error(
      "usage: sign-remote-runtime-manifest.mjs --in FILE --assets-dir DIR --private-key FILE --authority FILE --out FILE",
    );
  }
  if (existsSync(out)) throw new Error("sealed output already exists");
  const unsigned = JSON.parse(readFileSync(resolve(input), "utf8"));
  const authority = JSON.parse(readFileSync(resolve(authorityPath), "utf8"));
  // The archives gate the ceremony: the OFFLINE private key is not read until
  // ALL FOUR exactly-named target archives sit in --assets-dir as nonempty
  // regular files (no symlinks) whose digests match the unsigned manifest, so a
  // signature can only ever bind archives the owner actually verified.
  const manifestAssets = new Map(
    (Array.isArray(unsigned.assets) ? unsigned.assets : []).map((asset) => [
      asset?.archiveName,
      asset,
    ]),
  );
  for (const target of REMOTE_RUNTIME_TARGETS) {
    const name = remoteRuntimeArchiveName(unsigned.version, target);
    const asset = manifestAssets.get(name);
    if (!asset || asset.target !== target) {
      throw new Error(`unsigned manifest is missing the ${target} asset ${name}`);
    }
    const archive = join(resolve(assetsDir), name);
    const stat = lstatSync(archive, { throwIfNoEntry: false });
    if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.size === 0) {
      throw new Error(`${name} must be a nonempty regular file in --assets-dir`);
    }
    const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
    if (digest !== asset.sha256) {
      throw new Error(`${name} digest ${digest} does not match the manifest sha256`);
    }
  }
  const signed = signRemoteRuntimeManifest(
    unsigned,
    readFileSync(resolve(privateKey), "utf8"),
    authority,
  );
  const verified = verifyRemoteRuntimeManifest(signed, authority);
  if (!verified.ok) throw new Error(verified.reasons.join("; "));
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(resolve(out), `${JSON.stringify(signed, null, 2)}\n`, {
    mode: 0o644,
    flag: "wx",
  });
} catch (error) {
  process.stderr.write(`remote runtime manifest signing refused: ${String(error)}\n`);
  process.exit(1);
}

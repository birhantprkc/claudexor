#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  signRemoteRuntimeManifest,
  verifyRemoteRuntimeManifest,
} from "./lib/remote-runtime-manifest-contract.mjs";

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

try {
  const input = option("in");
  const privateKey = option("private-key");
  const authorityPath = option("authority");
  const out = option("out");
  if (!input || !privateKey || !authorityPath || !out) {
    throw new Error(
      "usage: sign-remote-runtime-manifest.mjs --in FILE --private-key FILE --authority FILE --out FILE",
    );
  }
  if (existsSync(out)) throw new Error("sealed output already exists");
  const unsigned = JSON.parse(readFileSync(resolve(input), "utf8"));
  const authority = JSON.parse(readFileSync(resolve(authorityPath), "utf8"));
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

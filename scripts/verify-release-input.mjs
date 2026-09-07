#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { validateReleaseInput } from "./lib/release-review-contract.mjs";

const mode = process.env.RELEASE_MODE_INPUT ?? "";
const ref = process.env.RELEASE_REF_INPUT ?? "";
const input = validateReleaseInput(mode, ref);
if (!input.ok) fail(input.reasons);

// Retired publication waivers are not a second route into the current policy.
for (const name of ["SKIP_CUSTOM_ED25519_INPUT", "WAIVE_CURSOR_REVIEW_INPUT"]) {
  if (process.env[name] && process.env[name] !== "false") {
    fail([`${name} is retired; publish requires review confirmation and signed runtime manifests`]);
  }
}
if (process.env.REVIEW_ATTESTATION_B64_INPUT) {
  fail(["signed review attestations are historical evidence, not current publish input"]);
}
if (process.argv.includes("--syntax-only")) process.exit(0);

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
let candidateSha;
let tag = "";
if (mode === "candidate") {
  candidateSha = git("rev-parse", `${ref}^{commit}`);
  if (candidateSha !== ref)
    fail(["candidate ref did not resolve to the exact requested commit SHA"]);
  if (candidateSha !== (process.env.GITHUB_SHA ?? "")) {
    fail(["candidate SHA does not match the workflow-dispatch GITHUB_SHA"]);
  }
} else {
  tag = ref;
  if ((process.env.GITHUB_REF ?? "") !== `refs/tags/${tag}`) {
    fail(["publish workflow must be dispatched from the exact release tag ref"]);
  }
  if (git("cat-file", "-t", `refs/tags/${tag}`) !== "tag") {
    fail(["publish ref must be an annotated tag"]);
  }
  candidateSha = git("rev-parse", `${tag}^{commit}`);
  const main = git("rev-parse", "origin/main^{commit}");
  if (candidateSha !== main) fail(["publish tag does not point to the exact origin/main commit"]);
  if (candidateSha !== (process.env.GITHUB_SHA ?? "")) {
    fail(["publish SHA does not match the workflow-dispatch GITHUB_SHA"]);
  }
}

const candidateTree = git("rev-parse", `${candidateSha}^{tree}`);
const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const version = manifest.version;
if (mode === "publish" && tag !== `v${version}`)
  fail(["publish tag does not match package.json version"]);
if (mode === "publish") {
  // GitHub authenticates the workflow dispatcher. This records that person's
  // responsibility for reading the full independent report and its disposition;
  // it does not pretend to cryptographically prove review quality or identity.
  if (process.env.REVIEW_CONFIRMED_INPUT !== "true") {
    fail(["publish requires the responsible maintainer's review_confirmed confirmation"]);
  }
  const reviewUrl = process.env.REVIEW_URL_INPUT ?? "";
  let url;
  try {
    url = new URL(reviewUrl);
  } catch {
    fail(["publish requires a review_url"]);
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    fail(["review_url must be an HTTPS evidence reference without embedded credentials"]);
  }
  for (const name of ["RUNTIME_MANIFEST_B64_INPUT", "REMOTE_RUNTIME_MANIFEST_B64_INPUT"]) {
    if (
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        process.env[name] ?? "",
      ) ||
      !process.env[name]
    ) {
      fail([`publish requires base64-encoded ${name}`]);
    }
  }
}

if (process.env.GITHUB_OUTPUT) {
  writeFileSync(
    process.env.GITHUB_OUTPUT,
    [
      `mode=${mode}`,
      `sha=${candidateSha}`,
      `tree=${candidateTree}`,
      `tag=${tag}`,
      `version=${version}`,
      "",
    ].join("\n"),
    { flag: "a" },
  );
}
console.log(`release input OK: ${mode} ${candidateSha}`);

function fail(reasons) {
  for (const reason of reasons) console.error(`release input rejected: ${reason}`);
  process.exit(1);
}

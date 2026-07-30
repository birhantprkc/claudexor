#!/usr/bin/env node
/**
 * Run the full deterministic release gate (`pnpm release:verify`) and write
 * the hash-bound receipt the release attestation embeds: before/after git
 * identity (candidate must be clean and UNCHANGED by the gate), exit code,
 * and stdout/stderr digests. The receipt is the ONLY input the sealer trusts
 * about the gate — it never re-runs or re-interprets the gate itself.
 */
import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathIsWithin } from "./lib/release-review-contract.mjs";
import { buildReleaseReviewRuntimeArtifacts } from "./lib/release-review-runtime.mjs";

if (process.argv.length !== 3 || !process.argv[2]?.trim()) {
  console.error("usage: run-full-gate-receipt.mjs OUT_DIR");
  process.exit(2);
}
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const candidateRoot = realpathSync(git("rev-parse", "--show-toplevel"));
const outDir = canonicalFuturePath(process.argv[2]);
if (pathIsWithin(candidateRoot, outDir) || pathIsWithin(outDir, candidateRoot)) {
  console.error("full-gate receipt OUT_DIR must be external to the candidate repository");
  process.exit(1);
}
if (existsSync(join(outDir, "full-gate-receipt.json"))) {
  console.error("full-gate receipt already exists; gate evidence is never overwritten");
  process.exit(1);
}
mkdirSync(outDir, { recursive: true, mode: 0o700 });

const gitState = () => ({
  head: git("rev-parse", "HEAD"),
  tree: git("rev-parse", "HEAD^{tree}"),
  status: git("status", "--porcelain"),
});

const before = gitState();
if (before.status !== "") {
  console.error("candidate worktree is dirty; commit or stash before running the gate");
  process.exit(1);
}

const stdoutPath = join(outDir, "full-gate.stdout.log");
const stderrPath = join(outDir, "full-gate.stderr.log");
const program = "pnpm";
const argv = ["pnpm", "release:verify"];
console.log(`running ${argv.join(" ")} (receipt: ${outDir})`);
const run = spawnSync(argv[0], argv.slice(1), {
  encoding: "utf8",
  maxBuffer: 512 * 1024 * 1024,
});
writeFileSync(stdoutPath, run.stdout ?? "", { mode: 0o600 });
writeFileSync(stderrPath, run.stderr ?? "", { mode: 0o600 });
const gateExitCode = run.status ?? 1;
let reviewRuntimeArtifacts = [];
let reviewRuntimeArtifactError = null;
if (gateExitCode === 0) {
  try {
    reviewRuntimeArtifacts = await buildReleaseReviewRuntimeArtifacts(
      git("rev-parse", "--show-toplevel"),
      outDir,
      before.head,
    );
  } catch (error) {
    reviewRuntimeArtifactError = error instanceof Error ? error.message : String(error);
  }
}
const exitCode = gateExitCode === 0 && reviewRuntimeArtifactError === null ? 0 : gateExitCode || 1;

const after = gitState();
const sha256File = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const receipt = {
  program,
  argv,
  exitCode,
  gateExitCode,
  candidateUnchanged:
    before.head === after.head && before.tree === after.tree && after.status === "",
  before,
  after,
  stdout: { path: stdoutPath, sha256: sha256File(stdoutPath) },
  stderr: { path: stderrPath, sha256: sha256File(stderrPath) },
  reviewRuntimeArtifacts,
  reviewRuntimeArtifactError,
  finishedAt: new Date().toISOString(),
};
writeFileSync(join(outDir, "full-gate-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, {
  mode: 0o600,
});
console.log(
  `full gate exit ${exitCode}; candidateUnchanged=${receipt.candidateUnchanged}; receipt sealed`,
);
process.exit(exitCode === 0 && receipt.candidateUnchanged ? 0 : 1);

function canonicalFuturePath(path) {
  let ancestor = resolve(path);
  const suffix = [];
  while (!existsSync(ancestor)) {
    suffix.unshift(basename(ancestor));
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  return join(realpathSync(ancestor), ...suffix);
}

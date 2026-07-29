import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  RELEASE_REVIEW_RUNTIME_ARTIFACT_PATHS,
  pathIsWithin,
  validateReleaseReviewRuntimeArtifacts,
} from "./release-review-contract.mjs";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function readStableReviewFile(path, label) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile()) throw new Error(`${label} is not a regular file`);
    const bytes = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    for (const key of ["dev", "ino", "size", "mtimeNs", "ctimeNs"]) {
      if (before[key] !== after[key]) throw new Error(`${label} changed while it was read`);
    }
    if (bytes.length === 0 || BigInt(bytes.length) !== before.size) {
      throw new Error(`${label} has an invalid byte length`);
    }
    return bytes;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const REQUIRED_RUNTIME_EXPORTS = Object.freeze([
  "containsSecretLikeToken",
  "redactSecrets",
  "verifySealedEvidencePacket",
  "writeEvidencePacket",
]);

function assertExactCandidateInputs(root, inputs) {
  for (const input of Object.keys(inputs)) {
    const absolute = resolve(root, input);
    if (!pathIsWithin(root, absolute)) {
      throw new Error(`release review runtime input escapes candidate: ${input}`);
    }
    const repoPath = relative(root, absolute).split(sep).join("/");
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink() || !stat.isFile() || realpathSync(absolute) !== absolute) {
      throw new Error(`release review runtime input is not a regular tracked file: ${repoPath}`);
    }
    let committed;
    try {
      committed = execFileSync("git", ["-C", root, "show", `HEAD:${repoPath}`], {
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch {
      throw new Error(`release review runtime input is not tracked at HEAD: ${repoPath}`);
    }
    if (!readFileSync(absolute).equals(committed)) {
      throw new Error(`release review runtime input differs from HEAD: ${repoPath}`);
    }
  }
}

function smokeRuntimeApi(bytes) {
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(bytes).toString("base64")}`;
  const script = [
    `const runtime = await import(${JSON.stringify(moduleUrl)});`,
    `const expected = ${JSON.stringify(REQUIRED_RUNTIME_EXPORTS)};`,
    "const actual = Object.keys(runtime).sort();",
    "if (JSON.stringify(actual) !== JSON.stringify(expected) || expected.some((name) => typeof runtime[name] !== 'function')) process.exit(1);",
  ].join("\n");
  try {
    execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
      maxBuffer: 1024 * 1024,
      stdio: "pipe",
    });
  } catch {
    throw new Error("release review runtime bundle failed its exact API smoke");
  }
}

/** Build one transparent, self-contained runtime beside the external gate receipt. */
export async function buildReleaseReviewRuntimeBundle(repoRoot, artifactRoot) {
  const root = realpathSync(resolve(repoRoot));
  const outputRoot = realpathSync(resolve(artifactRoot));
  const entryPath = join(root, "scripts/lib/release-review-runtime-entry.ts");
  const outputPath = join(outputRoot, RELEASE_REVIEW_RUNTIME_ARTIFACT_PATHS[0]);
  if (existsSync(outputPath)) {
    throw new Error("release review runtime bundle already exists");
  }
  // Build tooling is intentionally outside the live verifier import graph.
  // Only the post-gate receipt builder loads esbuild; prepare/live/seal paths
  // execute this tracked helper plus the already-bound runtime bytes.
  const { build } = await import("esbuild");
  const result = await build({
    absWorkingDir: root,
    alias: {
      "@claudexor/core": join(root, "packages/core/src/diff.ts"),
      "@claudexor/util": join(root, "packages/util/src/index.ts"),
    },
    bundle: true,
    entryPoints: [entryPath],
    format: "esm",
    legalComments: "none",
    logLevel: "silent",
    metafile: true,
    outfile: outputPath,
    platform: "node",
    sourcemap: false,
    target: ["node20"],
    treeShaking: true,
    write: false,
  });
  assertExactCandidateInputs(root, result.metafile.inputs);
  const output = Object.values(result.metafile.outputs).find(
    (record) => resolve(root, record.entryPoint ?? "") === entryPath,
  );
  if (!output) throw new Error("release review runtime bundle has no entrypoint metadata");
  if (JSON.stringify([...output.exports].sort()) !== JSON.stringify(REQUIRED_RUNTIME_EXPORTS)) {
    throw new Error("release review runtime bundle has an unexpected export surface");
  }
  const forbiddenImports = output.imports.filter(
    (entry) => !entry.external || !entry.path.startsWith("node:"),
  );
  if (forbiddenImports.length > 0) {
    throw new Error(
      `release review runtime bundle is not self-contained: ${forbiddenImports
        .map((entry) => entry.path)
        .join(", ")}`,
    );
  }
  const outputFile = result.outputFiles?.find((file) => resolve(file.path) === outputPath);
  if (!outputFile || outputFile.contents.length === 0) {
    throw new Error("release review runtime bundle emitted no bytes");
  }
  smokeRuntimeApi(outputFile.contents);
  writeFileSync(outputPath, outputFile.contents, { flag: "wx", mode: 0o600 });
  return snapshotReleaseReviewRuntimeArtifacts(outputRoot);
}

/** Snapshot the exact receipt-adjacent bundle allowed to execute in release review. */
export function snapshotReleaseReviewRuntimeArtifacts(artifactRoot) {
  const root = realpathSync(resolve(artifactRoot));
  return RELEASE_REVIEW_RUNTIME_ARTIFACT_PATHS.map((path) => {
    const absolute = join(root, path);
    if (!pathIsWithin(root, absolute)) {
      throw new Error(`release review runtime artifact escapes receipt directory: ${path}`);
    }
    const bytes = readStableReviewFile(absolute, `release review runtime artifact ${path}`);
    return { path, bytes: bytes.length, sha256: sha256(bytes) };
  });
}

/** Resolve the receipt-adjacent artifact root without trusting receipt prose. */
export function releaseReviewRuntimeArtifactRoot(receiptPath) {
  return realpathSync(dirname(resolve(receiptPath)));
}

/** Re-read and byte-compare a receipt-bound runtime snapshot before any import. */
export function verifyReleaseReviewRuntimeArtifacts(artifactRoot, expected) {
  return readVerifiedReleaseReviewRuntimeArtifact(artifactRoot, expected).artifacts;
}

/** Verify once and return the exact bytes that callers execute via a data URL. */
export function readVerifiedReleaseReviewRuntimeArtifact(artifactRoot, expected) {
  const reasons = validateReleaseReviewRuntimeArtifacts(expected);
  if (reasons.length > 0) throw new Error(reasons.join("; "));
  const root = realpathSync(resolve(artifactRoot));
  const bound = expected[0];
  const absolute = join(root, bound.path);
  if (!pathIsWithin(root, absolute)) {
    throw new Error(`release review runtime artifact escapes receipt directory: ${bound.path}`);
  }
  const bytes = readStableReviewFile(absolute, `release review runtime artifact ${bound.path}`);
  const artifact = { path: bound.path, bytes: bytes.length, sha256: sha256(bytes) };
  if (artifact.bytes !== bound.bytes || artifact.sha256 !== bound.sha256) {
    throw new Error(`release review runtime artifact drifted after full gate: ${artifact.path}`);
  }
  return { artifacts: [artifact], bytes };
}

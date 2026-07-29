#!/usr/bin/env node
/**
 * Triad + Scope review devtool (multi-model release gate, via OpenRouter).
 *
 * Two independent review passes over one release diff:
 *   - triad: 3 reviewer models from distinct vendors, JSON-array findings
 *     contract with blocker-contract fields (INV-139), liveness floor + one
 *     same-SHA retry per slot, EVERY required slot must be live, NO
 *     output truncation;
 *   - scope: one large-context reviewer covering the 8 fixed scope items
 *     against a compact repository atlas.
 * The preamble/checklists are Claudexor's own (docs/CHECKLISTS.md +
 * CLAUDEXOR_BIBLE.md); Claudexor does not self-modify — this is an external
 * development gate for contributors, not runtime product behavior.
 *
 * Usage:
 *   OPENROUTER_API_KEY=... node scripts/triad-scope-review.mjs \
 *     --packet <dir>          # external sealed packet with FREEZE.json + MANIFEST.sha256
 *     --packet-manifest-digest <sha256> # expected identity of MANIFEST.sha256
 *     --candidate-sha <sha>   # exact full commit SHA checked out in cwd
 *     --candidate-tree <sha>  # exact full tree SHA checked out in cwd
 *     --full-gate-receipt <file> # exact PASS receipt outside the candidate
 *     --full-gate-receipt-sha256 <sha256> # expected receipt bytes
 *     --panel-lock <path>     # pre-created panel lock outside the candidate worktree
 *     --round <n>             # round number for the output dir
 *     --out <dir>             # output root outside candidate and sealed packet
 *     --pack-subset <file>    # optional packet-split sub-wave: path/prefix
 *                             # JSON selectors naming complete current text
 *     --diff-subset <file>    # matching JSON selectors naming exact diff entries
 *     --sub-wave <name>       # stable name shared by both reviewer roles
 * Run scripts/review-coverage-check.mjs over BOTH role prompts from every
 * sub-wave before sealing; it proves both unions are exact and exhaustive.
 *
 * The release panel and transport are immutable in source:
 *   triad: openai/gpt-5.6-sol, anthropic/claude-fable-5,
 *          google/gemini-3.5-flash
 *   scope: anthropic/claude-fable-5
 *   route: OpenRouter only
 * Prepare the immutable lock in a separate no-network invocation by adding
 * `--prepare-panel-lock`; a review invocation refuses a missing lock before it
 * creates its output directory or calls a reviewer.
 * Add `--prepare-prompts` to run every candidate/packet/context/privacy
 * preflight and persist the exact prompts plus a no-network receipt without
 * starting a reviewer. The later live invocation rebuilds the same bytes and
 * requires both prepared prompt digests via `--expected-triad-prompt-sha256`
 * and `--expected-scope-prompt-sha256` before it creates output or calls a
 * reviewer.
 * Environment overrides, substitutions, direct-provider routes, and
 * --skip-scope fail before evidence leaves the machine.
 *
 * Bounded transport settings:
 *   TRIAD_MAX_OUTPUT_TOKENS=60000
 *   TRIAD_MAX_PACK_BYTES=3000000
 *
 * Outputs (per round): raw per-model responses (NEVER truncated), parsed
 * findings JSON, and a markdown summary table. Exit code 1 when any required
 * slot (triad or scope) is not live after its one retry, a response is
 * malformed/truncated/implausibly fast, or any reviewer emits a critical FAIL.
 * Exit 0 means the exact panel returned complete live coverage with no
 * critical FAIL verdicts.
 */

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
// The gate-derived verifier/redactor runtime is loaded only after its external
// receipt and exact bytes are revalidated in main.
import { exactObservedModelMatch } from "./lib/openrouter-panel.mjs";
import {
  CANONICAL_REVIEW_RENAME_ARG,
  diffAuthoritativeRule,
  parseNameStatusEntriesZ,
  parseWholeFileList,
} from "./review-coverage-check.mjs";
import {
  REQUIRED_SCOPE_MODEL,
  REQUIRED_TRIAD_MODELS,
  RELEASE_REVIEW_LIMITS_AUTHORITY,
  SCOPE_ITEMS,
  TRIAD_ITEMS,
  buildTouchedFilePack,
  changedFileInventorySection,
  completionTermination,
  compactRepositoryAtlas,
  decodeReviewUtf8,
  parseChecklistJson,
  livenessFloorMs,
  reviewerLiveness,
  pathIsWithin,
  panelLockText,
  readableDiffSliceSection,
  reviewPromptContextPreflight,
  reviewSplitOptionContract,
  releaseReviewDecision,
  reviewDecisionLivenessFloors,
  validateChecklistResponse,
  validateFrozenReviewBinding,
  validateFullGateEvidence,
  validateNewReviewOutput,
  validatePanelLock,
} from "./lib/release-review-contract.mjs";
import {
  readStableReviewFile,
  readVerifiedReleaseReviewRuntimeArtifact,
  releaseReviewRuntimeArtifactRoot,
} from "./lib/release-review-runtime.mjs";

let containsSecretLikeToken;
let redactSecrets;
let verifySealedEvidencePacket;

function arg(name, fallback = null) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  const next = process.argv[idx + 1];
  return next && !next.startsWith("--") ? next : true;
}

function readPanelLock(path) {
  if (!existsSync(path)) return {};
  if (lstatSync(path).isSymbolicLink()) throw new Error("panel lock must not be a symlink");
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(
      /^\s*(triad|scope|candidate_sha|candidate_tree|packet_manifest_sha256)\s*:\s*(.+?)\s*$/,
    );
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const TRIAD_MODELS = [...REQUIRED_TRIAD_MODELS];
const SCOPE_MODEL = REQUIRED_SCOPE_MODEL;
const expectedTriad = TRIAD_MODELS.join(",");

for (const [name, actual, expected] of [
  ["TRIAD_MODELS", process.env.TRIAD_MODELS, expectedTriad],
  ["SCOPE_MODEL", process.env.SCOPE_MODEL, SCOPE_MODEL],
]) {
  if (actual !== undefined && actual.trim() !== expected) {
    console.error(
      `${name} cannot override the exact release panel: expected '${expected}', got '${actual}'.`,
    );
    process.exit(2);
  }
}
if (process.env.TRIAD_DIRECT_OPENAI === "1" || process.env.TRIAD_DIRECT_ANTHROPIC === "1") {
  console.error(
    "Direct-provider reviewer routes are forbidden: the release panel must use the exact OpenRouter route.",
  );
  process.exit(2);
}
if (arg("skip-scope") !== null) {
  console.error(
    "--skip-scope is diagnostic-only in older releases and cannot satisfy the v2 release gate.",
  );
  process.exit(2);
}
function positiveIntEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    console.error(`${name} must be a positive integer`);
    process.exit(2);
  }
  return value;
}

const MAX_OUTPUT_TOKENS = positiveIntEnv("TRIAD_MAX_OUTPUT_TOKENS", 60_000);
const REQUEST_TIMEOUT_MS = 900_000;
/**
 * Per-file cap inside the touched-file pack; the diff itself is never cut.
 * Env-tunable (like the pack budget) so a legitimately large tracked file
 * (e.g. a god-file the complexity ratchet already flags) can still be
 * supplied in FULL to reviewers in one wave rather than dropped to
 * diff-only — the A-8 coverage guarantee. Raising it never bypasses
 * coverage: buildTouchedFilePack still throws if the TOTAL pack budget
 * would force an omission.
 */
const MAX_FILE_BYTES = positiveIntEnv("TRIAD_MAX_FILE_BYTES", 200_000);
const MAX_PACK_BYTES = positiveIntEnv("TRIAD_MAX_PACK_BYTES", 3_000_000);

function git(args, opts = {}) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...opts });
}

function gitBytes(args) {
  return execFileSync("git", args, { maxBuffer: 256 * 1024 * 1024 });
}

function readDoc(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return `(${path} not found)`;
  }
}

function requiredArg(name) {
  const value = arg(name);
  if (typeof value !== "string" || !value.trim()) throw new Error(`--${name} is required`);
  return value;
}

function assertExternalPath(candidateRoot, path, label) {
  if (pathIsWithin(candidateRoot, path)) {
    throw new Error(`${label} must be outside the candidate worktree`);
  }
}

async function loadBoundReviewRuntime(candidateRoot, candidateSha, candidateTree) {
  const receiptPath = resolve(requiredArg("full-gate-receipt"));
  const expectedReceiptSha256 = requiredArg("full-gate-receipt-sha256");
  if (!/^[0-9a-f]{64}$/.test(expectedReceiptSha256)) {
    throw new Error("--full-gate-receipt-sha256 must be one lowercase SHA-256");
  }
  assertExternalPath(candidateRoot, receiptPath, "full-gate receipt");
  const receiptBytes = readStableReviewFile(receiptPath, "full-gate receipt");
  const receiptSha256 = createHash("sha256").update(receiptBytes).digest("hex");
  if (receiptSha256 !== expectedReceiptSha256) {
    throw new Error("full-gate receipt changed after review preparation");
  }
  let receipt;
  try {
    receipt = JSON.parse(receiptBytes.toString("utf8"));
  } catch {
    throw new Error("full-gate receipt is not valid JSON");
  }
  const fullGate = {
    receiptSha256,
    program: receipt.program,
    argv: receipt.argv,
    exitCode: receipt.exitCode,
    candidateUnchanged: receipt.candidateUnchanged,
    beforeSha: receipt.before?.head,
    beforeTree: receipt.before?.tree,
    afterSha: receipt.after?.head,
    afterTree: receipt.after?.tree,
    stdoutSha256: receipt.stdout?.sha256,
    stderrSha256: receipt.stderr?.sha256,
    reviewRuntimeArtifacts: receipt.reviewRuntimeArtifacts,
  };
  const gateReasons = validateFullGateEvidence(fullGate, { candidateSha, candidateTree });
  if (gateReasons.length > 0) {
    throw new Error(`full-gate receipt is not an exact candidate PASS: ${gateReasons.join("; ")}`);
  }
  const artifactRoot = releaseReviewRuntimeArtifactRoot(receiptPath);
  assertExternalPath(candidateRoot, artifactRoot, "release review runtime");
  const verifiedRuntime = readVerifiedReleaseReviewRuntimeArtifact(
    artifactRoot,
    receipt.reviewRuntimeArtifacts,
  );
  const runtime = await import(
    `data:text/javascript;base64,${verifiedRuntime.bytes.toString("base64")}`
  );
  verifySealedEvidencePacket = runtime.verifySealedEvidencePacket;
  containsSecretLikeToken = runtime.containsSecretLikeToken;
  redactSecrets = runtime.redactSecrets;
  if (
    typeof verifySealedEvidencePacket !== "function" ||
    typeof containsSecretLikeToken !== "function" ||
    typeof redactSecrets !== "function"
  ) {
    throw new Error("release-review runtime artifacts do not expose the required verifier API");
  }
  return { receiptPath, receiptSha256, artifacts: verifiedRuntime.artifacts };
}

function loadFrozenPacket(candidateRoot, candidateSha, candidateTree, packetManifestDigest) {
  const sealed = verifySealedEvidencePacket({
    evidenceDir: requiredArg("packet"),
    candidateSha,
    candidateTree,
    expectedManifestSha256: packetManifestDigest,
  });
  const packet = sealed.evidenceDir;
  assertExternalPath(candidateRoot, packet, "packet");
  const actualSha = git(["rev-parse", "HEAD"]).trim();
  const actualTree = git(["rev-parse", "HEAD^{tree}"]).trim();
  const dirty = git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]).length > 0;
  const binding = validateFrozenReviewBinding({
    candidateSha,
    candidateTree,
    actualSha,
    actualTree,
    dirty,
  });
  if (!binding.ok) throw new Error(`frozen candidate check failed: ${binding.reasons.join("; ")}`);
  const requestedBase = arg("base");
  if (requestedBase !== null && requestedBase !== sealed.baseSha) {
    throw new Error(`--base mismatch: packet has ${sealed.baseSha}, got ${String(requestedBase)}`);
  }
  const actualDiff = decodeReviewUtf8(
    gitBytes([
      "diff",
      CANONICAL_REVIEW_RENAME_ARG,
      "--binary",
      `${sealed.baseSha}..${candidateSha}`,
    ]),
    "canonical binary diff",
  );
  if (sealed.diff !== actualDiff) {
    throw new Error("sealed DIFF.patch does not match base..candidate");
  }

  const sections = sealed.files
    .filter((file) => file !== "DIFF.patch" && file !== "MANIFEST.sha256")
    .map((file) => `### ${file}\n\n${readFileSync(join(packet, file), "utf8")}`);
  // The reviewer must be able to VERIFY the binding it is told to check
  // (round-18 sol critical): show the complete MANIFEST.sha256 and the
  // expected digest inside the prompt instead of asserting them offstage.
  const bindingHeader =
    `Binding (machine-verified before this prompt was built): candidate ${candidateSha} ` +
    `(tree ${candidateTree}), base ${sealed.baseSha}. The packet's complete MANIFEST.sha256 ` +
    `is reproduced below; its own SHA-256 (the packet-manifest digest recorded in the panel ` +
    `lock and attestation) is ${sealed.manifestSha256}. Every packet file below hashed to its ` +
    `manifest entry, and DIFF.patch matched git diff base..candidate exactly.`;
  return {
    base: sealed.baseSha,
    diff: sealed.diff,
    manifestSha256: sealed.manifestSha256,
    packet,
    prompt:
      `## Sealed evidence packet\n\n${bindingHeader}\n\n` +
      `### MANIFEST.sha256\n\n${readFileSync(join(packet, "MANIFEST.sha256"), "utf8")}\n\n` +
      sections.join("\n\n"),
  };
}

// ---------------------------------------------------------------------------
// Prompt blocks (shared reviewer preamble + per-pass checklists)
// ---------------------------------------------------------------------------

const PREAMBLE =
  "You are a frozen-release reviewer for Claudexor, a local-first control plane for AI coding harnesses.\n" +
  "Its constitution is CLAUDEXOR_BIBLE.md. Its contributor handbook is docs/DEVELOPMENT.md.\n" +
  "Claudexor does NOT self-modify; you are reviewing a human/agent-authored change to the product.\n";

const CRITICAL_CALIBRATION = `## Critical severity threshold — READ BEFORE MARKING ANY FINDING CRITICAL

Before marking any finding CRITICAL you MUST:
1. Name the **exact file, symbol, function, test, or config path** in this repo
   that makes the problem live RIGHT NOW (not hypothetically in the future).
2. Confirm this artifact actually exists in the repo context you have been given.
3. If the concern depends on a hypothetical plugin, future integration, custom
   environment, fixture, or finalizer that does NOT appear in this repo's
   codebase — mark it **advisory**, not critical.
4. One root cause = one FAIL entry. Do NOT split one problem into multiple FAIL
   items that all require the same fix.
5. If a previous CRITICAL finding was concretely fixed and only a broader
   future-risk variant remains, mark that broader concern **advisory**.
6. Pre-existing gaps that exist entirely outside the touched area are advisory
   unless this diff directly depends on them or introduces a regression.
7. Narrative or descriptive mismatches are advisory unless they affect a real
   contract: release/version metadata, actual runtime behavior, safety guidance,
   or instructions a user/reviewer must rely on.

When in doubt: use "advisory". Reserve "critical" for clear, concrete,
repo-local, reachable defects.`;

const JSON_CONTRACT = `Return ONLY a JSON array. Each element:
{
  "item": "<checklist item name>",
  "verdict": "PASS" | "FAIL",
  "severity": "critical" | "advisory",
  "reason": "<for FAIL: file, line/symbol, what is wrong, how to fix>"
}

One row per DISTINCT problem: repeat the same "item" id for each additional
finding on that item — multiple rows per item are expected on a deep review,
and one PASS row suffices for an item with no findings.

Blocker contract (INV-139) — applies to every critical FAIL row:
- Add "invariant": "<the violated invariant id (e.g. INV-042) or the exact
  owner-accepted criterion>" — a blocking finding MUST cite what it violates.
- Add "reachable": true|false — whether the defect is reachable in the
  DEFAULT configuration (no exotic env, no hypothetical plugin). If it is
  not reachable by default, severity is capped at advisory.
- A critical FAIL without a citation, or one that re-litigates a recorded
  owner decision from the packet's decision registry, will be adjudicated to
  the declined ledger instead of fixed — cite or downgrade yourself first.
Both fields are optional on PASS and advisory rows.
EVERY row — PASS rows included — MUST carry all four keys "item", "verdict",
"severity", "reason"; use "severity": "advisory" on PASS rows. A single row
missing "severity" invalidates the ENTIRE response as a parse failure and
burns one of your two liveness attempts, so double-check the keys before
returning.
The array must parse with JSON.parse: use only standard JSON string escapes
inside "reason" (a backslash before a backtick is NOT valid JSON — write the
backtick bare), no trailing commas, no comments, no text outside the array.`;

const ANTI_PATTERN_LOCK = `If your first reading surfaces **exactly one FAIL** across all checklist
items, do a deliberate SECOND pass focused on a DIFFERENT concern class
before returning. Real diffs with exactly one issue are rarer than diffs
with several issues on different dimensions; single-FAIL outputs are the
most common pattern-lock failure mode of single-pass review. Update PASS
entries in-place if your second pass uncovers new FAILs — return only one
JSON array, not two.`;

const THOROUGHNESS = `- Do NOT stop after finding the first issue. Check EVERY item in the checklist.
- Report ALL problems you find. If there are 5 bugs, list all 5 — each as a separate entry.
- Do NOT summarize multiple distinct problems into one finding.
- For PASS: brief reason is fine. For FAIL: cite the specific file, line/symbol, what is wrong,
  and provide a CONCRETE fix suggestion so the developer knows exactly what to change.
- Do NOT call tools, search, browse, or request external context. Use only the
  prompt's sealed packet, file pack, diff, repository atlas, and documentation context.`;

// ---------------------------------------------------------------------------
// Context builders
// ---------------------------------------------------------------------------

/**
 * ONE enumeration shared with the coverage gate: `-z --name-status` parsed by
 * review-coverage-check's parseNameStatusZ, so a space/unicode/newline path is
 * never C-quoted into a `git show` miss (the quoted `--name-only` output made
 * buildTouchedFilePack falsely render such a file as deleted). Deleted paths
 * are excluded from the FULL-TEXT pack (no current text; the diff carries
 * them) but stay in the prompt's changed-file list, annotated.
 */
function changedFiles(base) {
  return changedDiffEntries(base)
    .map(({ path, deleted }) => ({ path, deleted }))
    .filter((entry) => !entry.deleted)
    .map((entry) => entry.path);
}

/**
 * The DERIVED slot verdict the release sealer consumes (never CLI prose):
 * blocked on any critical FAIL, warn on any advisory FAIL, pass when fully
 * clean — and only a responded slot can carry a non-error verdict at all.
 */
function slotVerdict(status, findings) {
  if (status !== "responded") return "error";
  if (findings.some((f) => f.verdict === "FAIL" && f.severity === "critical")) return "blocked";
  if (findings.some((f) => f.verdict === "FAIL")) return "warn";
  return "pass";
}

/** NUL-safe, status-complete changed-file inventory with JSON-escaped paths. */
function changedFilesListing(base) {
  return changedFileInventorySection(changedDiffEntries(base));
}

/**
 * Read a packet-split selector. JSON strings preserve spaces, tabs, Unicode,
 * quotes, and embedded newlines without path re-parsing or shell assumptions.
 */
function readPackSubset(path) {
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string" || !value)) {
    throw new Error(`subset ${path} must be a JSON array of non-empty path strings`);
  }
  return parsed;
}

function changedDiffEntries(base) {
  return parseNameStatusEntriesZ(
    gitBytes(["diff", CANONICAL_REVIEW_RENAME_ARG, "-z", "--name-status", `${base}..HEAD`]),
  );
}

function reviewDiffEntries(base, selectors) {
  const all = changedDiffEntries(base);
  if (!selectors) return all;
  const selected = all.filter((entry) => inPackSubset(entry.path, selectors));
  if (selected.length === 0) {
    throw new Error(`--diff-subset selected 0 of ${all.length} changed entries`);
  }
  return selected;
}

function buildReadableDiffSlice(base, entries) {
  return entries
    .map((entry) => {
      const paths = entry.oldPath ? [entry.oldPath, entry.path] : [entry.path];
      const patch = decodeReviewUtf8(
        gitBytes([
          "--literal-pathspecs",
          "diff",
          CANONICAL_REVIEW_RENAME_ARG,
          "--binary",
          `${base}..HEAD`,
          "--",
          ...paths,
        ]),
        `readable diff slice for ${JSON.stringify(entry.path)}`,
      );
      if (!patch) throw new Error(`diff slice entry ${entry.path} produced zero bytes`);
      return patch;
    })
    .join("");
}

function inPackSubset(file, selectors) {
  return selectors.some((sel) => (sel.endsWith("/") ? file.startsWith(sel) : file === sel));
}

/**
 * Files whose FULL current text goes into the review pack: the union of the
 * base..HEAD changed files and the sealed packet's FILES_TO_READ_WHOLE.txt.
 * The list can name files changed BEFORE the review base (e.g. docs commits
 * folded into the base and text-reviewed via a sidecar diff) — without the
 * union those never reach reviewers in full (v3.0.1 wave r6 critical).
 *
 * When `subsetSelectors` is supplied (a packet-split sub-wave), the union is
 * filtered to the named area so buildTouchedFilePack supplies FULL text within
 * budget; the sibling sub-waves cover the rest and the coverage checker proves
 * the union is exhaustive.
 */
function reviewPackFiles(base, packetDir, subsetSelectors = null) {
  const changed = changedFiles(base);
  let listed = [];
  try {
    listed = parseWholeFileList(readFileSync(join(packetDir, "FILES_TO_READ_WHOLE.txt"), "utf8"));
  } catch {
    if (existsSync(join(packetDir, "FILES_TO_READ_WHOLE.txt")))
      throw new Error("FILES_TO_READ_WHOLE.txt must be a JSON array of exact path strings");
    // Optional packet file; absence means the changed set alone is the pack.
  }
  // Diff-authoritative files (generated bulk, binary media) never enter the
  // full-text pack — ONE classification owner shared with the coverage gate,
  // which exempts exactly the same set.
  const union = [...new Set([...changed, ...listed])].filter(
    (file) => diffAuthoritativeRule(file) === null,
  );
  if (!subsetSelectors) return union;
  const selected = union.filter((file) => inPackSubset(file, subsetSelectors));
  if (selected.length === 0) {
    throw new Error(`--pack-subset selected 0 of ${union.length} full-current-text files`);
  }
  return selected;
}

/** Compact whole-repo atlas: every tracked path + byte size (scope reviewer's map). */
function repoAtlas() {
  const paths = decodeReviewUtf8(gitBytes(["ls-files", "-z"]), "tracked-path inventory")
    .split("\0")
    .filter((path) => path !== "");
  const rows = paths.map((path) => {
    try {
      return { path, bytes: readFileSync(path).length };
    } catch {
      return { path, bytes: null, error: "unreadable" };
    }
  });
  return compactRepositoryAtlas(rows);
}

function checklistSection(title) {
  const text = readDoc("docs/CHECKLISTS.md");
  const re = new RegExp(`## ${title}[\\s\\S]*?(?=\\n## |$)`);
  const m = text.match(re);
  return m ? m[0] : `(section "${title}" not found in docs/CHECKLISTS.md)`;
}

function subsetNote(fullTextSelectors, diffSelectors) {
  if (!fullTextSelectors && !diffSelectors) return "";
  return (
    `\n\nPACKET-SPLIT SUB-WAVE: this wave carries the exact readable diff slice ` +
    `selected by [${(diffSelectors ?? []).join(", ")}] and the complete current ` +
    `text selected by [${(fullTextSelectors ?? []).join(", ")}]. The full changed-file ` +
    `list remains below. A deterministic pre-seal checker reconstructs the sealed ` +
    `DIFF.patch byte-for-byte from every role's slice union and independently proves ` +
    `that every hand-written current file appears whole exactly once.`
  );
}

function buildTriadPrompt(base, packetPrompt, diff, packFiles, fullTextSelectors, diffSelectors) {
  return `${PREAMBLE}
## Review instructions

Read this sub-wave's exact diff slice and full current-text subset. Review every
checklist item, report every distinct current problem, and make every FAIL
actionable with file/symbol evidence and a concrete fix.${subsetNote(fullTextSelectors, diffSelectors)}

${THOROUGHNESS}

${CRITICAL_CALIBRATION}

${JSON_CONTRACT}

The three checklist item identifiers you MUST cover are exactly:
${TRIAD_ITEMS.map((item, index) => `    ${index + 1}. ${item}`).join("\n")}
Return at least one row for every identifier, and repeat an identifier once
per distinct finding — do NOT merge distinct problems into one row. An empty
array, an unknown identifier, or a missing identifier makes your reviewer
slot unusable.

## Anti pattern-lock guard

${ANTI_PATTERN_LOCK}

${checklistSection("Review Protocol")}

${checklistSection("Runtime Behavior Changes")}

${checklistSection("Security And Secrets")}

- Output ONLY a valid JSON array. No markdown fences, no text outside the JSON.

${packetPrompt}

## CLAUDEXOR_BIBLE.md

${readDoc("CLAUDEXOR_BIBLE.md")}

## DEVELOPMENT.md

${readDoc("docs/DEVELOPMENT.md")}

## ARCHITECTURE.md

${readDoc("docs/ARCHITECTURE.md")}

## Current touched files (full content)

${buildTouchedFilePack(packFiles, gitBytes, MAX_FILE_BYTES, MAX_PACK_BYTES, { onOmission: "throw" })}

## Exact readable diff slice

${readableDiffSliceSection(diff)}

## Changed files

${changedFilesListing(base)}
`;
}

function buildScopePrompt(base, packetPrompt, diff, packFiles, fullTextSelectors, diffSelectors) {
  return `${PREAMBLE}
## Your role

You are the Atlas-backed whole-repository reviewer. Diff reviewers cover line-level mistakes;
you cover cross-module contracts, forgotten touchpoints, hidden regressions,
prompt/doc sync, architecture fit, and end-to-end intent completeness.

## Your task

For each finding, you MUST name the exact file, symbol, test, prompt, doc,
config, or sibling flow that proves the issue. Vague concerns without a
concrete artifact reference must be marked advisory, not critical.

## Output format

Output ONLY a valid JSON array.

You MUST cover every checklist item below. Skipping an item is not allowed —
a missing entry indicates the item was not actually reviewed.

The eight checklist item identifiers you MUST return (exactly these strings
in the "item" field; no substitutions):

${SCOPE_ITEMS.map((s, i) => `    ${i + 1}. ${s}`).join("\n")}

Each element must follow the shared review JSON contract:
${JSON_CONTRACT}

Additional scope-review requirements:
- "item" must be one of the eight identifiers above — verbatim, case-sensitive.
- "reason":
  - For FAIL: concrete artifact (file/symbol/line/contract) + what is wrong + how to fix.
  - For PASS: 1-2 sentences stating WHY this item passes, naming a concrete
    artifact or code path that you checked.

If one checklist item has multiple distinct concrete problems, return one
FAIL entry per distinct root cause. If an item has no problems, return one
PASS entry. Do not return PASS for an item that also has a FAIL.

## Anti pattern-lock guard

${ANTI_PATTERN_LOCK}

${CRITICAL_CALIBRATION}

${packetPrompt}

## Canonical documentation context

${readDoc("CLAUDEXOR_BIBLE.md")}

${readDoc("docs/ARCHITECTURE.md")}

## Repository atlas (every tracked path)

Format: one row per tracked path as <byte-size-or-?> TAB <JSON-encoded-path>.

${repoAtlas()}

## Current touched files (post-change)
${subsetNote(fullTextSelectors, diffSelectors)}

${buildTouchedFilePack(packFiles, gitBytes, MAX_FILE_BYTES, MAX_PACK_BYTES, { onOmission: "throw" })}

## Exact readable diff slice

${readableDiffSliceSection(diff)}

## Changed files

${changedFilesListing(base)}
`;
}

// ---------------------------------------------------------------------------
// OpenRouter + parsing (ported from triad_review.extract_json_array)
// ---------------------------------------------------------------------------

async function callModel(model, prompt) {
  return callOpenRouter(model, prompt);
}

function isAbortError(err) {
  return (
    typeof err === "object" &&
    err !== null &&
    (err.name === "AbortError" || String(err).includes("AbortError"))
  );
}

async function callOpenRouter(model, prompt) {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const route = {
    transport: "openrouter",
    source: "openrouter",
    routeProof: "openrouter:/api/v1/chat/completions",
  };
  try {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return {
        model,
        ...route,
        status: "error",
        raw: "",
        error: "OPENROUTER_API_KEY is required for OpenRouter-routed reviewer",
        ms: Date.now() - started,
        startedAt,
        firstEventAt: null,
        completedAt: new Date().toISOString(),
      };
    }
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        tools: [],
        tool_choice: "none",
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const firstEventAt = new Date().toISOString();
    const bodyText = await res.text();
    if (!res.ok) {
      return {
        model,
        ...route,
        status: "error",
        raw: bodyText,
        error: `HTTP ${res.status}`,
        ms: Date.now() - started,
        startedAt,
        firstEventAt,
        completedAt: new Date().toISOString(),
      };
    }
    const body = JSON.parse(bodyText);
    const raw = body.choices?.[0]?.message?.content ?? "";
    const finishReason = body.choices?.[0]?.finish_reason ?? null;
    const usage = body.usage ?? {};
    const observedModel = typeof body.model === "string" ? body.model : null;
    if (!exactObservedModelMatch(model, observedModel)) {
      return {
        model,
        ...route,
        observedModel,
        responseId: body.id ?? null,
        status: "error",
        raw: bodyText,
        error: observedModel
          ? `OpenRouter model mismatch: requested '${model}', observed '${observedModel}'`
          : `OpenRouter response omitted the observed model for requested '${model}'`,
        ms: Date.now() - started,
        startedAt,
        firstEventAt,
        completedAt: new Date().toISOString(),
      };
    }
    const termination = completionTermination(finishReason);
    if (!termination.complete) {
      return {
        model,
        ...route,
        observedModel,
        responseId: body.id ?? null,
        finishReason,
        status: "error",
        raw: bodyText,
        error: termination.error,
        ms: Date.now() - started,
        startedAt,
        firstEventAt,
        completedAt: new Date().toISOString(),
      };
    }
    if (!raw.trim())
      return {
        model,
        ...route,
        observedModel,
        responseId: body.id ?? null,
        status: "error",
        raw: bodyText,
        error: "empty completion",
        ms: Date.now() - started,
        startedAt,
        firstEventAt,
        completedAt: new Date().toISOString(),
      };
    return {
      model,
      ...route,
      observedModel,
      responseId: body.id ?? null,
      finishReason,
      status: "responded",
      raw,
      usage,
      ms: Date.now() - started,
      startedAt,
      firstEventAt,
      completedAt: new Date().toISOString(),
    };
  } catch (err) {
    const timedOut = isAbortError(err);
    return {
      model,
      ...route,
      status: timedOut ? "timed_out" : "error",
      timedOut,
      raw: "",
      error: String(err),
      ms: Date.now() - started,
      startedAt,
      firstEventAt: null,
      completedAt: new Date().toISOString(),
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (arg("paths") !== null || arg("goal-file") !== null) {
    throw new Error("--paths and --goal-file are not allowed for a sealed cumulative review");
  }
  const preparePanelLock = arg("prepare-panel-lock") !== null;
  const preparePrompts = arg("prepare-prompts") !== null;
  if (preparePanelLock && preparePrompts) {
    throw new Error("--prepare-panel-lock and --prepare-prompts are separate no-network phases");
  }
  const candidateSha = requiredArg("candidate-sha");
  const candidateTree = requiredArg("candidate-tree");
  const packetManifestDigest = requiredArg("packet-manifest-digest");
  if (!/^[0-9a-f]{40}$/.test(candidateSha) || !/^[0-9a-f]{40}$/.test(candidateTree)) {
    throw new Error("--candidate-sha and --candidate-tree must be full lowercase Git object ids");
  }
  const candidateRoot = realpathSync(git(["rev-parse", "--show-toplevel"]).trim());
  const reviewRuntime = await loadBoundReviewRuntime(candidateRoot, candidateSha, candidateTree);
  const frozen = loadFrozenPacket(candidateRoot, candidateSha, candidateTree, packetManifestDigest);
  const base = frozen.base;
  const panelLockPath = resolve(requiredArg("panel-lock"));
  assertExternalPath(candidateRoot, panelLockPath, "panel lock");
  if (pathIsWithin(frozen.packet, panelLockPath)) {
    throw new Error("panel lock must not mutate the sealed packet");
  }
  if (preparePanelLock) {
    if (existsSync(panelLockPath)) {
      const existing = validatePanelLock(readPanelLock(panelLockPath), {
        candidateSha,
        candidateTree,
        packetManifestSha256: frozen.manifestSha256,
      });
      if (!existing.ok) throw new Error(`invalid panel lock: ${existing.reasons.join("; ")}`);
      return;
    }
    mkdirSync(dirname(panelLockPath), { recursive: true });
    writeFileSync(
      panelLockPath,
      panelLockText({
        candidateSha,
        candidateTree,
        packetManifestSha256: frozen.manifestSha256,
      }),
      { flag: "wx", mode: 0o600 },
    );
    return;
  }
  const panelLock = validatePanelLock(
    existsSync(panelLockPath) ? readPanelLock(panelLockPath) : null,
    {
      candidateSha,
      candidateTree,
      packetManifestSha256: frozen.manifestSha256,
    },
  );
  if (!panelLock.ok) {
    throw new Error(`invalid panel lock: ${panelLock.reasons.join("; ")}`);
  }
  const round = String(arg("round", "1"));
  if (!/^[1-9]\d*$/.test(round)) throw new Error("--round must be a positive integer");
  const reviewWaveId = process.env.CLAUDEXOR_REVIEW_WAVE_ID ?? "";
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(reviewWaveId)
  ) {
    throw new Error("CLAUDEXOR_REVIEW_WAVE_ID must be a UUID shared with native reviewers");
  }
  const outDir = resolve(requiredArg("out"), `round-${round}`);
  const outputCheck = validateNewReviewOutput(
    candidateRoot,
    frozen.packet,
    outDir,
    existsSync(outDir),
  );
  if (!outputCheck.ok) {
    throw new Error(`invalid review output '${outDir}': ${outputCheck.reasons.join("; ")}`);
  }
  // Packet-split sub-wave (audit A-8): one selector names full-current-text
  // evidence, the other names exact diff entries. Both are required together;
  // their triad/scope prompt unions are recomputed before sealing.
  const packSubsetPath = arg("pack-subset");
  const diffSubsetPath = arg("diff-subset");
  const subWaveArg = arg("sub-wave");
  const splitOptions = reviewSplitOptionContract(packSubsetPath, diffSubsetPath, subWaveArg);
  if (!splitOptions.ok) throw new Error(splitOptions.reasons.join("; "));
  const { splitRequested } = splitOptions;
  let subsetSelectors = null;
  let diffSelectors = null;
  if (splitRequested) {
    subsetSelectors = readPackSubset(resolve(packSubsetPath));
    diffSelectors = readPackSubset(resolve(diffSubsetPath));
    if (subsetSelectors.length === 0) throw new Error("--pack-subset lists no path selectors");
    if (diffSelectors.length === 0) throw new Error("--diff-subset lists no path selectors");
  }
  // The sub-wave NAME this wave's slot records carry (the seal binds panel
  // slots and the coverage receipt through this name). Required WITH a pack
  // subset, forbidden without one — an unsplit wave is anonymous.
  const subWaveName = splitRequested ? subWaveArg.trim() : null;
  const packFiles = reviewPackFiles(base, frozen.packet, subsetSelectors);
  const diffEntries = reviewDiffEntries(base, diffSelectors);
  const readableDiff = diffSelectors ? buildReadableDiffSlice(base, diffEntries) : frozen.diff;
  const triadPrompt = buildTriadPrompt(
    base,
    frozen.prompt,
    readableDiff,
    packFiles,
    subsetSelectors,
    diffSelectors,
  );
  const scopePrompt = buildScopePrompt(
    base,
    frozen.prompt,
    readableDiff,
    packFiles,
    subsetSelectors,
    diffSelectors,
  );
  const promptSha256 = {
    triad: createHash("sha256").update(triadPrompt, "utf8").digest("hex"),
    scope: createHash("sha256").update(scopePrompt, "utf8").digest("hex"),
  };
  const expectedPromptSha256 = {
    triad: arg("expected-triad-prompt-sha256"),
    scope: arg("expected-scope-prompt-sha256"),
  };
  if (preparePrompts) {
    if (expectedPromptSha256.triad !== null || expectedPromptSha256.scope !== null) {
      throw new Error("prepared prompt digests are live-review inputs, not preparation inputs");
    }
  } else {
    for (const [role, expected] of Object.entries(expectedPromptSha256)) {
      if (typeof expected !== "string" || !/^[0-9a-f]{64}$/.test(expected)) {
        throw new Error(`--expected-${role}-prompt-sha256 must be one lowercase SHA-256`);
      }
      if (expected !== promptSha256[role]) {
        throw new Error(`${role} prompt bytes differ from the prepared prompt digest`);
      }
    }
  }
  const contextPreflight = [
    ...TRIAD_MODELS.map((model) => ({
      role: "triad",
      ...reviewPromptContextPreflight(model, triadPrompt, MAX_OUTPUT_TOKENS),
    })),
    {
      role: "scope",
      ...reviewPromptContextPreflight(SCOPE_MODEL, scopePrompt, MAX_OUTPUT_TOKENS),
    },
  ];
  const refused = contextPreflight.filter((entry) => !entry.ok);
  if (refused.length > 0) {
    throw new Error(
      `review prompt exceeds an exact-panel context/output limit: ${refused
        .flatMap((entry) => entry.reasons.map((reason) => `${entry.model}: ${reason}`))
        .join("; ")}`,
    );
  }
  // Fail BEFORE remote submission if the evidence contains a token-like value:
  // a leaked secret must not reach OpenRouter or the persisted artifacts.
  if (
    containsSecretLikeToken(triadPrompt) ||
    containsSecretLikeToken(scopePrompt) ||
    redactSecrets(triadPrompt) !== triadPrompt ||
    redactSecrets(scopePrompt) !== scopePrompt
  ) {
    throw new Error("review evidence contains a secret-like token; scrub the sealed packet");
  }
  mkdirSync(outDir, { recursive: true });
  const triadPromptPath = join(outDir, "triad-prompt.md");
  const scopePromptPath = join(outDir, "scope-prompt.md");
  writeFileSync(triadPromptPath, triadPrompt);
  writeFileSync(scopePromptPath, scopePrompt);
  const submittedTriadPrompt = readFileSync(triadPromptPath, "utf8");
  const submittedScopePrompt = readFileSync(scopePromptPath, "utf8");
  if (submittedTriadPrompt !== triadPrompt || submittedScopePrompt !== scopePrompt) {
    throw new Error("persisted review prompt bytes differ from the preflighted prompt");
  }
  writeFileSync(
    join(outDir, "prompt-context-preflight.json"),
    `${JSON.stringify({ authority: RELEASE_REVIEW_LIMITS_AUTHORITY, checks: contextPreflight }, null, 2)}\n`,
  );
  const persistedPromptSha256 = {
    triad: createHash("sha256").update(readFileSync(triadPromptPath)).digest("hex"),
    scope: createHash("sha256").update(readFileSync(scopePromptPath)).digest("hex"),
  };
  if (
    persistedPromptSha256.triad !== promptSha256.triad ||
    persistedPromptSha256.scope !== promptSha256.scope
  ) {
    throw new Error("persisted review prompt digests differ from the preflighted prompts");
  }
  if (preparePrompts) {
    writeFileSync(
      join(outDir, "PREPARE_PROMPTS_RECEIPT.json"),
      `${JSON.stringify(
        {
          schemaVersion: 2,
          candidateSha,
          candidateTree,
          base,
          packetManifestSha256: frozen.manifestSha256,
          fullGateReceiptSha256: reviewRuntime.receiptSha256,
          reviewRuntimeArtifacts: reviewRuntime.artifacts,
          subWave: subWaveName,
          promptSha256,
          promptBytes: {
            triad: Buffer.byteLength(submittedTriadPrompt, "utf8"),
            scope: Buffer.byteLength(submittedScopePrompt, "utf8"),
          },
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          contextPreflight,
          reviewWaveId,
          networkRequests: 0,
          reviewersStarted: 0,
        },
        null,
        2,
      )}\n`,
      { flag: "wx", mode: 0o600 },
    );
    return;
  }
  const reviewRunId = randomUUID();
  console.error(
    `triad prompt: ${submittedTriadPrompt.length} chars; models: ${TRIAD_MODELS.join(", ")}`,
  );
  console.error(`scope prompt: ${submittedScopePrompt.length} chars; model: ${SCOPE_MODEL}`);

  // Write every start before any call, then launch the exact four slots in one
  // Promise.all so the Tier-2 evidence has one unambiguous concurrency boundary.
  const progressPath = join(outDir, "reviewer-progress.jsonl");
  const progress = (entry) =>
    appendFileSync(progressPath, JSON.stringify({ ...entry, reviewRunId, reviewWaveId }) + "\n");
  for (const model of TRIAD_MODELS)
    progress({ ts: new Date().toISOString(), type: "reviewer.started", model });
  progress({
    ts: new Date().toISOString(),
    type: "reviewer.started",
    model: SCOPE_MODEL,
    role: "scope",
  });
  // Liveness + one same-SHA retry (CHECKLISTS "Reviewer liveness"): an
  // empty, instant, errored, or unparseable response is an infrastructure
  // failure — retry the slot exactly once, then report it failed. A
  // "responded" result that is implausibly fast or carries no parseable JSON
  // array is downgraded before the retry decision so cache/transport
  // artifacts can never occupy a required slot.
  const withLiveness = (result, promptChars) => {
    if (result.status !== "responded") return result;
    const liveness = reviewerLiveness(
      { status: result.status, duration_ms: result.ms },
      livenessFloorMs(promptChars),
    );
    if (!liveness.live) {
      return { ...result, status: "implausible", error: liveness.reason };
    }
    if (parseChecklistJson(result.raw) === null) {
      return { ...result, status: "parse_failure", error: "no_parseable_json_array" };
    }
    return result;
  };
  const callSlotOnce = (model, prompt) =>
    callModel(model, prompt).then((result) => withLiveness(result, prompt.length));
  const callSlotWithRetry = async (model, prompt, role) => {
    const first = await callSlotOnce(model, prompt);
    if (first.status === "responded") return first;
    progress({
      ts: new Date().toISOString(),
      type: "reviewer.retry",
      model,
      first_status: first.status,
      first_error: first.error ?? null,
      ...(role ? { role } : {}),
    });
    const second = await callSlotOnce(model, prompt);
    return {
      ...second,
      retried: true,
      firstAttempt: { status: first.status, error: first.error ?? null, ms: first.ms },
    };
  };
  const runSlot = (model, prompt, role) =>
    callSlotWithRetry(model, prompt, role).then(
      (result) => {
        if (result.firstEventAt) {
          progress({
            ts: result.firstEventAt,
            type: "reviewer.first_event",
            model,
            observed_model: result.observedModel ?? null,
            source: result.source ?? null,
            transport: result.transport ?? null,
            ...(role ? { role } : {}),
          });
        }
        progress({
          ts: result.completedAt ?? new Date().toISOString(),
          type:
            result.status === "responded"
              ? "reviewer.completed"
              : result.timedOut || result.status === "timed_out"
                ? "reviewer.timed_out"
                : "reviewer.failed",
          model,
          observed_model: result.observedModel ?? null,
          source: result.source ?? null,
          transport: result.transport ?? null,
          status: result.status,
          duration_ms: result.ms,
          ...(role ? { role } : {}),
        });
        return result;
      },
      (error) => {
        progress({
          ts: new Date().toISOString(),
          type: "reviewer.failed",
          model,
          status: "error",
          error: error instanceof Error ? error.message : String(error),
          ...(role ? { role } : {}),
        });
        throw error;
      },
    );
  const slotResults = await Promise.all([
    ...TRIAD_MODELS.map((model) => runSlot(model, submittedTriadPrompt)),
    runSlot(SCOPE_MODEL, submittedScopePrompt, "scope"),
  ]);
  const triadResults = slotResults.slice(0, TRIAD_MODELS.length);
  const scopeResult = slotResults[TRIAD_MODELS.length];
  const actorRecords = [];
  const findings = [];
  for (const [idx, result] of triadResults.entries()) {
    const slug = result.model.replace(/[^a-z0-9.-]+/gi, "_");
    writeFileSync(join(outDir, `triad-${slug}.raw.txt`), redactSecrets(result.raw ?? ""));
    let status = result.status;
    let parsed = [];
    let parseError = result.error ?? null;
    let missingItems = [...TRIAD_ITEMS];
    if (status === "responded") {
      const arr = parseChecklistJson(result.raw);
      if (arr === null) {
        status = "parse_failure";
        parseError = "no_parseable_json_array";
      } else {
        const validation = validateChecklistResponse(arr, result.model, TRIAD_ITEMS);
        status = validation.status;
        parsed = validation.findings;
        parseError = validation.error;
        missingItems = validation.missingItems;
        writeFileSync(
          join(outDir, `triad-${slug}.parsed-json-blocks.json`),
          redactSecrets(JSON.stringify(arr, null, 2)) + "\n",
        );
      }
    }
    if (status !== "responded") {
      writeFileSync(
        join(outDir, `triad-${slug}.parse-error.json`),
        JSON.stringify(
          {
            error: parseError ?? status,
            missing_items: missingItems,
            raw_file: `triad-${slug}.raw.txt`,
          },
          null,
          2,
        ) + "\n",
      );
    }
    const record = {
      candidateSha,
      candidateTree,
      packetManifestSha256: frozen.manifestSha256,
      fullGateReceiptSha256: reviewRuntime.receiptSha256,
      reviewRuntimeArtifacts: reviewRuntime.artifacts,
      promptSha256: promptSha256.triad,
      reviewRunId,
      reviewWaveId,
      // Typed slot-attestation fields: the release sealer PARSES this record
      // and derives everything from it — verdict, panel identity, report
      // digest — instead of trusting CLI-prose labels (gate-5 critical).
      panel_slot: "triad",
      sub_wave: subWaveName,
      round: Number(requiredArg("round")),
      live: status === "responded",
      liveness_floor_ms: livenessFloorMs(submittedTriadPrompt.length),
      report_sha256: createHash("sha256")
        .update(redactSecrets(result.raw ?? ""))
        .digest("hex"),
      verdict: slotVerdict(status, parsed),
      model_id: result.model,
      requested_model: result.model,
      observed_model: result.observedModel ?? null,
      observed_model_source: result.observedModel ? "openrouter_response_body" : null,
      requested_effort: null,
      transport: result.transport ?? null,
      source: result.source ?? null,
      route_proof: result.routeProof ?? null,
      response_id: result.responseId ?? null,
      finish_reason: result.finishReason ?? null,
      status,
      slot: idx + 1,
      retried: result.retried ?? false,
      first_attempt: result.firstAttempt ?? null,
      parsed_count: parsed.length,
      missing_items: missingItems,
      usage: result.usage ?? null,
      started_at: result.startedAt ?? null,
      // Non-streaming transport: there is no separate first-event timestamp;
      // use the first HTTP response timestamp rather than faking completion.
      first_event_at: result.firstEventAt ?? null,
      completed_at: result.completedAt ?? null,
      duration_ms: result.ms,
      error: parseError,
      raw_file: `triad-${slug}.raw.txt`,
      findings: parsed,
    };
    actorRecords.push(record);
    writeFileSync(
      join(outDir, `triad-${slug}.metadata.json`),
      JSON.stringify(record, null, 2) + "\n",
    );
    findings.push(...parsed);
  }
  const responsive = actorRecords.filter((r) => r.status === "responded");
  const degraded = actorRecords
    .filter((r) => r.status !== "responded")
    .map((r) => `${r.model_id}=${r.status}`);

  let scope = null;
  {
    writeFileSync(join(outDir, "scope.raw.txt"), redactSecrets(scopeResult.raw ?? ""));
    let scopeStatus = scopeResult.status;
    let scopeFindings = [];
    let scopeError = scopeResult.error ?? null;
    let scopeMissing = [...SCOPE_ITEMS];
    const scopeMeta = {
      candidateSha,
      candidateTree,
      packetManifestSha256: frozen.manifestSha256,
      fullGateReceiptSha256: reviewRuntime.receiptSha256,
      reviewRuntimeArtifacts: reviewRuntime.artifacts,
      promptSha256: promptSha256.scope,
      reviewRunId,
      reviewWaveId,
      panel_slot: "scope",
      sub_wave: subWaveName,
      round: Number(requiredArg("round")),
      live: scopeStatus === "responded",
      liveness_floor_ms: livenessFloorMs(submittedScopePrompt.length),
      report_sha256: createHash("sha256")
        .update(redactSecrets(scopeResult.raw ?? ""))
        .digest("hex"),
      model_id: SCOPE_MODEL,
      requested_model: SCOPE_MODEL,
      observed_model: scopeResult.observedModel ?? null,
      observed_model_source: scopeResult.observedModel ? "openrouter_response_body" : null,
      requested_effort: null,
      transport: scopeResult.transport ?? null,
      source: scopeResult.source ?? null,
      route_proof: scopeResult.routeProof ?? null,
      response_id: scopeResult.responseId ?? null,
      finish_reason: scopeResult.finishReason ?? null,
      status: scopeStatus,
      retried: scopeResult.retried ?? false,
      first_attempt: scopeResult.firstAttempt ?? null,
      usage: scopeResult.usage ?? null,
      started_at: scopeResult.startedAt ?? null,
      first_event_at: scopeResult.firstEventAt ?? null,
      completed_at: scopeResult.completedAt ?? null,
      duration_ms: scopeResult.ms,
      error: scopeError,
      raw_file: "scope.raw.txt",
    };
    if (scopeStatus === "responded") {
      const arr = parseChecklistJson(scopeResult.raw);
      if (arr === null) {
        scopeStatus = "parse_failure";
        scopeError = "no_parseable_json_array";
      } else {
        const validation = validateChecklistResponse(arr, SCOPE_MODEL, SCOPE_ITEMS);
        scopeStatus = validation.status;
        scopeFindings = validation.findings;
        scopeError = validation.error;
        scopeMissing = validation.missingItems;
        writeFileSync(
          join(outDir, "scope.parsed-json-blocks.json"),
          redactSecrets(JSON.stringify(arr, null, 2)) + "\n",
        );
        scopeMeta.status = scopeStatus;
        scopeMeta.error = scopeError;
        scope = {
          status: scopeStatus,
          findings: scopeFindings,
          missing_items: scopeMissing,
          error: scopeError,
          usage: scopeResult.usage ?? null,
          metadata: scopeMeta,
        };
      }
    }
    if (!scope) {
      scopeMeta.status = scopeStatus;
      scopeMeta.error = scopeError;
      scope = {
        status: scopeStatus,
        findings: scopeFindings,
        missing_items: scopeMissing,
        error: scopeError,
        metadata: scopeMeta,
      };
    }
    if (scopeStatus !== "responded") {
      writeFileSync(
        join(outDir, "scope.parse-error.json"),
        JSON.stringify(
          {
            error: scopeError ?? scopeStatus,
            missing_items: scopeMissing,
            raw_file: "scope.raw.txt",
          },
          null,
          2,
        ) + "\n",
      );
    }
    scopeMeta.findings = scopeFindings;
    scopeMeta.missing_items = scopeMissing;
    scopeMeta.verdict = slotVerdict(scopeStatus, scopeFindings);
    writeFileSync(join(outDir, "scope.metadata.json"), JSON.stringify(scopeMeta, null, 2) + "\n");
  }

  const decision = releaseReviewDecision({
    triadActors: actorRecords,
    scope,
    ...reviewDecisionLivenessFloors(submittedTriadPrompt.length, submittedScopePrompt.length),
  });
  const summary = {
    reviewRunId,
    reviewWaveId,
    promptSha256,
    round: Number(round),
    base,
    candidate_sha: candidateSha,
    candidate_tree: candidateTree,
    packet_manifest_sha256: frozen.manifestSha256,
    full_gate_receipt_sha256: reviewRuntime.receiptSha256,
    review_runtime_artifacts: reviewRuntime.artifacts,
    generated_at: new Date().toISOString(),
    panel: { triad: TRIAD_MODELS, scope: SCOPE_MODEL },
    panel_source: "built_in_exact",
    panel_pinned_now: false,
    panel_override_active: false,
    triad: {
      models: TRIAD_MODELS,
      // v3: every required slot must be live — partial panels never pass.
      required_slots_live: decision.responsiveTriad === TRIAD_MODELS.length,
      degraded,
      actors: actorRecords,
      findings,
    },
    blocker_contract_gaps: decision.blockerContractGaps,
    scope,
    decision,
  };
  writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");

  // Markdown table (FAILs first).
  const rows = [...findings, ...(scope?.findings ?? [])]
    .sort((a, b) => (a.verdict === b.verdict ? 0 : a.verdict === "FAIL" ? -1 : 1))
    .map(
      (f) =>
        `| ${f.model} | ${f.item} | ${f.verdict} | ${f.severity} | ${f.reason.replaceAll("|", "\\|").replaceAll("\n", " ")} |`,
    );
  const table = [
    `# Triad + Scope review — round ${round}`,
    "",
    `- base: ${base}`,
    `- required slots: ${decision.responsiveTriad}/${TRIAD_MODELS.length} live${degraded.length ? ` (failed: ${degraded.join(", ")})` : ""}`,
    `- scope: ${scope ? scope.status : "skipped"}`,
    "",
    "| model | item | verdict | severity | reason |",
    "|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
  writeFileSync(join(outDir, "summary.md"), redactSecrets(table));
  console.log(table);

  if (!decision.passed) {
    console.error(`REVIEW_BLOCKED: ${decision.reasons.join("; ")}.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

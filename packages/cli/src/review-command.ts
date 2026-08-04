/**
 * `claudexor review`: thin surface over the engine's scoped review. It accepts
 * either an ad-hoc diff or a SHA-bound sealed packet. FAIL CLOSED: an
 * inconclusive reviewer panel (unhealthy cross-family state or
 * INSUFFICIENT_EVIDENCE findings) never reads as a pass.
 */
import { readFileSync } from "node:fs";
import { Orchestrator } from "@claudexor/orchestrator";
import { isBlocking, type ControlReviewerPanelEntry } from "@claudexor/schema";
import { parseReviewerPanelFlags } from "./run-options.js";
import { type ParsedArgs, flagStr, flagValues } from "./args.js";
import { print, printJson, printUsageError } from "./cli-io.js";
import { renderCliFailure } from "./cli-error.js";
import { buildRegistry } from "./registry.js";

function panelFlags(args: ParsedArgs): ControlReviewerPanelEntry[] | undefined {
  return parseReviewerPanelFlags(flagValues(args, "reviewer-panel"));
}

/** `--delta-scope <harness>=<baseSha>` (repeatable): the named lane's review
 * subject becomes the packet's sealed DELTA.patch since baseSha (INV-125
 * second amendment, owner decision 2026-08-04). Sealed-packet mode only. */
function deltaScopeFlags(args: ParsedArgs): Record<string, string> | undefined {
  const raw = flagValues(args, "delta-scope");
  if (raw.length === 0) return undefined;
  const scopes: Record<string, string> = {};
  for (const entry of raw) {
    const text = typeof entry === "string" ? entry : "";
    const eq = text.indexOf("=");
    const harness = eq > 0 ? text.slice(0, eq).trim() : "";
    const baseSha = eq > 0 ? text.slice(eq + 1).trim() : "";
    if (!harness || !/^[0-9a-f]{40}$/i.test(baseSha)) {
      throw new Error(`--delta-scope expects <harness>=<40-hex-base-sha>, got '${String(entry)}'`);
    }
    scopes[harness] = baseSha.toLowerCase();
  }
  return scopes;
}

export async function reviewCommand(args: ParsedArgs, json: boolean): Promise<number> {
  const diffPath = flagStr(args, "diff");
  const evidenceDir = flagStr(args, "evidence-dir");
  const artifactsDir = flagStr(args, "artifacts-dir");
  const candidateSha = flagStr(args, "candidate-sha");
  const candidateTree = flagStr(args, "candidate-tree");
  const packetManifestSha256 = flagStr(args, "packet-manifest-digest");
  const frozenValues = [
    evidenceDir,
    artifactsDir,
    candidateSha,
    candidateTree,
    packetManifestSha256,
  ];
  const frozenRequested = frozenValues.some((value) => value !== undefined);
  const usage =
    'usage: claudexor review --diff <file> [--intent "<text>"] [--tests "<evidence>"] [--reviewer-panel <list>] [--json]\n' +
    "   or: claudexor review --evidence-dir <path> --artifacts-dir <external-path> --candidate-sha <sha> --candidate-tree <tree> --packet-manifest-digest <sha256> [--reviewer-panel <list>] [--delta-scope <harness>=<baseSha>] [--json]";
  if ((!diffPath && !frozenRequested) || (frozenRequested && frozenValues.some((v) => !v))) {
    return printUsageError(json, usage);
  }
  if (
    frozenRequested &&
    (diffPath !== undefined ||
      flagStr(args, "intent") !== undefined ||
      flagStr(args, "tests") !== undefined)
  ) {
    return printUsageError(
      json,
      "claudexor review: sealed packet mode cannot be combined with --diff, --intent, or --tests",
    );
  }
  let deltaScopes: Record<string, string> | undefined;
  try {
    deltaScopes = deltaScopeFlags(args);
  } catch (err) {
    return printUsageError(
      json,
      `claudexor review: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (deltaScopes && !frozenRequested) {
    return printUsageError(
      json,
      "claudexor review: --delta-scope is only valid in sealed packet mode",
    );
  }
  let diffText: string | undefined;
  if (diffPath) {
    try {
      diffText = readFileSync(diffPath, "utf8");
    } catch (err) {
      return printUsageError(
        json,
        `claudexor review: cannot read --diff '${diffPath}': ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  try {
    const orch = new Orchestrator({
      registry: buildRegistry(),
      reviewerPanel: panelFlags(args),
    });
    const result = await orch.reviewDiff({
      repoRoot: process.cwd(),
      ...(frozenRequested
        ? {
            frozen: {
              evidenceDir: evidenceDir!,
              artifactsDir: artifactsDir!,
              candidateSha: candidateSha!,
              candidateTree: candidateTree!,
              packetManifestSha256: packetManifestSha256!,
              ...(deltaScopes ? { deltaScopes } : {}),
            },
          }
        : {
            diff: diffText!,
            userIntent: flagStr(args, "intent"),
            tests: flagStr(args, "tests"),
          }),
    });
    const blockers = result.findings.filter((f) => isBlocking(f));
    // FAIL CLOSED: reviewer setup/parse failures surface as
    // INSUFFICIENT_EVIDENCE findings that isBlocking never counts — an
    // inconclusive panel must NOT read as a pass. The pass bar matches
    // convergence's "clean review": cross-family HEALTHY (parseable findings
    // from >=2 families) AND VERIFIED (stream-observed route proofs).
    const inconclusive =
      !result.crossFamilyHealthy ||
      !result.crossFamilyVerified ||
      result.findings.some((f) => f.severity === "INSUFFICIENT_EVIDENCE");
    const ok = blockers.length === 0 && !inconclusive;
    if (json) {
      printJson({
        ok,
        inconclusive,
        crossFamilyVerified: result.crossFamilyVerified,
        providers: result.distinctProviders,
        blockers: blockers.length,
        findings: result.findings,
        reviewSpendUsd: result.reviewSpendUsd,
        artifactsDir: result.artifactsDir,
      });
    } else {
      print(
        `reviewers: ${result.distinctProviders.join(", ") || "none"} (cross-family verified: ${result.crossFamilyVerified})`,
      );
      for (const f of result.findings) print(`  [${f.severity}] ${f.claim}`);
      print(
        ok
          ? "review: PASS"
          : inconclusive && blockers.length === 0
            ? "review: INCONCLUSIVE (reviewer panel unhealthy) — fail closed"
            : `review: ${blockers.length} blocking finding(s)`,
      );
    }
    return ok ? 0 : 1;
  } catch (err) {
    return renderCliFailure(json, err, { messagePrefix: "claudexor review:" });
  }
}

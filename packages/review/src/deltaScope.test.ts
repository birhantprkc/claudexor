import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HarnessAdapter } from "@claudexor/core";
import { createHash } from "node:crypto";
import { reviewCandidate } from "./reviewEngine.js";

/** INV-125 second amendment integrity (wave-6 finding): the delta scope has
 * NO harness parameter — "fable-scoped", "both-scoped", and "unknown/duplicate
 * harness" misuse is impossible by construction ({ baseSha } is the whole
 * input domain). These tests pin the remaining reachable surface: packet
 * binding (base, digest, exact git diff), the cursor-lane pin, and the
 * sealed-mode requirement. */

const reaped: string[] = [];
afterEach(() => {
  while (reaped.length) rmSync(reaped.pop()!, { recursive: true, force: true });
});

function mk(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  reaped.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "init.templateDir=", "-c", "core.hooksPath=/dev/null", ...args],
    { cwd, encoding: "utf8" },
  ).trim();
}

function fixture(): {
  cwd: string;
  evidenceDir: string;
  artifactsDir: string;
  baseSha: string;
  headSha: string;
  deltaText: string;
  fullDiff: string;
} {
  const cwd = mk("claudexor-delta-scope-");
  git(cwd, "init", "--quiet");
  git(cwd, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "root");
  writeFileSync(join(cwd, "a.ts"), "export const a = 1;\n");
  git(cwd, "add", "--force", "a.ts");
  git(cwd, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "base");
  const baseSha = git(cwd, "rev-parse", "HEAD");
  writeFileSync(join(cwd, "a.ts"), "export const a = 2;\n");
  git(cwd, "add", "--force", "a.ts");
  git(cwd, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "head");
  const headSha = git(cwd, "rev-parse", "HEAD");
  const deltaText = execFileSync("git", ["diff", "--binary", `${baseSha}..${headSha}`], {
    cwd,
    encoding: "utf8",
  });
  const fullDiff = deltaText; // one hop, so full == delta content-wise
  const evidenceDir = join(cwd, ".claudexor-review-evidence");
  mkdirSync(evidenceDir, { recursive: true });
  for (const [name, text] of [
    ["USER_INTENT.md", "review candidate\n"],
    ["FORBIDDEN_FINDINGS.md", "(none)\n"],
    ["PLAN_ACCEPTED.md", "(none)\n"],
    ["TESTS.txt", "(gate evidence)\n"],
    ["DECIDED_TRADEOFFS.md", "(none)\n"],
    ["DIFF.patch", fullDiff],
    ["DIFF_SUMMARY.md", "one file changed\n"],
    ["DELTA.patch", deltaText],
    ["DELTA_SUMMARY.md", "delta of one file\n"],
    ["FREEZE.json", "{}\n"],
    ["MANIFEST.sha256", "sealed fixture\n"],
  ] as const) {
    writeFileSync(join(evidenceDir, name), text);
  }
  writeFileSync(
    join(evidenceDir, "FINGERPRINTS.json"),
    `${JSON.stringify({ deltaBaseSha: baseSha, deltaSha256: createHash("sha256").update(deltaText).digest("hex") }, null, 2)}\n`,
  );
  const artifactsDir = mk("claudexor-delta-scope-artifacts-");
  return { cwd, evidenceDir, artifactsDir, baseSha, headSha, deltaText, fullDiff };
}

function adapterFor(id: string, prompts: Map<string, string>): HarnessAdapter {
  return {
    id,
    async doctor() {
      throw new Error("not used");
    },
    async *run(spec: { session_id: string; prompt: string }) {
      prompts.set(id, spec.prompt);
      yield {
        type: "message",
        session_id: spec.session_id,
        ts: new Date().toISOString(),
        text: "[]",
      };
    },
  } as unknown as HarnessAdapter;
}

function inputFor(
  f: ReturnType<typeof fixture>,
  prompts: Map<string, string>,
  baseSha: string,
  reviewerIds: string[] = ["claude", "cursor"],
) {
  return {
    candidateLabel: "Frozen candidate",
    diff: f.fullDiff,
    evidenceDir: f.evidenceDir,
    evidenceReadOnly: true as const,
    frozenIdentity: {
      candidateSha: f.headSha,
      candidateTree: "b".repeat(40),
      packetManifestSha256: "c".repeat(64),
    },
    env: { CLAUDEXOR_REVIEW_WAVE_ID: "11111111-1111-4111-8111-111111111111" },
    artifactsDir: f.artifactsDir,
    cwd: f.cwd,
    deltaScope: { baseSha },
    reviewers: reviewerIds.map((id) => ({
      adapter: adapterFor(id, prompts),
      providerFamily: (id === "cursor" ? "cursor" : "anthropic") as "cursor" | "anthropic",
    })),
  };
}

describe("owner-amended delta scope integrity (INV-125 second amendment)", () => {
  it("pins the delta to the cursor lane and frames only that prompt as delta", async () => {
    const f = fixture();
    const prompts = new Map<string, string>();
    await reviewCandidate(inputFor(f, prompts, f.baseSha));
    expect(prompts.get("cursor")).toContain("OWNER-AMENDED DELTA SCOPE");
    expect(prompts.get("cursor")).toContain("DELTA.patch");
    expect(prompts.get("claude")).not.toContain("OWNER-AMENDED DELTA SCOPE");
    const cursorMeta = JSON.parse(
      readFileSync(join(f.artifactsDir, "02-cursor", "metadata.json"), "utf8"),
    );
    const claudeMeta = JSON.parse(
      readFileSync(join(f.artifactsDir, "01-claude", "metadata.json"), "utf8"),
    );
    expect(cursorMeta.review_scope).toBe("delta");
    expect(cursorMeta.delta_base_sha).toBe(f.baseSha);
    expect(cursorMeta.delta_sha256).toBe(createHash("sha256").update(f.deltaText).digest("hex"));
    expect(claudeMeta.review_scope).toBe("full");
    expect(claudeMeta.delta_base_sha).toBeUndefined();
  });

  it("rejects a base SHA that does not match the sealed FINGERPRINTS", async () => {
    const f = fixture();
    await expect(reviewCandidate(inputFor(f, new Map(), "0".repeat(40)))).rejects.toThrow(
      "does not match the sealed FINGERPRINTS deltaBaseSha",
    );
  });

  it("rejects a sealed DELTA.patch whose digest does not match FINGERPRINTS", async () => {
    const f = fixture();
    writeFileSync(
      join(f.evidenceDir, "FINGERPRINTS.json"),
      `${JSON.stringify({ deltaBaseSha: f.baseSha, deltaSha256: "d".repeat(64) }, null, 2)}\n`,
    );
    await expect(reviewCandidate(inputFor(f, new Map(), f.baseSha))).rejects.toThrow(
      "does not match the FINGERPRINTS deltaSha256",
    );
  });

  it("rejects a DELTA.patch that is not the exact base..candidate git diff", async () => {
    const f = fixture();
    const forged = f.deltaText.replace("const a = 2", "const a = 3");
    writeFileSync(join(f.evidenceDir, "DELTA.patch"), forged);
    writeFileSync(
      join(f.evidenceDir, "FINGERPRINTS.json"),
      `${JSON.stringify({ deltaBaseSha: f.baseSha, deltaSha256: createHash("sha256").update(forged).digest("hex") }, null, 2)}\n`,
    );
    await expect(reviewCandidate(inputFor(f, new Map(), f.baseSha))).rejects.toThrow(
      "not the exact deltaBaseSha..candidateSha diff",
    );
  });

  it.each([
    [["claude"], "fable-only panel, no cursor lane"],
    [["cursor", "cursor"], "duplicate cursor lanes"],
  ] as const)("rejects a panel of %j (%s)", async (ids, _label) => {
    const f = fixture();
    await expect(reviewCandidate(inputFor(f, new Map(), f.baseSha, [...ids]))).rejects.toThrow(
      "requires exactly one cursor reviewer lane",
    );
  });

  it("rejects a delta scope outside sealed-packet mode", async () => {
    const f = fixture();
    const input = { ...inputFor(f, new Map(), f.baseSha), evidenceReadOnly: false as const };
    await expect(reviewCandidate(input as never)).rejects.toThrow(
      "only valid against a sealed packet",
    );
  });
});

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildTouchedFilePack,
  changedFileInventorySection,
  extractReadableDiffSlice,
  extractTouchedFileSections,
  readableDiffSliceSection,
  touchedFileSection,
} from "../../../scripts/lib/release-review-contract.mjs";
import {
  CANONICAL_REVIEW_RENAME_ARG,
  GENERATED_ARTIFACT_ALLOWLIST,
  bindCoverageReceipt,
  buildCanonicalDiffPatches,
  checkCoverage,
  checkDiffCoverage,
  checkFullTextPartition,
  checkSubWavePairing,
  diffAuthoritativeRule,
  fileCoverage,
  parseNameStatusEntriesZ,
  parseWholeFileList,
  runCoverage,
  unionWithWholeFileList,
} from "../../../scripts/review-coverage-check.mjs";

/** Build a realistic touched-file pack from a {path: currentText} map. */
function packOf(files: Record<string, string>): string {
  return Object.entries(files)
    .map(([path, text]) => touchedFileSection(path, text))
    .join("\n\n");
}

function reviewPrompt(
  files: Record<string, string>,
  entries: Array<{ status: string; oldPath?: string; path: string; deleted: boolean }>,
  diff: string | Buffer,
): string {
  return [packOf(files), changedFileInventorySection(entries), readableDiffSliceSection(diff)].join(
    "\n\n",
  );
}

function tempGitRepo(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const g = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
  const gb = (...args: string[]) => execFileSync("git", ["-C", dir, ...args]);
  g("init", "-q");
  g("config", "user.email", "t@t");
  g("config", "user.name", "t");
  return { dir, g, gb };
}

describe("review-coverage-check", () => {
  const sources = {
    "packages/cli/src/a.ts": "export const a = 1;\n",
    "docs/GUIDE.md": "# Guide\n\nsome text\n",
  };
  const readCurrentText = (path: string): string => {
    const map: Record<string, string> = { ...sources };
    if (!(path in map)) throw new Error(`no fixture for ${path}`);
    return map[path];
  };

  it("passes when every hand-written file's full text is present", () => {
    const pack = packOf(sources);
    const report = checkCoverage({
      files: [{ path: "packages/cli/src/a.ts" }, { path: "docs/GUIDE.md" }],
      readCurrentText,
      packContents: [pack],
    });
    expect(report.ok).toBe(true);
    expect(report.covered.sort()).toEqual(["docs/GUIDE.md", "packages/cli/src/a.ts"]);
    expect(report.uncovered).toEqual([]);
  });

  it("fails when a source file is missing from every pack", () => {
    // Pack omits docs/GUIDE.md entirely.
    const pack = packOf({ "packages/cli/src/a.ts": sources["packages/cli/src/a.ts"] });
    const report = checkCoverage({
      files: [{ path: "packages/cli/src/a.ts" }, { path: "docs/GUIDE.md" }],
      readCurrentText,
      packContents: [pack],
    });
    expect(report.ok).toBe(false);
    expect(report.uncovered.map((u) => u.path)).toEqual(["docs/GUIDE.md"]);
  });

  it("fails a truncated file even when its header is present (omission note)", () => {
    // buildTouchedFilePack drops the big file past the pack budget -> omission note.
    const big = "x".repeat(400);
    const git = (args: string[]): string => {
      const path = args[1].replace(/^HEAD:/, "");
      if (path === "packages/cli/src/a.ts") return sources["packages/cli/src/a.ts"];
      if (path === "docs/GUIDE.md") return big;
      throw new Error("missing");
    };
    const pack = buildTouchedFilePack(
      ["packages/cli/src/a.ts", "docs/GUIDE.md"],
      git,
      1_000_000,
      300, // pack budget fits the small file but omits docs/GUIDE.md
    );
    expect(pack).toContain("OMISSION NOTE");
    const report = checkCoverage({
      files: [{ path: "packages/cli/src/a.ts" }, { path: "docs/GUIDE.md" }],
      readCurrentText: (p) => (p === "docs/GUIDE.md" ? big : readCurrentText(p)),
      packContents: [pack],
    });
    expect(report.ok).toBe(false);
    const g = report.uncovered.find((u) => u.path === "docs/GUIDE.md");
    expect(g?.reason).toMatch(/OMISSION NOTE/);
  });

  it("fails a file whose section is present but bytes are altered/truncated", () => {
    // Header present, but the fenced body is not the complete current text.
    const truncated = touchedFileSection("docs/GUIDE.md", "# Guide\n");
    const report = checkCoverage({
      files: [{ path: "docs/GUIDE.md" }],
      readCurrentText,
      packContents: [truncated],
    });
    expect(report.ok).toBe(false);
    expect(report.uncovered[0].reason).toMatch(/truncated\/altered/);
  });

  it("treats generated/fixture files as diff-authoritative and never requires their full text", () => {
    const report = checkCoverage({
      files: [
        { path: "packages/schema/generated/BudgetLease.schema.json" },
        { path: "docs/reference/endpoints.json" },
        {
          path: "apps/macos/ClaudexorKit/Tests/ClaudexorKitTests/Fixtures/wire/manifest.json",
        },
        { path: "packages/harness-codex/fixtures/transcript.jsonl" },
        { path: "pnpm-lock.yaml" },
        { path: "packages/util/src/version.ts" },
      ],
      readCurrentText: () => {
        throw new Error("diff-authoritative files must not be read for coverage");
      },
      packContents: [""], // empty pack: their absence must still pass
    });
    expect(report.ok).toBe(true);
    expect(report.skipped.map((s) => s.path).sort()).toEqual([
      "apps/macos/ClaudexorKit/Tests/ClaudexorKitTests/Fixtures/wire/manifest.json",
      "docs/reference/endpoints.json",
      "packages/harness-codex/fixtures/transcript.jsonl",
      "packages/schema/generated/BudgetLease.schema.json",
      "packages/util/src/version.ts",
      "pnpm-lock.yaml",
    ]);
  });

  it("never requires coverage for deleted files", () => {
    const report = checkCoverage({
      files: [{ path: "packages/cli/src/gone.ts", deleted: true }],
      readCurrentText: () => {
        throw new Error("deleted files have no current text");
      },
      packContents: [""],
    });
    expect(report.ok).toBe(true);
    expect(report.deleted).toEqual(["packages/cli/src/gone.ts"]);
  });

  it("classifies hand-written source as requiring coverage (null rule)", () => {
    expect(diffAuthoritativeRule("packages/cli/src/index.ts")).toBeNull();
    expect(diffAuthoritativeRule("apps/macos/ClaudexorApp/Sources/App.swift")).toBeNull();
    expect(diffAuthoritativeRule("packages/schema/src/index.ts")).toBeNull();
    expect(diffAuthoritativeRule("packages/schema/generated/X.schema.json")).toBe(
      "generated-schema",
    );
    expect(diffAuthoritativeRule("packages/harness-claude/fixtures/x.json")).toBe(
      "harness-fixture",
    );
    for (const p of GENERATED_ARTIFACT_ALLOWLIST) {
      expect(diffAuthoritativeRule(p)).toBe("generated-artifact-allowlist");
    }
  });

  it("unions FILES_TO_READ_WHOLE entries into the required set (listed-but-unchanged context files)", () => {
    const files = unionWithWholeFileList(
      [{ path: "packages/cli/src/a.ts", deleted: false }],
      JSON.stringify(["packages/cli/src/a.ts", "docs/GUIDE.md"]),
    );
    expect(files).toEqual([
      { path: "packages/cli/src/a.ts", deleted: false },
      { path: "docs/GUIDE.md", deleted: false },
    ]);
    // A pack that misses the listed-but-unchanged file must now FAIL coverage.
    const report = checkCoverage({
      files,
      readCurrentText,
      packContents: [packOf({ "packages/cli/src/a.ts": sources["packages/cli/src/a.ts"] })],
    });
    expect(report.ok).toBe(false);
    expect(report.uncovered.map((entry: { path: string }) => entry.path)).toEqual([
      "docs/GUIDE.md",
    ]);
    // No list → the changed set passes through untouched.
    expect(unionWithWholeFileList(files, null)).toBe(files);
    expect(parseWholeFileList(JSON.stringify([" #leading", "line\none", " trailing "]))).toEqual([
      " #leading",
      "line\none",
      " trailing ",
    ]);
    expect(() => parseWholeFileList("docs/GUIDE.md\n")).toThrow(/JSON array/);
  });

  it("bindCoverageReceipt recomputes from disk and refuses a forged receipt (E-C3)", () => {
    const { dir, g, gb } = tempGitRepo("coverage-bind-");
    try {
      writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
      g("add", "a.ts");
      g("commit", "-qm", "base");
      const base = g("rev-parse", "HEAD");
      writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");
      g("add", "a.ts");
      g("commit", "-qm", "change");
      const candidate = g("rev-parse", "HEAD");
      const diff = gb("diff", CANONICAL_REVIEW_RENAME_ARG, "--binary", `${base}..${candidate}`);
      const entries = [{ status: "M", path: "a.ts", deleted: false }];
      const prompt = reviewPrompt({ "a.ts": "export const a = 2;\n" }, entries, diff);
      const triadPath = join(dir, "triad-prompt.md");
      const scopePath = join(dir, "scope-prompt.md");
      const diffPath = join(dir, "DIFF.patch");
      writeFileSync(triadPath, prompt);
      writeFileSync(scopePath, prompt);
      writeFileSync(diffPath, diff);
      const cwd = process.cwd();
      process.chdir(dir);
      try {
        const packs = [{ subWave: "engine", triadPath, scopePath }];
        const honest = runCoverage({ base, candidate, packs, wholeFileListPath: null }).receiptBody;
        const bound = bindCoverageReceipt(honest, candidate, { baseSha: base, diffPath });
        expect(bound.ok).toBe(true);
        expect(bound.schemaVersion).toBe(2);
        expect(bound.inventory.triad).toMatchObject({ ok: true, covered: 1, total: 1 });
        expect(() =>
          bindCoverageReceipt(
            {
              ...honest,
              packs: [{ ...honest.packs[0], triadSha256: "0".repeat(64) }],
            },
            candidate,
          ),
        ).toThrow(/digest mismatch/);
        expect(() => bindCoverageReceipt({ ...honest, schemaVersion: 1 }, candidate)).toThrow(
          /schemaVersion 1 is not 2/,
        );
        expect(() => bindCoverageReceipt(honest, base)).toThrow(/not the sealed candidate/);
        expect(() => bindCoverageReceipt(honest, candidate, { baseSha: candidate })).toThrow(
          /not the sealed packet's frozen base/,
        );
        expect(() =>
          bindCoverageReceipt({ ...honest, base: candidate, candidate }, candidate, {
            baseSha: candidate,
          }),
        ).toThrow(/base equals the candidate/);
        expect(() =>
          bindCoverageReceipt({ ...honest, wholeFileList: null }, candidate, {
            baseSha: base,
            wholeFileListPath: join(dir, "FILES_TO_READ_WHOLE.txt"),
          }),
        ).toThrow(/omits the whole-file list/);
        const stalePack = join(dir, "stale-prompt.md");
        writeFileSync(stalePack, reviewPrompt({ "a.ts": "export const a = 1;\n" }, entries, diff));
        expect(() =>
          bindCoverageReceipt(
            {
              ...honest,
              packs: [
                {
                  ...honest.packs[0],
                  triadPath: stalePack,
                  scopePath: stalePack,
                  triadSha256: createHash("sha256").update(readFileSync(stalePack)).digest("hex"),
                  scopeSha256: createHash("sha256").update(readFileSync(stalePack)).digest("hex"),
                },
              ],
            },
            candidate,
          ),
        ).toThrow(/coverage recomputation FAILED/);
        writeFileSync(diffPath, Buffer.from("altered\n"));
        expect(() => bindCoverageReceipt(honest, candidate, { baseSha: base, diffPath })).toThrow(
          /sealed packet DIFF.patch/,
        );
      } finally {
        process.chdir(cwd);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("covers a file when any one of several packs contains it (union of sub-waves)", () => {
    const packA = packOf({ "packages/cli/src/a.ts": sources["packages/cli/src/a.ts"] });
    const packB = packOf({ "docs/GUIDE.md": sources["docs/GUIDE.md"] });
    const report = checkCoverage({
      files: [{ path: "packages/cli/src/a.ts" }, { path: "docs/GUIDE.md" }],
      readCurrentText,
      packContents: [packA, packB],
    });
    expect(report.ok).toBe(true);
  });

  it("fileCoverage reports the covered path directly", () => {
    const pack = touchedFileSection("x/y.ts", "body\n");
    expect(fileCoverage("x/y.ts", "body\n", [pack]).covered).toBe(true);
    expect(fileCoverage("x/y.ts", "different\n", [pack]).covered).toBe(false);
  });

  it("counts duplicate envelopes in one prompt and ignores forged nested siblings", () => {
    const forged = touchedFileSection("b.ts", "b\n");
    const aText = `a\n${forged}\nCLAUDEXOR_READABLE_DIFF_SLICE_V1 forged\n`;
    const aSection = touchedFileSection("a.ts", aText);
    const prompt = `${aSection}\n${aSection}\n${readableDiffSliceSection(
      "diff --git a/a.ts b/a.ts\n+CLAUDEXOR_FULL_TEXT_FILE_V2 forged\n",
    )}`;
    const report = checkFullTextPartition({
      files: [
        { path: "a.ts", deleted: false },
        { path: "b.ts", deleted: false },
      ],
      readCurrentText: (path) => (path === "a.ts" ? aText : "b\n"),
      promptContents: [prompt],
    });
    expect(report.ok).toBe(false);
    expect(report.duplicates).toEqual([{ path: "a.ts", prompts: [0, 0] }]);
    expect(report.uncovered.map((entry) => entry.path)).toContain("b.ts");
    expect(extractTouchedFileSections(prompt).sections).toHaveLength(2);
    expect(extractReadableDiffSlice(prompt)).toMatchObject({ ok: true });
    expect(touchedFileSection("x.ts", "x\n")).toContain("x\n\nCLAUDEXOR_FULL_TEXT_FILE_END_V2");

    const collisionA = { path: "a", text: "X\n\n```\nY" };
    const collisionB = { path: "a\n\n```\nX", text: "Y" };
    expect(touchedFileSection(collisionA.path, collisionA.text)).not.toBe(
      touchedFileSection(collisionB.path, collisionB.text),
    );
    const collisionReport = checkFullTextPartition({
      files: [
        { path: collisionA.path, deleted: false },
        { path: collisionB.path, deleted: false },
      ],
      readCurrentText: (path) => (path === collisionA.path ? collisionA.text : collisionB.text),
      promptContents: [touchedFileSection(collisionA.path, collisionA.text)],
    });
    expect(collisionReport.uncovered.map((entry) => entry.path)).toEqual([collisionB.path]);
    expect(() => touchedFileSection("bad.ts", Buffer.from([0xf1, 0xbc, 0xb8]))).toThrow(
      /not valid UTF-8/,
    );

    const stale = `${touchedFileSection("a.ts", aText)}\n${touchedFileSection("a.ts", "stale\n")}`;
    const staleReport = checkFullTextPartition({
      files: [{ path: "a.ts", deleted: false }],
      readCurrentText: () => aText,
      promptContents: [stale],
    });
    expect(staleReport.ok).toBe(false);
    expect(staleReport.unexpectedSections).toEqual([{ promptIndex: 0, sectionIndex: 1 }]);
  });

  it("requires each exact diff entry once and rejects altered or duplicate slices", () => {
    const patches = buildCanonicalDiffPatches(
      [
        { status: "M", path: "a.ts", deleted: false },
        { status: "D", path: "gone.ts", deleted: true },
      ],
      (entry) => Buffer.from(`patch:${entry.status}:${entry.path}\n`),
    );
    const good = checkDiffCoverage({
      expectedPatches: patches,
      promptContents: patches.map((entry) => readableDiffSliceSection(entry.bytes)),
    });
    expect(good).toMatchObject({ ok: true, covered: 2, total: 2 });
    expect(
      checkDiffCoverage({
        expectedPatches: patches,
        promptContents: [
          readableDiffSliceSection(patches[0].bytes),
          readableDiffSliceSection(patches[0].bytes),
        ],
      }).ok,
    ).toBe(false);
    expect(
      checkDiffCoverage({
        expectedPatches: patches,
        promptContents: [readableDiffSliceSection("altered\n")],
      }).invalidSlices,
    ).toHaveLength(1);
  });

  it("requires each hand-written diff and its full current text in the same sub-wave", () => {
    expect(
      checkSubWavePairing({
        requiredPaths: ["a.ts", "b.ts"],
        diffPathsByPrompt: [["a.ts"], ["b.ts"]],
        fullTextPathsByPrompt: [["b.ts"], ["a.ts"]],
        packs: [{ subWave: "a" }, { subWave: "b" }],
        role: "triad",
      }),
    ).toHaveLength(2);
    expect(
      checkSubWavePairing({
        requiredPaths: ["a.ts", "b.ts"],
        diffPathsByPrompt: [["a.ts"], ["b.ts"]],
        fullTextPathsByPrompt: [["a.ts"], ["b.ts"]],
        packs: [{ subWave: "a" }, { subWave: "b" }],
        role: "triad",
      }),
    ).toEqual([]);
  });

  it("freezes rename-only semantics against diff.renames=copies (historical regression)", () => {
    const { dir, g, gb } = tempGitRepo("coverage-copy-");
    try {
      const original = Array.from(
        { length: 80 },
        (_, index) => `export const v${index} = ${index};`,
      ).join("\n");
      writeFileSync(join(dir, "source.ts"), `${original}\n`);
      g("add", ".");
      g("commit", "-qm", "base");
      const base = g("rev-parse", "HEAD");
      writeFileSync(join(dir, "copy.ts"), `${original}\n`);
      writeFileSync(join(dir, "source.ts"), `export const changed = true;\n${original}\n`);
      g("add", ".");
      g("commit", "-qm", "copy and modify source");
      const candidate = g("rev-parse", "HEAD");
      const entries = parseNameStatusEntriesZ(
        gb("diff", CANONICAL_REVIEW_RENAME_ARG, "-z", "--name-status", `${base}..${candidate}`),
      );
      const patches = buildCanonicalDiffPatches(entries, (entry) =>
        gb(
          "--literal-pathspecs",
          "diff",
          CANONICAL_REVIEW_RENAME_ARG,
          "--binary",
          `${base}..${candidate}`,
          "--",
          ...(entry.oldPath ? [entry.oldPath, entry.path] : [entry.path]),
        ),
      );
      const sealed = gb("diff", CANONICAL_REVIEW_RENAME_ARG, "--binary", `${base}..${candidate}`);
      expect(Buffer.concat(patches.map((entry) => entry.bytes))).toEqual(sealed);
      const configDependent = g(
        "-c",
        "diff.renames=copies",
        "diff",
        "--name-status",
        `${base}..${candidate}`,
      );
      expect(configDependent).toMatch(/^C\d+/m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reconstructs special-path, rename, delete, binary, and mode-only entries exactly", () => {
    const { dir, g, gb } = tempGitRepo("coverage-special-");
    try {
      for (const [path, contents] of [
        ["space café.ts", "before\n"],
        ["line\nbreak.ts", "before\n"],
        ["old name.ts", "rename me\n"],
        ["gone.ts", "gone\n"],
        ["mode.sh", "#!/bin/sh\nexit 0\n"],
      ]) {
        writeFileSync(join(dir, path), contents);
      }
      writeFileSync(join(dir, "binary.dat"), Buffer.from([0x00, 0x01, 0x02]));
      g("add", ".");
      g("commit", "-qm", "base");
      const base = g("rev-parse", "HEAD");

      writeFileSync(join(dir, "space café.ts"), "after\n");
      writeFileSync(join(dir, "line\nbreak.ts"), "after\n");
      renameSync(join(dir, "old name.ts"), join(dir, "new name.ts"));
      unlinkSync(join(dir, "gone.ts"));
      chmodSync(join(dir, "mode.sh"), 0o755);
      writeFileSync(join(dir, "binary.dat"), Buffer.from([0x00, 0xff, 0x02]));
      g("add", "-A");
      g("commit", "-qm", "special changes");
      const candidate = g("rev-parse", "HEAD");

      const entries = parseNameStatusEntriesZ(
        gb("diff", CANONICAL_REVIEW_RENAME_ARG, "-z", "--name-status", `${base}..${candidate}`),
      );
      const patches = buildCanonicalDiffPatches(entries, (entry) =>
        gb(
          "--literal-pathspecs",
          "diff",
          CANONICAL_REVIEW_RENAME_ARG,
          "--binary",
          `${base}..${candidate}`,
          "--",
          ...(entry.oldPath ? [entry.oldPath, entry.path] : [entry.path]),
        ),
      );
      expect(Buffer.concat(patches.map((entry) => entry.bytes))).toEqual(
        gb("diff", CANONICAL_REVIEW_RENAME_ARG, "--binary", `${base}..${candidate}`),
      );
      expect(entries.map((entry) => entry.path)).toEqual(
        expect.arrayContaining([
          "space café.ts",
          "line\nbreak.ts",
          "new name.ts",
          "gone.ts",
          "mode.sh",
          "binary.dat",
        ]),
      );
      expect(entries.find((entry) => entry.path === "new name.ts")?.oldPath).toBe("old name.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildTouchedFilePack strict omission", () => {
  const git = (args: string[]): string => {
    const path = args[1].replace(/^HEAD:/, "");
    if (path === "small.ts") return "ok\n";
    if (path === "big.ts") return "x".repeat(500);
    throw new Error("missing");
  };

  it("throws instead of silently emitting an omission note under { onOmission: 'throw' }", () => {
    expect(() =>
      buildTouchedFilePack(["small.ts", "big.ts"], git, 1_000_000, 300, {
        onOmission: "throw",
      }),
    ).toThrow(/would drop 1 hand-written file/);
  });

  it("still emits a disclosed note by default (backward compatible)", () => {
    const pack = buildTouchedFilePack(["small.ts", "big.ts"], git, 1_000_000, 300);
    expect(pack).toContain("OMISSION NOTE");
    expect(pack).toContain("ok\n");
  });

  it("fails before network when strict mode cannot read a selected live blob", () => {
    const unreadable = () => {
      throw new Error("not a blob");
    };
    expect(() =>
      buildTouchedFilePack(["gitlink"], unreadable, 1_000_000, 1_000_000, {
        onOmission: "throw",
      }),
    ).toThrow(/could not read "gitlink"/);
    expect(buildTouchedFilePack(["gitlink"], unreadable, 1_000_000, 1_000_000)).toContain(
      "deleted by this diff",
    );
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

// GH #128: artifact enumeration races live tree mutation — git writes
// `.git/objects/xx/tmp_obj_*` then renames (the reviewer-workspace baseline
// repo lives INSIDE the run tree), and reviewer-workspace cleanup rm -rf's
// thousands of files while detail polls walk the same tree. The mid-walk
// vanish window cannot be hit by real timing in a test (the walk is
// synchronous), so — exactly like claude-bridge-race.test.ts — we mock
// `node:fs.lstatSync` to throw for selected paths over a REAL tmp tree.
// This mock lives in its OWN file: a module-level fs mock inside
// control-api.test.ts would poison every unrelated case there.
const state = vi.hoisted(() => ({
  vanishSuffix: null as string | null,
  epermSuffix: null as string | null,
}));

vi.mock("node:fs", async (importActual) => {
  const actual = await importActual<typeof import("node:fs")>();
  return {
    ...actual,
    default: actual,
    lstatSync: (path: Parameters<typeof actual.lstatSync>[0], ...rest: unknown[]) => {
      const p = String(path);
      if (state.vanishSuffix && p.endsWith(state.vanishSuffix)) {
        throw Object.assign(new Error(`ENOENT: simulated mid-walk vanish ${p}`), {
          code: "ENOENT",
        });
      }
      if (state.epermSuffix && p.endsWith(state.epermSuffix)) {
        throw Object.assign(new Error(`EPERM: simulated permission failure ${p}`), {
          code: "EPERM",
        });
      }
      return (actual.lstatSync as (...a: unknown[]) => unknown)(path, ...rest);
    },
  };
});

// Imported AFTER the mock declaration; vi.mock is hoisted so the named
// `lstatSync` bindings in artifact-paths.ts / artifact-serve-routes.ts resolve
// to the mocked module (readdirSync/realpathSync/existsSync stay real).
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
const { listArtifacts } = await import("./artifact-serve-routes.js");
const { safeArtifactPath } = await import("./artifact-paths.js");

describe("artifact enumeration under concurrent-mutation races (GH #128)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudexor-artifact-race-"));
    state.vanishSuffix = null;
    state.epermSuffix = null;
  });
  afterEach(() => {
    state.vanishSuffix = null;
    state.epermSuffix = null;
    rmSync(dir, { recursive: true, force: true });
  });

  it("skips an entry that vanishes between readdir and lstat and lists the survivors", () => {
    writeFileSync(join(dir, "keep.txt"), "kept\n");
    writeFileSync(join(dir, "vanishing.txt"), "gone\n");
    state.vanishSuffix = `${sep}vanishing.txt`; // readdir really returned it; lstat finds it gone
    const listed = listArtifacts(dir);
    expect(listed.map((a) => a.path)).toEqual(["keep.txt"]);
  });

  it("never enumerates a real .git subtree while siblings stay listed (unmocked)", () => {
    mkdirSync(join(dir, ".git", "objects", "e5"), { recursive: true });
    writeFileSync(join(dir, ".git", "objects", "e5", "tmp_obj_x"), "x");
    writeFileSync(join(dir, "report.md"), "# r\n");
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "notes.txt"), "n\n");
    const paths = listArtifacts(dir).map((a) => a.path);
    expect(paths).toEqual(["report.md", "sub", "sub/notes.txt"]);
    expect(paths.some((p) => p === ".git" || p.startsWith(".git/"))).toBe(false);
  });

  it("resolves a fetch path that vanishes between exists and lstat to null, not a throw", () => {
    writeFileSync(join(dir, "artifact.json"), "{}");
    state.vanishSuffix = `${sep}artifact.json`; // existsSync saw it; lstat finds it gone
    expect(safeArtifactPath(dir, "artifact.json")).toBeNull();
  });

  it("keeps non-vanish errnos loud: EPERM on lstat still throws", () => {
    writeFileSync(join(dir, "locked.txt"), "x");
    state.epermSuffix = `${sep}locked.txt`;
    expect(() => listArtifacts(dir)).toThrow(/EPERM/);
  });
});

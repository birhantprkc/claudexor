import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeExistingProjectRoot } from "./run-start.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("normalizeExistingProjectRoot", () => {
  it("accepts a symlink to an existing directory and preserves its spelling", () => {
    const parent = mkdtempSync(join(tmpdir(), "claudexor-root-symlink-"));
    const target = mkdtempSync(join(tmpdir(), "claudexor-root-target-"));
    roots.push(parent, target);
    const linked = join(parent, "project-link");
    symlinkSync(target, linked, "dir");

    expect(normalizeExistingProjectRoot(`  ${linked}  `)).toBe(linked);
  });

  it("keeps missing paths and regular files on the same typed refusal", () => {
    const parent = mkdtempSync(join(tmpdir(), "claudexor-root-invalid-"));
    roots.push(parent);
    const file = join(parent, "file.txt");
    writeFileSync(file, "not a directory");

    for (const value of [join(parent, "missing"), file]) {
      try {
        normalizeExistingProjectRoot(value);
        throw new Error("expected project-root refusal");
      } catch (error) {
        expect(error).toMatchObject({ status: 400 });
        expect(String(error)).toContain("does not exist or is not a directory");
      }
    }
  });
});

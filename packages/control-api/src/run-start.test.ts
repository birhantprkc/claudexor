import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findAcceptedAroundPreflight, normalizeExistingProjectRoot } from "./run-start.js";

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

describe("findAcceptedAroundPreflight", () => {
  it("returns a command accepted while a failing mutable preflight was in flight", async () => {
    const accepted = { id: "job-raced" };
    let durable: typeof accepted | null = null;
    let releasePreflight!: () => void;
    const preflightEntered = new Promise<void>((resolve) => {
      releasePreflight = resolve;
    });
    let probes = 0;

    const result = findAcceptedAroundPreflight(
      async () => {
        probes += 1;
        return durable;
      },
      async () => {
        await preflightEntered;
        throw new Error("mutable capability disappeared");
      },
    );
    durable = accepted;
    releasePreflight();

    await expect(result).resolves.toBe(accepted);
    expect(probes).toBe(2);
  });

  it("preserves the original preflight error when the race-closing probe misses", async () => {
    const preflightError = new Error("mutable capability disappeared");
    await expect(
      findAcceptedAroundPreflight(
        async () => null,
        async () => {
          throw preflightError;
        },
      ),
    ).rejects.toBe(preflightError);
  });
});

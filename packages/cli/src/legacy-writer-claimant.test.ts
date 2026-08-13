import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const fixtureRoot = resolve(import.meta.dirname, "fixtures", "legacy-v3.3.7");
const claimantPath = join(fixtureRoot, "writer-claimant.cjs");
const provenancePath = join(fixtureRoot, "provenance.json");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("exact-v3.3.7 legacy writer claimant fixture", () => {
  it("binds the executable fixture to the exact tag/commit/blob/source bytes and parity markers", () => {
    const provenance = JSON.parse(readFileSync(provenancePath, "utf8")) as {
      tag: string;
      commit: string;
      sourcePath: string;
      sourceBlob: string;
      sourceSha256: string;
      fixtureSha256: string;
      parityMarkers: string[];
    };
    expect(provenance).toMatchObject({
      tag: "v3.3.7",
      commit: "a4b004d79d54bfe03735a247c40b297552c2a624",
      sourcePath: "packages/daemon/src/writer-lease.ts",
      sourceBlob: "f2cde81164ee0843b22fb8266e43193d2f05f1eb",
      sourceSha256: "f8bf76956c24bdadec40ff2917f59bc6c2dfff02e15b9f4a4cc14ec9151b8344",
    });
    const source = execFileSync("git", ["show", `${provenance.tag}:${provenance.sourcePath}`], {
      cwd: resolve(import.meta.dirname, "../../.."),
      encoding: "utf8",
    });
    const fixture = readFileSync(claimantPath, "utf8");
    expect(
      execFileSync("git", ["rev-parse", `${provenance.tag}^{commit}`], { encoding: "utf8" }).trim(),
    ).toBe(provenance.commit);
    expect(
      execFileSync("git", ["rev-parse", `${provenance.tag}:${provenance.sourcePath}`], {
        encoding: "utf8",
      }).trim(),
    ).toBe(provenance.sourceBlob);
    expect(sha256(source)).toBe(provenance.sourceSha256);
    expect(sha256(fixture)).toBe(provenance.fixtureSha256);
    for (const marker of provenance.parityMarkers) {
      expect(source, `tag source missing parity marker: ${marker}`).toContain(marker);
      expect(fixture, `fixture missing parity marker: ${marker}`).toContain(marker);
    }
  });

  it("fails before journal/GC when a later opaque barrier occupies the canonical legacy path", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "claudexor-legacy-claimant-"));
    roots.push(dataRoot);
    const daemonRoot = join(dataRoot, "daemon");
    const socketPath = join(daemonRoot, "claudexord.sock");
    const barrier = `${socketPath}.writer`;
    mkdirSync(barrier, { recursive: true, mode: 0o700 });
    const marker = join(barrier, "root-authority-v2.json");
    writeFileSync(marker, '{"schemaVersion":2,"state":"vacant"}\n', { mode: 0o600 });
    const before = readFileSync(marker);

    const result = spawnSync(process.execPath, [claimantPath], {
      cwd: dataRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        CLAUDEXOR_CONFIG_DIR: dataRoot,
        CLAUDEXOR_DAEMON_SOCK: socketPath,
      },
    });

    expect(result.status, result.stderr).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      code: "daemon_writer_busy",
      stage: "writer_claim",
    });
    expect(readFileSync(marker)).toEqual(before);
    expect(() => readFileSync(join(daemonRoot, "journal", "events.log"))).toThrow();
  });
});

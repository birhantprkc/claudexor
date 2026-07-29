import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readPrivateSigningKey } from "../../../scripts/lib/private-signing-key.mjs";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): { key: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "claudexor-signing-key-"));
  roots.push(root);
  const key = join(root, "offline.pem");
  writeFileSync(key, "test-key-bytes", { mode: 0o600 });
  return { key, root };
}

describe("offline private signing-key reads", () => {
  it("reads a same-user regular 0600 file", () => {
    const { key } = fixture();
    expect(readPrivateSigningKey(key)).toBe("test-key-bytes");
  });

  it("refuses group-readable keys and symlink aliases", () => {
    const { key, root } = fixture();
    chmodSync(key, 0o640);
    expect(() => readPrivateSigningKey(key)).toThrow(/exactly 0600/);
    chmodSync(key, 0o600);
    const alias = join(root, "alias.pem");
    symlinkSync(key, alias);
    expect(() => readPrivateSigningKey(alias)).toThrow(/symlink/);
  });

  it("refuses non-regular files", () => {
    const { root } = fixture();
    expect(() => readPrivateSigningKey(root)).toThrow(/regular file/);
  });
});

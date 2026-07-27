import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listRemoteDirectory, readScopedProjectFile } from "./remote-filesystem.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "remote-fs-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("remote filesystem containment", () => {
  it("lists only targets contained by remote home", () => {
    const project = join(root, "project");
    mkdirSync(project);
    writeFileSync(join(project, "README.md"), "hello");
    symlinkSync("/tmp", join(root, "escape"));
    writeFileSync(join(root, "z-file.txt"), "file");
    mkdirSync(join(root, "a-directory"));
    const listing = listRemoteDirectory(root, root);
    expect(listing.entries.map((entry) => entry.name)).toEqual([
      "a-directory",
      "project",
      "z-file.txt",
    ]);
    expect(listing.parent).toBeNull();
    expect(listing.truncated).toBe(false);
  });

  it("discloses a bounded listing instead of silently hiding overflow", () => {
    for (let index = 0; index < 1_001; index += 1) {
      writeFileSync(join(root, `file-${String(index).padStart(4, "0")}`), "");
    }
    const listing = listRemoteDirectory(root, root);
    expect(listing.entries).toHaveLength(1_000);
    expect(listing.truncated).toBe(true);
  });

  it("refuses directory traversal outside home", () => {
    expect(() => listRemoteDirectory("/tmp", root)).toThrow(/escapes/);
  });

  it("fetches a bounded regular project file and refuses traversal", () => {
    const project = join(root, "project");
    mkdirSync(project);
    writeFileSync(join(project, "image.png"), "png");
    const store = {
      get: (id: string) =>
        id === "prj-1"
          ? { id, root: project, schema_version: 3, created_at: "", updated_at: "" }
          : undefined,
    };
    const fetched = readScopedProjectFile(store as never, "prj-1", "image.png");
    expect(fetched.contentType).toBe("image/png");
    expect(fetched.data.toString()).toBe("png");
    expect(() => readScopedProjectFile(store as never, "prj-1", "../outside")).toThrow(
      /contained relative/,
    );
  });

  it("refuses an out-of-project symlink and an oversized regular file", () => {
    const project = join(root, "project");
    mkdirSync(project);
    const outside = join(root, "outside.txt");
    writeFileSync(outside, "secret");
    symlinkSync(outside, join(project, "escape.txt"));
    const large = join(project, "large.bin");
    writeFileSync(large, "");
    truncateSync(large, 25 * 1024 * 1024 + 1);
    const store = {
      get: () => ({
        id: "prj-1",
        root: project,
        schema_version: 3,
        created_at: "",
        updated_at: "",
      }),
    };
    expect(() => readScopedProjectFile(store as never, "prj-1", "escape.txt")).toThrow(/escapes/);
    expect(() => readScopedProjectFile(store as never, "prj-1", "large.bin")).toThrow(
      /fetch limit/,
    );
  });
});

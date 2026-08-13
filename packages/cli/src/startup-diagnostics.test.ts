import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  openDaemonStartupDiagnosticsAfterAuthority,
  readDaemonDiagnosticTail,
  type DaemonStartupDiagnostics,
} from "./startup-diagnostics.js";

const roots: string[] = [];
const writers: DaemonStartupDiagnostics[] = [];

afterEach(() => {
  for (const writer of writers.splice(0)) writer.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "claudexor-startup-diagnostics-"));
  roots.push(value);
  return value;
}

function context(dataRoot: string, launchSource = "cli_ensure_daemon") {
  return {
    runtimeVersion: "3.3.15",
    buildSha: "a".repeat(40),
    entryPath: join(dataRoot, "runtime", "claudexord.js"),
    pid: 4242,
    dataRoot,
    launchSource,
  };
}

function open(
  dataRoot: string,
  overrides: Partial<{
    path: string;
    maxCurrentBytes: number;
    maxRecordBytes: number;
    platform: NodeJS.Platform;
    uid: number;
  }> = {},
): DaemonStartupDiagnostics {
  const path = overrides.path ?? join(dataRoot, "claudexord.log");
  const writer = openDaemonStartupDiagnosticsAfterAuthority(context(dataRoot), {
    path,
    maxCurrentBytes: overrides.maxCurrentBytes ?? 8 * 1024,
    maxRecordBytes: overrides.maxRecordBytes ?? 2 * 1024,
    platform: overrides.platform ?? process.platform,
    uid: overrides.uid ?? process.getuid?.(),
    now: () => new Date("2026-08-13T12:34:56.000Z"),
  });
  writers.push(writer);
  return writer;
}

function records(path: string): Record<string, unknown>[] {
  const text = readFileSync(path, "utf8").trim();
  return text ? text.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>) : [];
}

describe("post-authority daemon startup diagnostics", () => {
  it("creates the canonical current log privately and carries every required launch/stage fact", () => {
    const dataRoot = root();
    const path = join(dataRoot, "claudexord.log");
    const writer = open(dataRoot, { path });

    expect(writer.record({ stage: "root_authority_won", message: "diagnostics online" })).toBe(
      true,
    );
    const [record] = records(path);
    expect(record).toMatchObject({
      timestamp: "2026-08-13T12:34:56.000Z",
      runtimeVersion: "3.3.15",
      buildSha: "a".repeat(40),
      entryPath: context(dataRoot).entryPath,
      pid: 4242,
      dataRoot,
      launchSource: "cli_ensure_daemon",
      stage: "root_authority_won",
      message: "diagnostics online",
    });
    if (process.getuid) expect(lstatSync(path).mode & 0o777).toBe(0o600);
  });

  it("migrates an owner-controlled legacy 0644 current log to 0600 on POSIX", () => {
    if (!process.getuid) return;
    const dataRoot = root();
    const path = join(dataRoot, "claudexord.log");
    writeFileSync(path, "legacy\n", { mode: 0o644 });
    chmodSync(path, 0o644);

    open(dataRoot, { path });

    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toBe("legacy\n");
  });

  it("refuses symlink, non-regular, hard-linked, and foreign-owner ambiguity without repair", () => {
    const dataRoot = root();
    const real = join(dataRoot, "real.log");
    writeFileSync(real, "sentinel\n", { mode: 0o600 });

    const symlink = join(dataRoot, "symlink.log");
    symlinkSync(real, symlink);
    expect(() => open(dataRoot, { path: symlink })).toThrow(/safe|symbolic|owner-controlled/i);
    expect(readFileSync(real, "utf8")).toBe("sentinel\n");

    const directory = join(dataRoot, "directory.log");
    mkdirSync(directory);
    expect(() => open(dataRoot, { path: directory })).toThrow(/regular|safe|owner-controlled/i);

    const linked = join(dataRoot, "linked.log");
    linkSync(real, linked);
    expect(() => open(dataRoot, { path: linked })).toThrow(/singly-linked|owner-controlled|safe/i);

    if (process.getuid) {
      const foreign = join(dataRoot, "foreign.log");
      writeFileSync(foreign, "foreign\n", { mode: 0o600 });
      expect(() =>
        open(dataRoot, { path: foreign, platform: process.platform, uid: process.getuid!() + 1 }),
      ).toThrow(/owner|uid|private/i);
      expect(readFileSync(foreign, "utf8")).toBe("foreign\n");
    }
  });

  it("redacts the full failure before bounding the record and keeps a terminal failure class/stack", () => {
    const dataRoot = root();
    const path = join(dataRoot, "claudexord.log");
    const writer = open(dataRoot, { path, maxCurrentBytes: 4 * 1024, maxRecordBytes: 1024 });
    const token = `ghp_${"s".repeat(36)}`;
    const error = new TypeError(`${"x".repeat(700)} ${token} ${"y".repeat(700)}`);

    expect(
      writer.record({
        stage: "projection_prepare",
        message: `${"m".repeat(700)} ${token} ${"n".repeat(700)}`,
        error,
      }),
    ).toBe(true);

    const raw = readFileSync(path, "utf8");
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(1024);
    expect(raw).not.toContain(token);
    expect(raw).toContain("[redacted]");
    expect(records(path)[0]).toMatchObject({ failureClass: "TypeError" });
  });

  it.each([1023, 1024])("does not rotate a safe existing current file at %i bytes", (size) => {
    const dataRoot = root();
    const path = join(dataRoot, "claudexord.log");
    writeFileSync(path, "x".repeat(size), { mode: 0o600 });
    open(dataRoot, { path, maxCurrentBytes: 1024, maxRecordBytes: 512 });
    expect(lstatSync(path).size).toBe(size);
    expect(existsSync(`${path}.1`)).toBe(false);
  });

  it("bounds a cap+1 legacy current file without retaining oversized bytes", () => {
    const dataRoot = root();
    const path = join(dataRoot, "claudexord.log");
    writeFileSync(path, "z".repeat(1025), { mode: 0o600 });
    open(dataRoot, { path, maxCurrentBytes: 1024, maxRecordBytes: 512 });

    expect(lstatSync(path).size).toBe(0);
    expect(lstatSync(`${path}.1`).size).toBeLessThanOrEqual(1024);
    expect(readFileSync(`${path}.1`, "utf8")).not.toContain("z".repeat(100));
  });

  it("retains only bounded current + one rotation across repeated writes", () => {
    const dataRoot = root();
    const path = join(dataRoot, "claudexord.log");
    const writer = open(dataRoot, { path, maxCurrentBytes: 2048, maxRecordBytes: 512 });
    for (let index = 0; index < 80; index += 1) {
      expect(
        writer.record({ stage: "startup_step", message: `${index}:${"payload".repeat(25)}` }),
      ).toBe(true);
    }

    expect(lstatSync(path).size).toBeLessThanOrEqual(2048);
    expect(lstatSync(`${path}.1`).size).toBeLessThanOrEqual(2048);
    expect(existsSync(`${path}.2`)).toBe(false);
    for (const candidate of [path, `${path}.1`]) {
      for (const line of readFileSync(candidate, "utf8").trim().split("\n")) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    }
  });

  it("serializes same-process writes and refuses a second writer for the same canonical path", async () => {
    const dataRoot = root();
    const path = join(dataRoot, "claudexord.log");
    const writer = open(dataRoot, {
      path,
      maxCurrentBytes: 128 * 1024,
      maxRecordBytes: 1024,
    });
    expect(() => open(dataRoot, { path })).toThrow(/already active|one diagnostic writer/i);

    await Promise.all(
      Array.from({ length: 64 }, (_, index) =>
        Promise.resolve().then(() =>
          writer.record({ stage: "parallel_write", message: `record-${index}` }),
        ),
      ),
    );

    const parsed = records(path);
    expect(parsed).toHaveLength(64);
    expect(new Set(parsed.map((record) => record.message)).size).toBe(64);
  });

  it("reads a safe bounded tail through the same no-follow owner", () => {
    const dataRoot = root();
    const path = join(dataRoot, "claudexord.log");
    const writer = open(dataRoot, {
      path,
      maxCurrentBytes: 128 * 1024,
      maxRecordBytes: 1024,
    });
    for (let index = 0; index < 45; index += 1) {
      writer.record({ stage: "tail", message: `line-${index}` });
    }

    const tail = readDaemonDiagnosticTail({ path, lines: 40 });
    const parsed = tail
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(parsed).toHaveLength(40);
    expect(parsed[0].message).toBe("line-5");
    expect(parsed.at(-1).message).toBe("line-44");
  });

  it("keeps lifecycle safety independent from a diagnostic write after close", () => {
    const dataRoot = root();
    const writer = open(dataRoot);
    writer.close();
    expect(() => writer.record({ stage: "shutdown", message: "late" })).not.toThrow();
    expect(writer.record({ stage: "shutdown", message: "late" })).toBe(false);
    expect(writer.lastFailure()).toMatch(/closed/i);
  });
});

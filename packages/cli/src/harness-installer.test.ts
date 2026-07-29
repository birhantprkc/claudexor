import { existsSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLAUDE_VENDOR_CLI_VERSION } from "@claudexor/harness-claude";
import { CODEX_VENDOR_CLI_VERSION } from "@claudexor/harness-codex";
import { OPENCODE_VENDOR_CLI_VERSION } from "@claudexor/harness-opencode";
import type { ParsedArgs } from "./args.js";
import {
  CURSOR_INSTALL_URL,
  INSTALLABLE_HARNESSES,
  harnessInstallCommand,
  harnessInstallerDisclosure,
  isInstallableHarness,
  runHarnessInstaller,
} from "./harness-installer.js";

const args = (positional: string[], flags: ParsedArgs["flags"] = {}): ParsedArgs => ({
  _: positional,
  flags,
});

const captureStdout = (): { lines: () => string; restore: () => void } => {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  return { lines: () => chunks.join(""), restore: () => spy.mockRestore() };
};

const captureStderr = (): { lines: () => string; restore: () => void } => {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  return { lines: () => chunks.join(""), restore: () => spy.mockRestore() };
};

/** A hostile child: writes vendor noise onto whatever fd its stdout was
 * routed to (fd 2 in json mode, the caller's stdout otherwise) — exactly
 * what real npm/curl/install.sh interleaving looks like. */
const noisySpawn = (status: number) =>
  vi.fn((binary: string, argv: string[], options?: { stdio?: unknown }) => {
    if (binary === "curl") {
      const target = argv.at(-1) ?? "";
      writeFileSync(target, "#!/bin/sh\necho fake-installer\n");
    }
    const stdio = options?.stdio;
    const stdoutTarget = Array.isArray(stdio) && stdio[1] === 2 ? process.stderr : process.stdout;
    stdoutTarget.write("vendor noise: added 42 packages in 3s\n");
    return { status } as never;
  });

afterEach(() => vi.restoreAllMocks());

describe("remote harness installer allowlist", () => {
  it("rejects every non-allowlisted identifier", () => {
    expect(isInstallableHarness("codex")).toBe(true);
    expect(isInstallableHarness("../../bin/sh")).toBe(false);
    expect(isInstallableHarness("codex; touch /tmp/pwned")).toBe(false);
  });
});

describe("pinned versions (issue #89: never @latest)", () => {
  it("every npm harness pins the exact vendor-version SSOT the freshness gates read", () => {
    const pins = {
      claude: CLAUDE_VENDOR_CLI_VERSION,
      codex: CODEX_VENDOR_CLI_VERSION,
      opencode: OPENCODE_VENDOR_CLI_VERSION,
    } as const;
    for (const [harness, version] of Object.entries(pins)) {
      const disclosure = harnessInstallerDisclosure(harness as "claude" | "codex" | "opencode");
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(disclosure.pinnedVersion).toBe(version);
      expect(disclosure.command.endsWith(`@${version}`)).toBe(true);
      expect(disclosure.verification).toBe("npm_registry_integrity");
    }
    for (const harness of INSTALLABLE_HARNESSES) {
      expect(harnessInstallerDisclosure(harness).command).not.toContain("@latest");
    }
  });

  it("discloses the exact command and destination", () => {
    expect(harnessInstallerDisclosure("claude")).toEqual({
      harness: "claude",
      command: `npm install --global --prefix ~/.claudexor/remote/vendor @anthropic-ai/claude-code@${CLAUDE_VENDOR_CLI_VERSION}`,
      installLocation: "~/.claudexor/remote/vendor/bin",
      pinnedVersion: CLAUDE_VENDOR_CLI_VERSION,
      verification: "npm_registry_integrity",
    });
  });

  it("cursor is honestly unpinnable: full download, never piped, human watches the PTY", () => {
    const disclosure = harnessInstallerDisclosure("cursor");
    expect(disclosure.pinnedVersion).toBeNull();
    expect(disclosure.verification).toBe("human_watches_pty");
    expect(disclosure.command).toContain(CURSOR_INSTALL_URL);
    expect(disclosure.command).toContain("--fail");
    expect(disclosure.command).not.toMatch(/\|\s*(\/bin\/)?(ba)?sh/);
  });
});

describe("runHarnessInstaller", () => {
  it("uses typed argv for npm installers with the exact pin under the app-owned prefix", () => {
    const spawn = vi.fn(() => ({ status: 0 }) as never);
    const result = runHarnessInstaller("codex", {
      home: "/tmp/operator",
      nodePath: "/runtime/node/bin/node",
      spawn: spawn as never,
      mkdir: vi.fn(),
      exists: () => true,
    });
    expect(result).toEqual({ exitCode: 0 });
    expect(spawn).toHaveBeenCalledWith(
      "/runtime/node/bin/node",
      [
        "/runtime/node/lib/node_modules/npm/bin/npm-cli.js",
        "install",
        "--global",
        "--prefix",
        "/tmp/operator/.claudexor/remote/vendor",
        `@openai/codex@${CODEX_VENDOR_CLI_VERSION}`,
      ],
      expect.objectContaining({ stdio: "inherit" }),
    );
  });

  it("refuses loudly, naming the expected path, when the bundled npm entrypoint is missing", () => {
    // A Node closure without the bundled npm tree must be a typed refusal
    // BEFORE any spawn — never node's raw "Cannot find module" crash.
    const spawn = vi.fn(() => ({ status: 0 }) as never);
    const result = runHarnessInstaller("codex", {
      home: "/tmp/operator",
      nodePath: "/runtime/node/bin/node",
      spawn: spawn as never,
      mkdir: vi.fn(),
      exists: () => false,
    });
    expect(result.exitCode).toBe(1);
    expect(result.refusal).toContain("/runtime/node/lib/node_modules/npm/bin/npm-cli.js");
    expect(result.refusal).toContain("nothing was executed");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("downloads the Cursor installer, prints its sha256, executes it, and always cleans up", () => {
    const stdout = captureStdout();
    let installerPath = "";
    const spawn = vi.fn((binary: string, argv: string[]) => {
      if (binary === "curl") {
        installerPath = argv.at(-1) ?? "";
        writeFileSync(installerPath, "#!/bin/sh\necho fake-installer\n");
      }
      return { status: 0 } as never;
    });
    const result = runHarnessInstaller("cursor", {
      home: "/tmp/operator",
      spawn: spawn as never,
    });
    stdout.restore();
    expect(result).toEqual({ exitCode: 0 });
    expect(spawn).toHaveBeenNthCalledWith(
      1,
      "curl",
      [
        "--fail",
        "--silent",
        "--show-error",
        "--location",
        CURSOR_INSTALL_URL,
        "--output",
        installerPath,
      ],
      expect.objectContaining({ stdio: "inherit" }),
    );
    expect(spawn).toHaveBeenNthCalledWith(
      2,
      "/bin/sh",
      [installerPath],
      expect.objectContaining({ stdio: "inherit" }),
    );
    expect(stdout.lines()).toMatch(/cursor installer downloaded: \d+ bytes, sha256 [0-9a-f]{64}/);
    expect(existsSync(dirname(installerPath))).toBe(false);
  });

  it("refuses loudly on a failed Cursor download and still removes the temp dir", () => {
    let installerPath = "";
    const spawn = vi.fn((binary: string, argv: string[]) => {
      if (binary === "curl") installerPath = argv.at(-1) ?? "";
      return { status: 22 } as never;
    });
    const result = runHarnessInstaller("cursor", { spawn: spawn as never });
    expect(result.exitCode).toBe(22);
    expect(result.refusal).toContain("nothing was executed");
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(existsSync(dirname(installerPath))).toBe(false);
  });

  it("refuses to execute a Cursor script it cannot read back", () => {
    // curl "succeeds" but writes nothing — the read-back gate must refuse.
    const spawn = vi.fn(() => ({ status: 0 }) as never);
    const result = runHarnessInstaller("cursor", { spawn: spawn as never });
    expect(result.exitCode).toBe(1);
    expect(result.refusal).toContain("could not be read back");
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});

describe("harnessInstallCommand disclosure/confirmation gate", () => {
  it("--dry-run prints the typed disclosure and executes nothing", () => {
    const stdout = captureStdout();
    const code = harnessInstallCommand(
      args(["harness", "install", "codex"], { "dry-run": true }),
      true,
    );
    stdout.restore();
    const payload = JSON.parse(stdout.lines()) as Record<string, unknown>;
    expect(code).toBe(0);
    expect(payload).toMatchObject({
      ok: true,
      dryRun: true,
      harness: "codex",
      pinnedVersion: CODEX_VENDOR_CLI_VERSION,
      installLocation: "~/.claudexor/remote/vendor/bin",
    });
  });

  it("refuses without --yes when no human can confirm (json mode / no TTY)", () => {
    const stdout = captureStdout();
    const code = harnessInstallCommand(args(["harness", "install", "claude"]), true);
    stdout.restore();
    const payload = JSON.parse(stdout.lines()) as Record<string, unknown>;
    expect(code).toBe(1);
    expect(payload).toMatchObject({ ok: false, code: "confirmation_required" });
  });

  it("rejects non-allowlisted or malformed install targets with usage exit 2", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(harnessInstallCommand(args(["harness", "install", "rm -rf /"]), false)).toBe(2);
    expect(harnessInstallCommand(args(["harness", "install"]), false)).toBe(2);
    expect(harnessInstallCommand(args(["harness", "install", "codex", "extra"]), false)).toBe(2);
    stderr.mockRestore();
  });

  it("the opencode disclosure names its pin a deterministic target, not a verified version", () => {
    const stdout = captureStdout();
    const stderr = captureStderr();
    harnessInstallCommand(args(["harness", "install", "opencode"], { "dry-run": true }), false);
    harnessInstallCommand(args(["harness", "install", "claude"], { "dry-run": true }), false);
    stdout.restore();
    stderr.restore();
    const lines = stdout.lines();
    expect(lines).toContain(
      "deterministic install target — not covered by recorded verification fixtures",
    );
    expect(lines).toContain(
      `${CLAUDE_VENDOR_CLI_VERSION} (exact; the version this release was verified against`,
    );
  });
});

describe("--json stdout purity on the execute path (--yes)", () => {
  const jsonYesInstall = (
    harness: string,
    status: number,
  ): { code: number; stdout: string; stderr: string } => {
    const stdout = captureStdout();
    const stderr = captureStderr();
    const code = harnessInstallCommand(args(["harness", "install", harness], { yes: true }), true, {
      home: "/tmp/operator",
      nodePath: "/runtime/node/bin/node",
      spawn: noisySpawn(status) as never,
      mkdir: vi.fn(),
      exists: () => true,
    });
    stdout.restore();
    stderr.restore();
    return { code, stdout: stdout.lines(), stderr: stderr.lines() };
  };

  it("a successful npm install emits EXACTLY one JSON object on stdout; vendor noise lands on stderr", () => {
    const result = jsonYesInstall("codex", 0);
    expect(result.code).toBe(0);
    // The whole stdout parses as one object — a machine caller's JSON.parse
    // must survive a child that sprays garbage at its own stdout.
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({ ok: true, dryRun: false, exitCode: 0, harness: "codex" });
    expect(result.stdout).not.toContain("vendor noise");
    expect(result.stderr).toContain("vendor noise");
  });

  it("a failed install keeps stdout to the single {ok:false} envelope", () => {
    const result = jsonYesInstall("codex", 7);
    expect(result.code).toBe(7);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({ ok: false, dryRun: false, exitCode: 7 });
    expect(result.stdout).not.toContain("vendor noise");
  });

  it("the cursor path routes its sha256/running progress lines to stderr under --json", () => {
    const result = jsonYesInstall("cursor", 0);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({ ok: true, dryRun: false, exitCode: 0, harness: "cursor" });
    expect(result.stdout).not.toContain("cursor installer downloaded");
    expect(result.stderr).toMatch(/cursor installer downloaded: \d+ bytes, sha256 [0-9a-f]{64}/);
    expect(result.stderr).toContain("running: /bin/sh ");
  });

  it("human (non-json) mode keeps the cursor progress lines on stdout", () => {
    const stdout = captureStdout();
    const spawn = noisySpawn(0);
    runHarnessInstaller("cursor", { home: "/tmp/operator", spawn: spawn as never });
    stdout.restore();
    expect(stdout.lines()).toMatch(/cursor installer downloaded: \d+ bytes, sha256 [0-9a-f]{64}/);
    expect(stdout.lines()).toContain("vendor noise");
  });
});

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
});

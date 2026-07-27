import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  harnessInstallerDisclosure,
  isInstallableHarness,
  runHarnessInstaller,
} from "./harness-installer.js";

describe("remote harness installer allowlist", () => {
  it("rejects every non-allowlisted identifier", () => {
    expect(isInstallableHarness("codex")).toBe(true);
    expect(isInstallableHarness("../../bin/sh")).toBe(false);
    expect(isInstallableHarness("codex; touch /tmp/pwned")).toBe(false);
  });

  it("uses typed argv for npm installers under the app-owned prefix", () => {
    const spawn = vi.fn(() => ({ status: 0 }) as never);
    runHarnessInstaller("codex", {
      home: "/tmp/operator",
      nodePath: "/runtime/node/bin/node",
      spawn: spawn as never,
      mkdir: vi.fn(),
    });
    expect(spawn).toHaveBeenCalledWith(
      "/runtime/node/bin/node",
      [
        "/runtime/node/lib/node_modules/npm/bin/npm-cli.js",
        "install",
        "--global",
        "--prefix",
        "/tmp/operator/.claudexor/remote/vendor",
        "@openai/codex@latest",
      ],
      expect.objectContaining({ stdio: "inherit" }),
    );
  });

  it("discloses the exact command and destination", () => {
    expect(harnessInstallerDisclosure("claude", "/tmp/operator")).toEqual({
      harness: "claude",
      command:
        "npm install --global --prefix ~/.claudexor/remote/vendor @anthropic-ai/claude-code@latest",
      installLocation: "~/.claudexor/remote/vendor/bin",
    });
  });

  it("downloads the Cursor installer with HTTP failure handling and always cleans it up", () => {
    let installerPath = "";
    const spawn = vi.fn((binary: string, args: string[]) => {
      if (binary === "curl") installerPath = args.at(-1) ?? "";
      return { status: 0 } as never;
    });
    runHarnessInstaller("cursor", {
      home: "/tmp/operator",
      spawn: spawn as never,
    });
    expect(spawn).toHaveBeenNthCalledWith(
      1,
      "curl",
      [
        "--fail",
        "--silent",
        "--show-error",
        "--location",
        "https://cursor.com/install",
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
    expect(existsSync(dirname(installerPath))).toBe(false);
  });

  it("does not execute a failed Cursor download and still removes its temporary file", () => {
    let installerPath = "";
    const spawn = vi.fn((binary: string, args: string[]) => {
      if (binary === "curl") installerPath = args.at(-1) ?? "";
      return { status: 22 } as never;
    });
    expect(runHarnessInstaller("cursor", { spawn: spawn as never }).status).toBe(22);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(existsSync(dirname(installerPath))).toBe(false);
  });
});

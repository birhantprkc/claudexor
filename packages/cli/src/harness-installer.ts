/**
 * `claudexor harness install` — the disclosed, pinned remote vendor installer
 * (issue #89; restored from the PR #82 cut with the security objections
 * fixed).
 *
 * Contract:
 * - npm-distributed harnesses (claude/codex/opencode) install ONE exact
 *   version — the per-package vendor-version SSOT — never `@latest`. npm
 *   verifies the registry integrity checksum for an exact version, so the
 *   pin is a real guarantee. For claude/codex that SSOT is the value the
 *   model/effort freshness gates verified; the opencode pin is a
 *   deterministic install target, NOT a verification claim (no recorded
 *   fixture yet — see packages/harness-opencode vendor-cli-version.ts).
 * - cursor has no npm artifact and CANNOT be pinned. Instead of pretending,
 *   the HUMAN is the verifier: the complete vendor script is downloaded first
 *   (never piped to a shell), its size and sha256 are printed, and it runs in
 *   the visible PTY the operator is watching — the same principle as
 *   interactive SSH auth.
 * - NOTHING executes without disclosure: the exact command and install
 *   destination print first, and execution needs a TTY confirmation or an
 *   explicit `--yes` (the macOS flow confirms against this module's own
 *   `--dry-run --json` disclosure before passing `--yes`).
 * - failures are typed and loud; a failed download or non-zero installer exit
 *   never reads as success, and the temp download dir is removed on every
 *   path.
 * - `--json` keeps stdout pure: exactly ONE JSON object. In json mode every
 *   human progress line goes to stderr and child processes (npm/curl/the
 *   vendor script) run with their stdout routed onto stderr, so vendor
 *   output stays visible without corrupting the machine envelope.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CLAUDE_VENDOR_CLI_VERSION } from "@claudexor/harness-claude";
import { CODEX_VENDOR_CLI_VERSION } from "@claudexor/harness-codex";
import { OPENCODE_VENDOR_CLI_VERSION } from "@claudexor/harness-opencode";
import type { PinnedVendorCliVersion } from "@claudexor/util";
import { flagBool, type ParsedArgs } from "./args.js";
import { print, printJson, printUsageError } from "./cli-io.js";

export const INSTALLABLE_HARNESSES = ["claude", "codex", "cursor", "opencode"] as const;
export type InstallableHarness = (typeof INSTALLABLE_HARNESSES)[number];

export function isInstallableHarness(value: string): value is InstallableHarness {
  return INSTALLABLE_HARNESSES.includes(value as InstallableHarness);
}

/** Exact npm pins. Each version ALIASES the harness package's vendor-version
 * SSOT (vendor-cli-version.ts there). For claude/codex that is the version
 * this release's freshness gates verified; the opencode pin is a
 * deterministic install target only — no recorded verification fixture
 * vouches for it (its vendor-cli-version.ts discloses this). Cursor is
 * absent deliberately: it ships no npm artifact (see the cursor branch
 * below). */
export type HarnessInstallVerification =
  "release_verified" | "deterministic_only" | "human_observed";

const NPM_PINS: Partial<
  Record<
    InstallableHarness,
    {
      npmPackage: string;
      version: PinnedVendorCliVersion;
      verification: Exclude<HarnessInstallVerification, "human_observed">;
    }
  >
> = {
  claude: {
    npmPackage: "@anthropic-ai/claude-code",
    version: CLAUDE_VENDOR_CLI_VERSION,
    verification: "release_verified",
  },
  codex: {
    npmPackage: "@openai/codex",
    version: CODEX_VENDOR_CLI_VERSION,
    verification: "release_verified",
  },
  opencode: {
    npmPackage: "opencode-ai",
    version: OPENCODE_VENDOR_CLI_VERSION,
    verification: "deterministic_only",
  },
};

export const CURSOR_INSTALL_URL = "https://cursor.com/install";

export interface HarnessInstallerDisclosure {
  harness: InstallableHarness;
  command: string;
  installLocation: string;
  /** Exact vendor version the command installs; null ONLY for cursor, which
   * has no pinnable artifact (disclosed, never faked). */
  pinnedVersion: string | null;
  /** Evidence behind the install target. Package-registry integrity verifies
   * downloaded bytes for every npm pin, but only release_verified means the
   * exact vendor version was exercised by this release's freshness gates. */
  verification: HarnessInstallVerification;
}

export function harnessInstallerDisclosure(
  harness: InstallableHarness,
): HarnessInstallerDisclosure {
  const pin = NPM_PINS[harness];
  if (pin) {
    return {
      harness,
      command: `npm install --global --prefix ~/.claudexor/remote/vendor ${pin.npmPackage}@${pin.version}`,
      installLocation: "~/.claudexor/remote/vendor/bin",
      pinnedVersion: pin.version,
      verification: pin.verification,
    };
  }
  return {
    harness,
    command:
      `curl --fail --silent --show-error --location ${CURSOR_INSTALL_URL} ` +
      "--output <private-tmpdir>/install.sh && /bin/sh <private-tmpdir>/install.sh",
    installLocation: "~/.local/bin (or ~/.cursor/bin, as selected by Cursor's installer)",
    pinnedVersion: null,
    verification: "human_observed",
  };
}

export interface HarnessInstallRunResult {
  exitCode: number;
  /** Set when the installer refused loudly WITHOUT running the vendor
   * payload (failed/unreadable download); never a silent partial install. */
  refusal?: string;
}

export function runHarnessInstaller(
  harness: InstallableHarness,
  options: {
    home?: string;
    nodePath?: string;
    spawn?: typeof spawnSync;
    mkdir?: typeof mkdirSync;
    exists?: typeof existsSync;
    /** `--json` stdout purity: route human progress lines AND child stdout
     * to stderr, so stdout carries exactly one JSON object (the caller's
     * final envelope). Human mode keeps everything on stdout as before. */
    json?: boolean;
  } = {},
): HarnessInstallRunResult {
  const home = resolve(options.home ?? homedir());
  const spawn = options.spawn ?? spawnSync;
  const json = options.json === true;
  // stdin inherited; child stdout -> OUR stderr (fd 2) in json mode so
  // vendor/npm output stays visible but never pollutes the JSON envelope.
  const childStdio: "inherit" | [number, number, number] = json ? [0, 2, 2] : "inherit";
  const note = (line: string): void => {
    if (json) process.stderr.write(line + "\n");
    else print(line);
  };
  const environment = { ...process.env, HOME: home };
  const pin = NPM_PINS[harness];
  if (pin) {
    const vendorRoot = join(home, ".claudexor", "remote", "vendor");
    (options.mkdir ?? mkdirSync)(vendorRoot, { recursive: true, mode: 0o700 });
    const nodePath = resolve(options.nodePath ?? process.execPath);
    const npmCLI = resolve(
      dirname(nodePath),
      "..",
      "lib",
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    );
    if (!(options.exists ?? existsSync)(npmCLI)) {
      return {
        exitCode: 1,
        refusal:
          `the bundled npm entrypoint is missing at ${npmCLI} ` +
          "(expected inside the pinned Node runtime next to this CLI); nothing was executed",
      };
    }
    const result = spawn(
      nodePath,
      [npmCLI, "install", "--global", "--prefix", vendorRoot, `${pin.npmPackage}@${pin.version}`],
      { stdio: childStdio, env: environment },
    );
    return { exitCode: result.status ?? 1 };
  }
  // Cursor: download the COMPLETE vendor script before execution (`--fail`
  // rejects HTTP error bodies), read it back and print its size + sha256 so
  // the watching human sees exactly which bytes are about to run, and remove
  // the private temp dir on every success/failure path.
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "claudexor-cursor-install-"));
  const installerPath = join(temporaryDirectory, "install.sh");
  try {
    const downloaded = spawn(
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
      { stdio: childStdio, env: environment },
    );
    if (downloaded.status !== 0) {
      return {
        exitCode: downloaded.status ?? 1,
        refusal: `the download of ${CURSOR_INSTALL_URL} failed (curl exit ${downloaded.status ?? "unknown"}); nothing was executed`,
      };
    }
    let script: Buffer;
    try {
      script = readFileSync(installerPath);
    } catch {
      return {
        exitCode: 1,
        refusal: "the downloaded installer script could not be read back; nothing was executed",
      };
    }
    note(
      `cursor installer downloaded: ${script.length} bytes, ` +
        `sha256 ${createHash("sha256").update(script).digest("hex")}`,
    );
    note(`running: /bin/sh ${installerPath}`);
    const executed = spawn("/bin/sh", [installerPath], { stdio: childStdio, env: environment });
    return { exitCode: executed.status ?? 1 };
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

const INSTALL_USAGE =
  "usage: claudexor harness install <claude|codex|cursor|opencode> [--dry-run] [--yes]";

function pinDisclosureLine(disclosure: HarnessInstallerDisclosure): string {
  if (disclosure.pinnedVersion === null) {
    return "Version pin:      none — Cursor ships no pinnable npm artifact; the vendor script is downloaded in full, its size and sha256 print, and it runs in this terminal where you watch it";
  }
  if (disclosure.verification === "deterministic_only") {
    return `Version pin:      ${disclosure.pinnedVersion} (exact; deterministic install target — not covered by recorded verification fixtures; npm verifies its registry integrity checksum)`;
  }
  return `Version pin:      ${disclosure.pinnedVersion} (exact; the version this release was verified against — npm verifies its registry integrity checksum)`;
}

function printHumanDisclosure(disclosure: HarnessInstallerDisclosure): void {
  print(`Harness:          ${disclosure.harness}`);
  print(`Command:          ${disclosure.command}`);
  print(`Install location: ${disclosure.installLocation}`);
  print(pinDisclosureLine(disclosure));
}

/** Blocking y/N read on the controlling TTY (fd 0). Anything but an explicit
 * yes declines — closing stdin or an unreadable terminal never installs. */
function confirmOnTty(question: string): boolean {
  process.stdout.write(question);
  const buffer = Buffer.alloc(1024);
  let input = "";
  while (!input.includes("\n")) {
    let bytesRead = 0;
    try {
      bytesRead = readSync(0, buffer, 0, buffer.length, null);
    } catch {
      return false;
    }
    if (bytesRead === 0) break;
    input += buffer.toString("utf8", 0, bytesRead);
  }
  return /^y(es)?$/i.test(input.trim());
}

export function harnessInstallCommand(
  args: ParsedArgs,
  json: boolean,
  /** Test seam: forwarded to `runHarnessInstaller` (spawn/home/... fakes). */
  runnerOptions: Omit<NonNullable<Parameters<typeof runHarnessInstaller>[1]>, "json"> = {},
): number {
  const harness = args._[2] ?? "";
  if (!isInstallableHarness(harness) || args._.length !== 3) {
    return printUsageError(json, INSTALL_USAGE);
  }
  const disclosure = harnessInstallerDisclosure(harness);
  if (flagBool(args, "dry-run")) {
    if (json) printJson({ ok: true, dryRun: true, ...disclosure });
    else printHumanDisclosure(disclosure);
    return 0;
  }
  // Disclosure precedes EVERY execution path; --json without --yes refuses
  // (machine callers must have shown the dry-run disclosure themselves).
  if (!json) printHumanDisclosure(disclosure);
  if (!flagBool(args, "yes")) {
    if (json || !process.stdin.isTTY) {
      if (json) {
        printJson({
          ok: false,
          exitCode: 1,
          code: "confirmation_required",
          message: "pass --yes after showing the --dry-run disclosure, or run on a TTY",
          ...disclosure,
        });
      } else {
        print("Not installing: confirm with --yes, or run on an interactive terminal to be asked.");
      }
      return 1;
    }
    if (!confirmOnTty(`Run this installer for ${harness}? [y/N] `)) {
      print("Cancelled; nothing was installed.");
      return 1;
    }
  }
  const result = runHarnessInstaller(harness, { ...runnerOptions, json });
  const ok = result.exitCode === 0 && result.refusal === undefined;
  if (json) {
    printJson({
      ok,
      dryRun: false,
      exitCode: result.exitCode,
      ...(result.refusal === undefined ? {} : { refusal: result.refusal }),
      ...disclosure,
    });
  } else if (result.refusal !== undefined) {
    print(`Install refused: ${result.refusal}`);
  } else if (!ok) {
    print(`Installer exited with code ${result.exitCode}; ${harness} was NOT installed cleanly.`);
  } else {
    print(`Installer finished. Run \`claudexor doctor\` to verify ${harness}.`);
  }
  return ok ? 0 : result.exitCode === 0 ? 1 : result.exitCode;
}

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
 * - cursor and agy have no npm artifact and CANNOT be pinned. Instead of
 *   pretending, the HUMAN is the verifier: the complete vendor script is
 *   downloaded first (never piped to a shell), its size and sha256 are
 *   printed, and it runs in the visible PTY the operator is watching — the
 *   same principle as interactive SSH auth.
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
import { composeBaseEnv } from "@claudexor/core";
import type { PinnedVendorCliVersion } from "@claudexor/util";
import { flagBool, type ParsedArgs } from "./args.js";
import { print, printJson, printUsageError } from "./cli-io.js";
import { INSTALLABLE_HARNESSES } from "./harness-command-specs.js";

export type InstallableHarness = (typeof INSTALLABLE_HARNESSES)[number];

export function isInstallableHarness(value: string): value is InstallableHarness {
  return INSTALLABLE_HARNESSES.includes(value as InstallableHarness);
}

/** Exact npm pins. Each version ALIASES the harness package's vendor-version
 * SSOT (vendor-cli-version.ts there). For claude/codex that is the version
 * this release's freshness gates verified; the opencode pin is a
 * deterministic install target only — no recorded verification fixture
 * vouches for it (its vendor-cli-version.ts discloses this). Cursor and agy
 * are absent deliberately: they ship no npm artifact (see SCRIPT_INSTALLERS
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
/**
 * Google's official Antigravity CLI installer, as published on
 * antigravity.google/docs/cli/install (`curl -fsSL <this url> | bash`, which
 * Claudexor deliberately does NOT do — see the header). Verified end to end on
 * 2026-08-16: the script fetched from this URL installed agy 1.1.13 to
 * `~/.local/bin/agy`, which is the destination disclosed below. The vendor
 * ships one signed Go binary and no npm package, so it takes the same
 * human-observed path as cursor.
 */
export const AGY_INSTALL_URL = "https://antigravity.google/cli/install.sh";
/** The vendor's Windows installer, from the same documentation page. */
export const AGY_INSTALL_URL_WINDOWS = "https://antigravity.google/cli/install.ps1";

/** Vendors distributed as a shell installer instead of a pinnable npm
 * artifact. ONE branch serves both entries; the per-harness text below is the
 * only thing that differs, so a third such vendor is a row, not a fork. */
const SCRIPT_INSTALLERS: Record<
  "agy" | "cursor",
  { url: string; windowsUrl?: string; installLocation: string; pinNote: string }
> = {
  agy: {
    url: AGY_INSTALL_URL,
    // The one vendor here that publishes a Windows installer of its own; the
    // POSIX row would otherwise be all Claudexor could honestly offer.
    windowsUrl: AGY_INSTALL_URL_WINDOWS,
    installLocation: "~/.local/bin (as selected by Google's Antigravity installer)",
    pinNote:
      "none — Antigravity ships no pinnable npm artifact; the vendor script is downloaded in full, its size and sha256 print, and it runs in this terminal where you watch it",
  },
  cursor: {
    url: CURSOR_INSTALL_URL,
    installLocation: "~/.local/bin (or ~/.cursor/bin, as selected by Cursor's installer)",
    pinNote:
      "none — Cursor ships no pinnable npm artifact; the vendor script is downloaded in full, its size and sha256 print, and it runs in this terminal where you watch it",
  },
};

type ScriptInstaller = (typeof SCRIPT_INSTALLERS)[keyof typeof SCRIPT_INSTALLERS];

/** Membership is asked of the TABLE, never re-typed: a third script vendor is
 * one row, and cannot be added to the table yet fall through here. */
function scriptInstaller(harness: InstallableHarness): ScriptInstaller | null {
  return Object.hasOwn(SCRIPT_INSTALLERS, harness)
    ? SCRIPT_INSTALLERS[harness as keyof typeof SCRIPT_INSTALLERS]
    : null;
}

export interface HarnessInstallerDisclosure {
  harness: InstallableHarness;
  command: string;
  installLocation: string;
  /** Exact vendor version the command installs; null exactly for the script
   * vendors (cursor, agy), which have no pinnable artifact — disclosed, never
   * faked. */
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
  const script = scriptInstaller(harness);
  /* c8 ignore next -- every non-npm harness has a script row; this is the
     unreachable guard that keeps the two tables honest. */
  if (!script) throw new Error(`harness ${harness} has neither an npm pin nor a script installer`);
  const windows = process.platform === "win32";
  const url = windows ? (script.windowsUrl ?? script.url) : script.url;
  const file = windows && script.windowsUrl ? "install.ps1" : "install.sh";
  const runner =
    windows && script.windowsUrl ? "powershell -ExecutionPolicy Bypass -File" : "/bin/sh";
  return {
    harness,
    command:
      `curl --fail --silent --show-error --location ${url} ` +
      `--output <private-tmpdir>/${file} && ${runner} <private-tmpdir>/${file}`,
    installLocation:
      windows && script.windowsUrl
        ? "%LOCALAPPDATA%\\agy\\bin (as selected by Google's Antigravity installer)"
        : script.installLocation,
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
  // Vendor-controlled npm/curl/shell children receive the shared minimal
  // runtime env, never the parent process's provider credentials.
  const environment = { ...composeBaseEnv("clean"), HOME: home };
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
  // Script vendors (cursor, agy): download the COMPLETE vendor script before
  // execution (`--fail` rejects HTTP error bodies), read it back and print its
  // size + sha256 so the watching human sees exactly which bytes are about to
  // run, and remove the private temp dir on every success/failure path.
  const script = scriptInstaller(harness);
  /* c8 ignore next */
  if (!script) return { exitCode: 1, refusal: `no installer is defined for ${harness}` };
  const windows = process.platform === "win32";
  const useWindowsScript = windows && script.windowsUrl !== undefined;
  const url = useWindowsScript ? script.windowsUrl! : script.url;
  if (windows && !useWindowsScript) {
    return {
      exitCode: 1,
      refusal: `${harness} publishes no Windows installer; install it yourself and re-run \`claudexor doctor\``,
    };
  }
  const temporaryDirectory = mkdtempSync(join(tmpdir(), `claudexor-${harness}-install-`));
  const installerPath = join(temporaryDirectory, useWindowsScript ? "install.ps1" : "install.sh");
  try {
    const downloaded = spawn(
      "curl",
      // `url`, never `script.url`: on Windows the disclosure names the
      // vendor's PowerShell installer, and the bytes fetched MUST be the bytes
      // disclosed — both reviewers of the sprint triad caught the divergence.
      ["--fail", "--silent", "--show-error", "--location", url, "--output", installerPath],
      { stdio: childStdio, env: environment },
    );
    if (downloaded.status !== 0) {
      return {
        exitCode: downloaded.status ?? 1,
        refusal: `the download of ${url} failed (curl exit ${downloaded.status ?? "unknown"}); nothing was executed`,
      };
    }
    let payload: Buffer;
    try {
      payload = readFileSync(installerPath);
    } catch {
      return {
        exitCode: 1,
        refusal: "the downloaded installer script could not be read back; nothing was executed",
      };
    }
    note(
      `${harness} installer downloaded: ${payload.length} bytes, ` +
        `sha256 ${createHash("sha256").update(payload).digest("hex")}`,
    );
    const runner: [string, string[]] = useWindowsScript
      ? ["powershell", ["-ExecutionPolicy", "Bypass", "-File", installerPath]]
      : ["/bin/sh", [installerPath]];
    note(`running: ${runner[0]} ${runner[1].join(" ")}`);
    const executed = spawn(runner[0], runner[1], { stdio: childStdio, env: environment });
    return { exitCode: executed.status ?? 1 };
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

const INSTALL_USAGE = `usage: claudexor harness install <${INSTALLABLE_HARNESSES.join("|")}> [--dry-run] [--yes]`;

function pinDisclosureLine(disclosure: HarnessInstallerDisclosure): string {
  if (disclosure.pinnedVersion === null) {
    return `Version pin:      ${scriptInstaller(disclosure.harness)?.pinNote ?? "none"}`;
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

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { flagBool, type ParsedArgs } from "./args.js";
import { print, printJson, printUsageError } from "./cli-io.js";
import { buildRegistry } from "./registry.js";

export const INSTALLABLE_HARNESSES = ["claude", "codex", "cursor", "opencode"] as const;
export type InstallableHarness = (typeof INSTALLABLE_HARNESSES)[number];

export interface HarnessInstallerDisclosure {
  harness: InstallableHarness;
  command: string;
  installLocation: string;
}

const NPM_PACKAGES: Partial<Record<InstallableHarness, string>> = {
  claude: "@anthropic-ai/claude-code@latest",
  codex: "@openai/codex@latest",
  opencode: "opencode-ai@latest",
};

export function isInstallableHarness(value: string): value is InstallableHarness {
  return INSTALLABLE_HARNESSES.includes(value as InstallableHarness);
}

export function harnessInstallerDisclosure(
  harness: InstallableHarness,
  home = homedir(),
): HarnessInstallerDisclosure {
  void home;
  const npmPackage = NPM_PACKAGES[harness];
  if (npmPackage) {
    return {
      harness,
      command: `npm install --global --prefix ~/.claudexor/remote/vendor ${npmPackage}`,
      installLocation: "~/.claudexor/remote/vendor/bin",
    };
  }
  return {
    harness,
    command:
      'tmp=$(mktemp); trap \'rm -f "$tmp"\' EXIT; curl --fail --silent --show-error --location https://cursor.com/install --output "$tmp" && /bin/sh "$tmp"',
    installLocation: "~/.local/bin (or ~/.cursor/bin, as selected by Cursor's installer)",
  };
}

export function runHarnessInstaller(
  harness: InstallableHarness,
  options: {
    home?: string;
    nodePath?: string;
    spawn?: typeof spawnSync;
    mkdir?: typeof mkdirSync;
  } = {},
): SpawnSyncReturns<Buffer> {
  const home = resolve(options.home ?? homedir());
  const spawn = options.spawn ?? spawnSync;
  const npmPackage = NPM_PACKAGES[harness];
  if (npmPackage) {
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
    return spawn(nodePath, [npmCLI, "install", "--global", "--prefix", vendorRoot, npmPackage], {
      stdio: "inherit",
      env: { ...process.env, HOME: home },
    });
  }
  // Download the complete vendor script before execution. `--fail` rejects
  // HTTP error bodies, and the private temporary directory is removed on every
  // success/failure path instead of leaving executable installer bytes behind.
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "claudexor-cursor-install-"));
  const installerPath = join(temporaryDirectory, "install.sh");
  const environment = { ...process.env, HOME: home };
  try {
    const downloaded = spawn(
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
      { stdio: "inherit", env: environment },
    );
    if (downloaded.status !== 0) return downloaded;
    return spawn("/bin/sh", [installerPath], {
      stdio: "inherit",
      env: environment,
    });
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function harnessInstallCommand(args: ParsedArgs, json: boolean): number {
  const harness = args._[2] ?? "";
  if (!isInstallableHarness(harness) || args._.length !== 3) {
    return printUsageError(
      json,
      "usage: claudexor harness install <claude|codex|cursor|opencode> [--dry-run]",
    );
  }
  const disclosure = harnessInstallerDisclosure(harness);
  if (flagBool(args, "dry-run")) {
    if (json) printJson({ ok: true, dryRun: true, ...disclosure });
    else {
      print(`Command: ${disclosure.command}`);
      print(`Install location: ${disclosure.installLocation}`);
    }
    return 0;
  }
  const result = runHarnessInstaller(harness);
  const status = result.status ?? 1;
  if (json) {
    printJson({
      ok: status === 0,
      dryRun: false,
      exitCode: status,
      ...disclosure,
    });
  }
  return status;
}

export function harnessCommand(args: ParsedArgs, json: boolean): number {
  const subcommand = args._[1];
  if (subcommand === "list") {
    const includeFakes = flagBool(args, "all");
    const ids = [...buildRegistry({ includeFakes }).keys()];
    if (json) printJson({ harnesses: ids });
    else ids.forEach((id) => print(id));
    return 0;
  }
  if (subcommand === "install") {
    return harnessInstallCommand(args, json);
  }
  return printUsageError(
    json,
    "usage: claudexor harness list [--all] | install <claude|codex|cursor|opencode>",
  );
}

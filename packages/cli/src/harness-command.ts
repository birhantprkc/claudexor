import { flagBool, type ParsedArgs } from "./args.js";
import { print, printJson, printUsageError } from "./cli-io.js";
import { harnessInstallCommand } from "./harness-installer.js";
import { buildRegistry } from "./registry.js";

/**
 * `claudexor harness list [--all]` and `claudexor harness install <id>`.
 * Fakes are test fixtures, not real harnesses; `--all` reveals them. The
 * install verb is the disclosed pinned installer (harness-installer.ts,
 * issue #89): exact npm pins for claude/codex/opencode, the human-verified
 * PTY path for cursor, and nothing executes without disclosure.
 */
export function harnessCommand(args: ParsedArgs, json: boolean): number {
  if (args._[1] === "list") {
    const includeFakes = flagBool(args, "all");
    const ids = [...buildRegistry({ includeFakes }).keys()];
    if (json) printJson({ harnesses: ids });
    else ids.forEach((id) => print(id));
    return 0;
  }
  if (args._[1] === "install") {
    return harnessInstallCommand(args, json);
  }
  return printUsageError(
    json,
    "usage: claudexor harness list [--all] | install <claude|codex|cursor|opencode> [--dry-run] [--yes]",
  );
}

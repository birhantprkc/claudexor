import { flagBool, type ParsedArgs } from "./args.js";
import { print, printJson, printUsageError } from "./cli-io.js";
import { buildRegistry } from "./registry.js";

/**
 * `claudexor harness list [--all]` — the only harness verb. Fakes are test
 * fixtures, not real harnesses; `--all` reveals them. (The former
 * `harness install` remote vendor installer was cut: it executed unverified
 * curl|sh / npm@latest payloads on the remote host — a verified install UX is
 * a follow-up owner decision.)
 */
export function harnessCommand(args: ParsedArgs, json: boolean): number {
  if (args._[1] === "list") {
    const includeFakes = flagBool(args, "all");
    const ids = [...buildRegistry({ includeFakes }).keys()];
    if (json) printJson({ harnesses: ids });
    else ids.forEach((id) => print(id));
    return 0;
  }
  return printUsageError(json, "usage: claudexor harness list [--all]");
}

/**
 * Registry-driven flag-scope validation (INV-021 fail-loud flags): a KNOWN
 * flag outside its command's — or its dispatched subcommand's — declared set
 * is a loud usage error, never silently ignored. The data lives in
 * `command-registry.ts` (`flags` / `subcommandFlags`); this module only
 * projects it.
 */
import { CLI_COMMANDS } from "./command-registry.js";

export function commandFlagScopeError(
  commandId: string,
  flagNames: readonly string[],
): string | null {
  const cmd = CLI_COMMANDS.find((c) => c.id === commandId || (c.aliases ?? []).includes(commandId));
  if (!cmd) return null;
  const allowed = new Set([...cmd.flags, "json", "help", "version"]);
  const unexpected = flagNames.filter((flag) => !allowed.has(flag));
  if (unexpected.length === 0) return null;
  return `claudexor: flag(s) not valid for the ${cmd.id} command: ${unexpected.map((flag) => `--${flag}`).join(", ")} (see \`claudexor help\`)`;
}

/** Subcommand-scope projection of `subcommandFlags` (same fail-loud contract
 * as `commandFlagScopeError`, one level down): a KNOWN flag owned by the
 * command but NOT by the dispatched subcommand (e.g. `harness list --yes`)
 * is a loud usage error, never silently ignored (INV-021). Returns null for
 * commands/subcommands without a declared ownership map. */
export function subcommandFlagScopeError(
  commandId: string,
  subcommand: string,
  flagNames: readonly string[],
): string | null {
  const cmd = CLI_COMMANDS.find((c) => c.id === commandId || (c.aliases ?? []).includes(commandId));
  const owned = cmd?.subcommandFlags?.[subcommand];
  if (!cmd || !owned) return null;
  const allowed = new Set([...owned, "json", "help", "version"]);
  const unexpected = flagNames.filter((flag) => !allowed.has(flag));
  if (unexpected.length === 0) return null;
  return `usage: flag(s) not valid for \`claudexor ${cmd.id} ${subcommand}\`: ${unexpected.map((flag) => `--${flag}`).join(", ")} (see \`claudexor help\`)`;
}

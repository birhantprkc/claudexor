/**
 * Registry-driven flag-scope validation (INV-021 fail-loud flags): a KNOWN
 * flag outside its command's — or its dispatched subcommand's — declared set
 * is a loud usage error, never silently ignored. The data lives in
 * `command-registry.ts` (`flags` / `subcommandFlags`); this module only
 * projects it.
 */
import { RUN_FLAGS_BY_MODE } from "./command-flags.js";
import { CLI_COMMANDS, usageLabel } from "./command-registry.js";

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

/** The `agent` verb can select a read-only mode with `--mode`; validate that
 * dynamic path from the same declared per-mode flag matrix. */
export function runModeFlagScopeError(
  mode: "ask" | "plan" | "agent",
  flagNames: readonly string[],
): string | null {
  const allowed = new Set([...RUN_FLAGS_BY_MODE[mode], "mode", "help", "version"]);
  const unexpected = flagNames.filter((flag) => !allowed.has(flag));
  if (unexpected.length === 0) return null;
  return `claudexor: flag(s) not valid for mode '${mode}': ${unexpected.map((flag) => `--${flag}`).join(", ")}`;
}

/** Validate complete positional consumption before any handler can run. */
export function commandPositionalError(
  commandId: string,
  values: readonly string[],
): string | null {
  const cmd = CLI_COMMANDS.find((candidate) =>
    candidate.id === commandId || (candidate.aliases ?? []).includes(commandId),
  );
  if (!cmd) return null;
  const matches = cmd.positionalPatterns.some((pattern) => {
    if (values.length < pattern.min) return false;
    if (pattern.max !== null && values.length > pattern.max) return false;
    return (pattern.prefix ?? []).every((token, index) => values[index] === token);
  });
  return matches
    ? null
    : `claudexor: invalid positional arguments for ${cmd.id}; usage: ${usageLabel(cmd)}`;
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

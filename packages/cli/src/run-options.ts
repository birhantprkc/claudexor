import type {
  ControlReviewerPanelEntry,
  EffortHint,
  ProtectedPathApproval,
  ProviderFamily,
  TestCommandInvocation,
} from "@claudexor/schema";
import { CLAUDE_EFFORT_SNAPSHOT } from "@claudexor/harness-claude";
import { CODEX_EFFORT_SNAPSHOT, unionEffortLevels } from "@claudexor/harness-codex";
import {
  parseReviewerEffortMap,
  parseReviewerModelMap,
  parseReviewerPanel,
} from "./reviewer-options.js";

/**
 * Effort levels the recorded vendor snapshots advertise, unioned across
 * harnesses — the CLI's parse-time answer to "could this `:token` be an
 * effort?". Stamped vendor data (the same snapshots discovery falls back to),
 * never a hand-ranked table; a live-only level the snapshots have not caught
 * up with rides the unambiguous `--reviewer-effort family=level` spelling.
 */
function snapshotAdvertisedEfforts(): ReadonlySet<string> {
  return new Set([...CLAUDE_EFFORT_SNAPSHOT, ...unionEffortLevels(CODEX_EFFORT_SNAPSHOT.models)]);
}

export function stringFlagValues(values: Array<string | boolean>, flag: string): string[] {
  const strings = values.filter((value): value is string => typeof value === "string");
  if (strings.length !== values.length)
    throw new Error(`invalid --${flag} value (expected a value)`);
  return strings;
}

export function parseProtectedPathApprovalFlags(
  values: Array<string | boolean>,
): ProtectedPathApproval[] | undefined {
  const strings = stringFlagValues(values, "allow-protected-path");
  if (strings.length === 0) return undefined;
  const paths: string[] = [];
  for (const value of strings) {
    for (const part of value.split(",")) {
      const path = part.trim();
      if (!path)
        throw new Error("invalid --allow-protected-path value (empty comma-separated entry)");
      paths.push(path);
    }
  }
  return paths.map((path) => ({ path, reason: "explicit CLI --allow-protected-path" }));
}

export function parseTestCommandFlags(
  values: Array<string | boolean>,
): TestCommandInvocation[] | undefined {
  const strings = stringFlagValues(values, "test");
  if (strings.length === 0) return undefined;
  const commands: TestCommandInvocation[] = [];
  for (const value of strings) {
    const command = value.trim();
    if (!command) throw new Error("invalid --test value (empty command)");
    if (command.startsWith("[")) {
      let argv: unknown;
      try {
        argv = JSON.parse(command);
      } catch {
        throw new Error("invalid --test value (expected a JSON argv array)");
      }
      if (
        !Array.isArray(argv) ||
        argv.length === 0 ||
        !argv.every((part) => typeof part === "string") ||
        !(argv[0] as string).trim()
      ) {
        throw new Error("invalid --test value (expected a non-empty JSON string argv array)");
      }
      commands.push({
        program: argv[0] as string,
        args: argv.slice(1) as string[],
        envAllowlist: [],
      });
      continue;
    }
    if (/\s|[;&|<>$`()]/.test(command)) {
      throw new Error(
        'invalid --test value (implicit shell syntax is forbidden; use JSON argv, e.g. --test \'["pnpm","test"]\')',
      );
    }
    commands.push({ program: command, args: [], envAllowlist: [] });
  }
  return commands;
}

export function parseReviewerPanelFlags(
  values: Array<string | boolean>,
): ControlReviewerPanelEntry[] | undefined {
  const strings = stringFlagValues(values, "reviewer-panel");
  return parseReviewerPanel(
    strings.length > 0 ? strings.join(",") : undefined,
    snapshotAdvertisedEfforts(),
  );
}

export function parseReviewerModelFlags(
  values: Array<string | boolean>,
): Partial<Record<ProviderFamily, string>> | undefined {
  const strings = stringFlagValues(values, "reviewer-model");
  return parseReviewerModelMap(strings.length > 0 ? strings.join(",") : undefined);
}

export function parseReviewerEffortFlags(
  values: Array<string | boolean>,
): Partial<Record<ProviderFamily, EffortHint>> | undefined {
  const strings = stringFlagValues(values, "reviewer-effort");
  return parseReviewerEffortMap(strings.length > 0 ? strings.join(",") : undefined);
}

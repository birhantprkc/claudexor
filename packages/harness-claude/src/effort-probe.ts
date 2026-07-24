/**
 * Effort discovery for the INSTALLED claude CLI.
 *
 * Claude Code's effort ladder is a property of the binary on this machine, not
 * of Claudexor: 2.1.89 advertises `low, medium, high, max` while 2.1.165
 * advertises `low, medium, high, xhigh, max`. Hardcoding either one means one
 * installed version gets silently clamped, which is exactly the defect this
 * replaces. So we read the ladder out of the binary's own `--help`.
 *
 * The help line looks like:
 *   --effort <level>   Effort level for the current session (low, medium, high, xhigh, max)
 * with the parenthesized list possibly wrapped onto the following line.
 *
 * On a missing binary, an unparseable help text, or a `--help` that stops
 * documenting the values, the recorded snapshot fills in and the run proceeds.
 */
import type { EffortHint } from "@claudexor/schema";
import { EFFORT_HINT_PATTERN } from "@claudexor/schema";
import { runCapture } from "@claudexor/core";
import { redactSecrets } from "@claudexor/util";

export const BIN = process.env.CLAUDEXOR_CLAUDE_BIN || "claude";

/**
 * Recorded fallback, captured from `claude --help` on the CLI version stamped
 * below. Used ONLY when the live parse cannot answer.
 */
export const CLAUDE_EFFORT_SNAPSHOT: readonly EffortHint[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** Vendor CLI version `CLAUDE_EFFORT_SNAPSHOT` was captured from. */
export const CLAUDE_EFFORT_SNAPSHOT_VERIFIED_AGAINST = "2.1.165";

/**
 * Pull the advertised levels out of `claude --help` text, or null when the
 * `--effort` line is absent or documents no values.
 *
 * Pure and separately testable: the spawn lives in the adapter's runtime deps so
 * a test can feed recorded help text for any CLI version.
 */
export function parseClaudeEffortHelp(help: string): EffortHint[] | null {
  const lines = help.split(/\r?\n/);
  const start = lines.findIndex((line) => line.includes("--effort"));
  if (start < 0) return null;
  // The value list can wrap; join this line and the next two, which is as far as
  // the vendor's help formatter ever pushes it.
  const window = lines.slice(start, start + 3).join(" ");
  const open = window.indexOf("(");
  if (open < 0) return null;
  const close = window.indexOf(")", open);
  if (close < 0) return null;
  const levels: EffortHint[] = [];
  for (const raw of window.slice(open + 1, close).split(/[,|]/)) {
    const level = raw.trim();
    // Ignore anything that is not an effort slug: prose such as "(default: high)"
    // must not become an advertised level.
    if (!EFFORT_HINT_PATTERN.test(level)) continue;
    if (!levels.includes(level)) levels.push(level);
  }
  return levels.length > 0 ? levels : null;
}

type ClaudeHelpProbe =
  { ok: true; help: string; code: number | null } | { ok: false; error: string };

let helpProbePromise: Promise<ClaudeHelpProbe> | null = null;

/**
 * ONE memoized `claude --help` capture for the whole process. The readonly-flag
 * probe and the effort ladder both ask the same installed binary the same
 * question, so they share a single spawn and a single cache rather than growing
 * a second discovery mechanism.
 */
export function probeClaudeHelp(abortSignal?: AbortSignal): Promise<ClaudeHelpProbe> {
  helpProbePromise ??= (async (): Promise<ClaudeHelpProbe> => {
    try {
      const result = await runCapture(BIN, ["--help"], {
        timeoutMs: 10_000,
        abortSignal,
        cancelSignal: "SIGTERM",
        cancelKillDelayMs: 0,
      });
      return { ok: true, help: `${result.stdout}\n${result.stderr}`, code: result.code };
    } catch (error) {
      return {
        ok: false,
        error: redactSecrets(error instanceof Error ? error.message : String(error)),
      };
    }
  })();
  return helpProbePromise;
}

/**
 * The effort ladder the INSTALLED claude binary advertises, falling back to the
 * recorded snapshot when `--help` cannot be read or no longer documents the
 * values. A probe failure costs freshness, never the run.
 */
export async function probeClaudeEffortLevels(
  abortSignal?: AbortSignal,
): Promise<{ levels: readonly EffortHint[]; live: boolean }> {
  const probe = await probeClaudeHelp(abortSignal);
  const parsed = probe.ok ? parseClaudeEffortHelp(probe.help) : null;
  return parsed ? { levels: parsed, live: true } : { levels: CLAUDE_EFFORT_SNAPSHOT, live: false };
}

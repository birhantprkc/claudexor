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
 * with the parenthesized list possibly wrapped onto following lines — and HOW FAR
 * it wraps depends on the terminal width, so the parse reads the flag's whole
 * block rather than a fixed number of lines.
 *
 * On a missing binary, an unparseable help text, or a `--help` that stops
 * documenting the values, the recorded snapshot fills in and the run proceeds.
 */
import { EffortHint, isRankedEffort } from "@claudexor/schema";
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
 * How many lines of a wrapped `--effort` block the parse will read. Generous
 * next to the widest observed wrap (four lines at 40 columns) and still a hard
 * stop, so an `--effort` line that documents nothing cannot reach into a later
 * option's parentheses.
 */
const EFFORT_HELP_BLOCK_MAX_LINES = 8;

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
  // The value list wraps at the rendering width, and a narrower terminal pushes
  // the closing paren further down (2.1.165 at 40 columns needs four lines), so
  // a fixed line count silently loses the list. Read this flag's OWN block
  // instead: everything up to the next documented flag or the blank line that
  // ends the section, bounded so a paren from unrelated prose can never be
  // mistaken for the effort list.
  let end = start + 1;
  for (; end < lines.length && end - start < EFFORT_HELP_BLOCK_MAX_LINES; end += 1) {
    const next = lines[end] ?? "";
    // ANY new option line ends the block, SHORT alias included. Matching only a
    // leading `--` let a layout that renders aliases (`  -m, --model <model>`)
    // run straight past the next flag; the block then reached far enough that the
    // LAST parenthesized group came from THAT flag instead — and a group like
    // `(opus, sonnet, haiku)` is comma-separated lowercase slugs, so it passes as
    // a value list and publishes model names as the effort ladder.
    if (next.trim() === "" || /^\s*--?[A-Za-z0-9]/.test(next)) break;
  }
  const window = lines.slice(start, end).join(" ");
  // The FIRST paren in the block is not necessarily the value list: a vendor
  // annotation can precede it ("Effort level (beta) (low, medium, high, max)"),
  // and `beta` is itself a well-formed slug, so anchoring on the first group
  // published a bogus one-level ladder instead of falling back to the snapshot.
  // Take the LAST group that actually looks like a value list — which also
  // survives an annotation placed AFTER the list.
  let levels: EffortHint[] | null = null;
  for (const group of window.matchAll(/\(([^()]*)\)/g)) {
    levels = readEffortGroup(group[1] ?? "") ?? levels;
  }
  return levels;
}

/**
 * The levels one parenthesized group advertises, or null when the group is not a
 * value list at all.
 *
 * A group qualifies only if it ENUMERATES (a comma or pipe) or names a level the
 * rank table knows — otherwise a lone annotation like `(beta)` would pass as a
 * ladder. Levels are validated through `EffortHint` rather than a hand-rolled
 * shape test, so prose such as "default: high" is ignored and an over-long token
 * can never reach `capabilities.effort_levels` and fail the manifest schema.
 */
function readEffortGroup(body: string): EffortHint[] | null {
  const levels: EffortHint[] = [];
  for (const raw of body.split(/[,|]/)) {
    const parsed = EffortHint.safeParse(raw.trim());
    if (parsed.success && !levels.includes(parsed.data)) levels.push(parsed.data);
  }
  if (levels.length === 0) return null;
  if (!/[,|]/.test(body) && !levels.some((level) => isRankedEffort(level))) return null;
  return levels;
}

type ClaudeHelpProbe =
  { ok: true; help: string; code: number | null } | { ok: false; error: string };

/**
 * Wall clock the shared capture is bounded by. It replaces the caller abort
 * signal that used to bound it, so the spawn still cannot hang forever without
 * belonging to any one caller.
 */
const HELP_PROBE_TIMEOUT_MS = 10_000;

let helpProbePromise: Promise<ClaudeHelpProbe> | null = null;

/** What an abandoned caller reads, without the shared capture ever seeing it. */
function abandonedProbe(): ClaudeHelpProbe {
  return { ok: false, error: "claude --help probe abandoned: the caller was cancelled" };
}

/**
 * The ONE `claude --help` capture, owned by the module rather than by whichever
 * caller happened to ask for it first. The readonly-flag probe and the effort
 * ladder both ask the same installed binary the same question, so they share a
 * single spawn rather than growing a second discovery mechanism.
 *
 * Two properties keep the sharing honest, and the first cache had neither:
 *
 * 1. NO CALLER'S ABORT SIGNAL REACHES THE SPAWN. Threading the first caller's
 *    signal in here made a process-wide resource the private property of one
 *    run: cancelling that run killed the capture, and the memo then handed the
 *    corpse to every later run. Its own wall clock bounds it instead.
 * 2. ONLY AN ANSWER IS KEPT. A `--help` that never ran (spawn error) or that the
 *    timeout killed (`code === null`, no exit status of its own) says nothing
 *    about the installed binary, so keeping it turns one bad moment into a
 *    permanent one; those outcomes drop the memo and the next caller re-probes.
 *    A real exit is a fact about this binary — non-zero included — and stays.
 *
 * The stakes are higher than staleness. The ladder falls back to a snapshot
 * recorded from CLAUDE_EFFORT_SNAPSHOT_VERIFIED_AGAINST, so a poisoned memo on a
 * machine running an older CLI does not merely lose freshness: it advertises and
 * forwards `xhigh` to a binary that rejects it, for the life of the daemon.
 */
function sharedHelpCapture(): Promise<ClaudeHelpProbe> {
  if (helpProbePromise) return helpProbePromise;
  const pending = (async (): Promise<ClaudeHelpProbe> => {
    try {
      const result = await runCapture(BIN, ["--help"], {
        timeoutMs: HELP_PROBE_TIMEOUT_MS,
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
  helpProbePromise = pending;
  // Identity-guarded so a late settle can only ever clear its OWN memo, never a
  // re-probe another caller has already started.
  const forget = (): void => {
    if (helpProbePromise === pending) helpProbePromise = null;
  };
  void pending.then((probe) => {
    if (!probe.ok || probe.code === null) forget();
  }, forget);
  return pending;
}

/**
 * The shared capture, with the caller's cancellation bounding only the CALLER'S
 * OWN wait. An abandoned caller reads a probe failure — its run is going away
 * anyway, and the ladder falls back to the snapshot for that one run — while the
 * capture keeps running for everybody else.
 */
export function probeClaudeHelp(abortSignal?: AbortSignal): Promise<ClaudeHelpProbe> {
  const shared = sharedHelpCapture();
  if (!abortSignal) return shared;
  if (abortSignal.aborted) return Promise.resolve(abandonedProbe());
  return new Promise<ClaudeHelpProbe>((resolve) => {
    const abandon = (): void => resolve(abandonedProbe());
    abortSignal.addEventListener("abort", abandon, { once: true });
    void shared.then((probe) => {
      abortSignal.removeEventListener("abort", abandon);
      resolve(probe);
    });
  });
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

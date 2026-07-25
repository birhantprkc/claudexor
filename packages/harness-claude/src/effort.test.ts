import { describe, expect, it } from "vitest";
import { normalizeEffort, resolveEffort } from "@claudexor/core";
import { CLAUDE_EFFORT_SNAPSHOT, parseClaudeEffortHelp } from "./effort-probe.js";

/** Real `claude --help` shape: the values wrap onto the next line. */
const HELP_2_1_165 = [
  "  --debug [filter]                      Enable debug mode",
  "  --effort <level>                      Effort level for the current session",
  "                                        (low, medium, high, xhigh, max)",
  "  --exclude-dynamic-system-prompt-sections",
].join("\n");

/** The older installed CLI: the SAME flag, one level short. */
const HELP_2_1_89 = [
  "  --debug [filter]                      Enable debug mode",
  "  --effort <level>                      Effort level for the current session",
  "                                        (low, medium, high, max)",
  "  --fallback-model <model>              Fallback model",
].join("\n");

/**
 * The SAME 2.1.165 flag rendered at 40 columns: the vendor's help wraps to the
 * width it is rendered at, which pushes the closing paren three lines below the
 * flag. Captured verbatim from `claude --help` under a 40-column terminal.
 */
const HELP_2_1_165_NARROW = [
  "  --debug [filter]",
  "      Enable debug mode",
  "  --effort <level>",
  "      Effort level for the current",
  "      session (low, medium, high, xhigh,",
  "      max)",
  "  --exclude-dynamic-system-prompt-sections",
].join("\n");

describe("the claude ladder is a property of the INSTALLED binary", () => {
  it("finds the list however far the help wraps it, so a narrow terminal does not silently cost the ladder", () => {
    // A truncated window returns null, which falls back to the recorded
    // snapshot — i.e. it would advertise ANOTHER version's ladder, the exact
    // defect this probe exists to remove.
    expect(parseClaudeEffortHelp(HELP_2_1_165_NARROW)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("does not reach past the flag's own block for a paren when --effort documents no values", () => {
    const help = [
      "  --effort <level>",
      "      Effort level for the current session",
      "  --model <model>",
      "      Model for the session (opus, sonnet, haiku)",
    ].join("\n");
    expect(parseClaudeEffortHelp(help)).toBeNull();
  });

  it("ends the block on a SHORT-alias flag too, not just a long one", () => {
    // The regression: the terminator only matched a leading `--`, so a help
    // layout that renders aliases ran past the next flag. Within the eight-line
    // window the LAST parenthesized group then came from `--model`, and
    // `(opus, sonnet, haiku)` is comma-separated lowercase slugs, so it passed as
    // a value list — publishing MODEL NAMES as the effort ladder, live and
    // stamped with the installed version, instead of falling back to the snapshot.
    const help = [
      "  --effort <level>",
      "      Effort level for the current session",
      "  -m, --model <model>",
      "      Model for the session (opus, sonnet, haiku)",
    ].join("\n");
    expect(parseClaudeEffortHelp(help)).toBeNull();
  });

  it("still reads a wrapped value list when the NEXT flag renders a short alias", () => {
    // The terminator must not be so eager that it truncates a legitimate wrap.
    const help = [
      "  --effort <level>",
      "      Effort level for the current session (low, medium,",
      "      high, xhigh, max)",
      "  -m, --model <model>",
      "      Model for the session (opus, sonnet, haiku)",
    ].join("\n");
    expect(parseClaudeEffortHelp(help)).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("reads xhigh from a CLI whose --help advertises it (2.1.165)", () => {
    expect(parseClaudeEffortHelp(HELP_2_1_165)).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("does NOT invent xhigh on a CLI whose --help omits it (2.1.89)", () => {
    expect(parseClaudeEffortHelp(HELP_2_1_89)).toEqual(["low", "medium", "high", "max"]);
  });

  it("xhigh passes through on a CLI that advertises it", () => {
    const advertised = parseClaudeEffortHelp(HELP_2_1_165);
    expect(advertised).not.toBeNull();
    expect(normalizeEffort("xhigh", advertised ?? [])).toBe("xhigh");
  });

  it("the SAME request sends NO flag on a CLI that does not advertise xhigh — no invented downgrade", () => {
    // The claude ladder is a single vendor list: the installed binary's own
    // `--help` order. A level that list has never seen has no honest position
    // on it (there is no rank table to guess with), so the arg builder sends
    // no flag — the vendor default stands — and preflight disclosure
    // (`governRouteEffort`) tells the user the level went nowhere.
    const advertised = parseClaudeEffortHelp(HELP_2_1_89) ?? [];
    expect(advertised).not.toContain("xhigh");
    expect(normalizeEffort("xhigh", advertised)).toBeNull();
    const check = resolveEffort("xhigh", advertised);
    expect(check.status).toBe("rejected");
    if (check.status !== "rejected") throw new Error("expected a rejection");
    expect(check.message).toContain("low, medium, high, max");
  });

  it("refuses a level the binary's advertised list cannot place, naming this binary's set", () => {
    const advertised = parseClaudeEffortHelp(HELP_2_1_165) ?? [];
    const check = resolveEffort("ultracode", advertised);
    expect(check.status).toBe("rejected");
    if (check.status !== "rejected") throw new Error("expected a rejection");
    // "ultracode" is a Claude Code menu item, not an API effort level.
    expect(check.message).toContain("low, medium, high, xhigh, max");
  });

  it("passes an unranked level through when a future CLI advertises it", () => {
    const help = [
      "  --effort <level>                      Effort level for the current session",
      "                                        (low, high, ludicrous)",
    ].join("\n");
    const advertised = parseClaudeEffortHelp(help) ?? [];
    expect(advertised).toEqual(["low", "high", "ludicrous"]);
    expect(normalizeEffort("ludicrous", advertised)).toBe("ludicrous");
  });
});

describe("the claude effort probe degrades gracefully", () => {
  it("returns null when --help documents no --effort flag at all", () => {
    expect(parseClaudeEffortHelp("  --debug [filter]   Enable debug mode")).toBeNull();
  });

  it("returns null when the --effort line carries no value list", () => {
    expect(parseClaudeEffortHelp("  --effort <level>   Effort level for the session")).toBeNull();
  });

  it("skips a leading annotation and reads the real value list, not the first paren", () => {
    // A vendor annotation BEFORE the list is the trap: `beta` is a well-formed
    // slug, so anchoring on the first `(` published ["beta"] as this binary's
    // whole ladder — a bogus one-level ladder that looks live, instead of the
    // snapshot fallback a failed parse is supposed to produce.
    const help = [
      "  --effort <level>                      Effort level (beta) (low, medium, high, xhigh, max)",
      "  --fallback-model <model>              Fallback model",
    ].join("\n");
    expect(parseClaudeEffortHelp(help)).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("skips a TRAILING annotation too, rather than taking the last paren blindly", () => {
    const help = [
      "  --effort <level>                      Effort level (low, medium, high, max) (experimental)",
      "  --fallback-model <model>              Fallback model",
    ].join("\n");
    expect(parseClaudeEffortHelp(help)).toEqual(["low", "medium", "high", "max"]);
  });

  it("returns null when the block's only parenthetical is an annotation", () => {
    // No value list at all: fall back to the snapshot instead of advertising a
    // one-item ladder made of prose.
    const help = [
      "  --effort <level>                      Effort level for the session (beta)",
      "  --fallback-model <model>              Fallback model",
    ].join("\n");
    expect(parseClaudeEffortHelp(help)).toBeNull();
  });

  it("treats a single-token group as an annotation, not a one-level ladder", () => {
    // With no rank table, `(high)` is indistinguishable from `(beta)`; the
    // vendor's real value list has always enumerated, so a lone token falls
    // back to the snapshot instead of publishing a one-level ladder.
    const help = ["  --effort <level>                      Effort level (high)", ""].join("\n");
    expect(parseClaudeEffortHelp(help)).toBeNull();
  });

  it("anchors on the --effort flag TOKEN, not any line containing the substring", () => {
    // `--effort-budget` contains "--effort"; a substring match anchored the
    // parse on the WRONG flag's block and read its parenthetical as the ladder.
    const help = [
      "  --effort-budget <n>                   Token budget for effort (tokens, dollars)",
      "  --effort <level>                      Effort level for the current session",
      "                                        (low, medium, high, xhigh, max)",
    ].join("\n");
    expect(parseClaudeEffortHelp(help)).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("refuses an over-long token instead of letting it reach the manifest schema", () => {
    const help = [
      `  --effort <level>                      Effort level (low, ${"x".repeat(33)})`,
      "",
    ].join("\n");
    // The bad token is dropped, not published: EffortHint bounds it, so
    // capabilities.effort_levels can never carry a value the schema would reject.
    expect(parseClaudeEffortHelp(help)).toEqual(["low"]);
  });

  it("ignores prose inside the parentheses rather than advertising it as a level", () => {
    const help = [
      "  --effort <level>                      Effort level for the current session",
      "                                        (low, medium, high, default: high)",
    ].join("\n");
    expect(parseClaudeEffortHelp(help)).toEqual(["low", "medium", "high"]);
  });

  it("falls back to a snapshot that still drives a usable run when the parse fails", () => {
    // A failed probe costs freshness, never the run: the snapshot is a real
    // ladder, so normalization keeps working end to end.
    expect(parseClaudeEffortHelp("garbage")).toBeNull();
    expect([...CLAUDE_EFFORT_SNAPSHOT]).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(normalizeEffort("xhigh", CLAUDE_EFFORT_SNAPSHOT)).toBe("xhigh");
  });
});

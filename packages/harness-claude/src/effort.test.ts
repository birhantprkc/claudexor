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

  it("the SAME request clamps to max on a CLI that does not advertise xhigh, instead of being sent and rejected", () => {
    // This is the defect the ladder split fixes: 2.1.89 would have taken a
    // hardcoded `xhigh` and died on it, while a hardcoded 4-level ladder
    // silently downgraded 2.1.165 users who asked for `xhigh`.
    const advertised = parseClaudeEffortHelp(HELP_2_1_89) ?? [];
    // xhigh (rank 5) sits between high (4) and max (6): a tie resolving to the
    // cheaper level, so the run stays honest rather than over-spending.
    expect(normalizeEffort("xhigh", advertised)).toBe("high");
    expect(advertised).not.toContain("xhigh");
  });

  it("refuses a level neither advertised nor rankable, naming this binary's set", () => {
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

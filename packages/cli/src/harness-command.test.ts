import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  print: vi.fn(),
  printJson: vi.fn(),
  printUsageError: vi.fn(() => 2),
}));

vi.mock("./cli-io.js", () => ({
  print: mocks.print,
  printJson: mocks.printJson,
  printUsageError: mocks.printUsageError,
}));

import { FAKE_KINDS } from "@claudexor/harness-fake";
import { parseArgs } from "./args.js";
import { harnessCommand } from "./harness-command.js";

// `harness list` plus the RESTORED disclosed installer (issue #89): list
// stays exactly as it was after the PR #82 cut, and install now routes to
// harness-installer.ts (pinned versions, disclosure-before-execution — its
// own suite covers the details; here we pin the dispatch and the refusal).
describe("harnessCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists only real harnesses by default — fakes stay undisclosed", () => {
    expect(harnessCommand(parseArgs(["harness", "list"]), true)).toBe(0);
    expect(mocks.printJson).toHaveBeenCalledTimes(1);
    const { harnesses } = mocks.printJson.mock.calls[0]?.[0] as { harnesses: string[] };
    for (const id of ["codex", "claude", "cursor"]) expect(harnesses).toContain(id);
    expect(harnesses.filter((id) => (FAKE_KINDS as readonly string[]).includes(id))).toEqual([]);
    expect(mocks.print).not.toHaveBeenCalled();
  });

  it("reveals the fake fixtures with --all and prints one id per line in text mode", () => {
    expect(harnessCommand(parseArgs(["harness", "list", "--all"]), false)).toBe(0);
    const printed = mocks.print.mock.calls.map((call) => call[0] as string);
    for (const id of ["codex", ...FAKE_KINDS]) expect(printed).toContain(id);
    expect(printed).toEqual([...new Set(printed)]);
    expect(mocks.printJson).not.toHaveBeenCalled();
  });

  it("rejects flags the dispatched subcommand does not own with a loud exit-2 usage error", () => {
    // INV-021: `harness list --yes` and `harness install --all` must never
    // silently ignore the stray flag; the usage line names it.
    expect(harnessCommand(parseArgs(["harness", "list", "--yes"]), false)).toBe(2);
    expect(mocks.printUsageError).toHaveBeenLastCalledWith(false, expect.stringContaining("--yes"));
    expect(harnessCommand(parseArgs(["harness", "list", "--dry-run"]), true)).toBe(2);
    expect(mocks.printUsageError).toHaveBeenLastCalledWith(
      true,
      expect.stringContaining("--dry-run"),
    );
    expect(harnessCommand(parseArgs(["harness", "install", "codex", "--all"]), false)).toBe(2);
    expect(mocks.printUsageError).toHaveBeenLastCalledWith(false, expect.stringContaining("--all"));
    // Nothing was listed or installed on any of the refused paths.
    expect(mocks.print).not.toHaveBeenCalled();
    expect(mocks.printJson).not.toHaveBeenCalled();
  });

  it("still accepts each subcommand's own flags after the ownership check", () => {
    expect(harnessCommand(parseArgs(["harness", "list", "--all"]), true)).toBe(0);
    expect(mocks.printUsageError).not.toHaveBeenCalled();
    expect(harnessCommand(parseArgs(["harness", "install", "codex", "--dry-run"]), true)).toBe(0);
    expect(mocks.printUsageError).not.toHaveBeenCalled();
  });

  it("rejects unknown verbs with the usage error, naming every installable harness", () => {
    // Spelled out on purpose: the verb list is DERIVED from
    // INSTALLABLE_HARNESSES in the source, so this literal is the independent
    // oracle that catches a new installable harness missing from the usage.
    expect(harnessCommand(parseArgs(["harness", "bogus"]), false)).toBe(2);
    expect(mocks.printUsageError).toHaveBeenCalledWith(
      false,
      "usage: claudexor harness list [--all] | install <agy|claude|codex|cursor|opencode> [--dry-run] [--yes]",
    );
  });

  it("routes install to the disclosed installer, which refuses without confirmation", () => {
    // Non-TTY, no --yes: the pinned disclosure prints, then a loud refusal —
    // exit 1, and NEVER the usage path (the verb exists again).
    expect(harnessCommand(parseArgs(["harness", "install", "codex"]), false)).toBe(1);
    expect(mocks.printUsageError).not.toHaveBeenCalled();
    const printed = mocks.print.mock.calls.map((call) => call[0] as string).join("\n");
    expect(printed).toContain("@openai/codex@");
    expect(printed).not.toContain("@latest");
    expect(printed).toContain("Not installing");
  });
});

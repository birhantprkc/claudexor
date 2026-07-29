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

  it("rejects unknown verbs with the usage error", () => {
    expect(harnessCommand(parseArgs(["harness", "bogus"]), false)).toBe(2);
    expect(mocks.printUsageError).toHaveBeenCalledWith(
      false,
      "usage: claudexor harness list [--all] | install <claude|codex|cursor|opencode> [--dry-run] [--yes]",
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

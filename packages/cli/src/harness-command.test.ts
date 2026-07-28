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

// `harness list` is the ONLY harness verb that survived the install-verb cut
// (the remote vendor installer executed unverified curl|sh payloads); this
// pins the survivor so a regression cannot ride out unnoticed.
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

  it("rejects any other verb (harness install stays removed) with the usage error", () => {
    expect(harnessCommand(parseArgs(["harness", "install", "codex"]), false)).toBe(2);
    expect(mocks.printUsageError).toHaveBeenCalledWith(
      false,
      "usage: claudexor harness list [--all]",
    );
  });
});

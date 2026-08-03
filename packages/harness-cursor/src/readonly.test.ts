import { describe, expect, it } from "vitest";
import { HarnessRunSpec, type HarnessEvent } from "@claudexor/schema";
import type { CliRunLoopOptions } from "@claudexor/core";
import { createCursorAdapter } from "./index.js";

/**
 * Claim-8 regression pin. Live probe evidence (2026-08-03, cursor-agent
 * 2026.07.23-e383d2b): under the PREVIOUS readonly argv
 * (`-p --output-format stream-json --sandbox enabled --trust`) the agent
 * CREATED a file on instruction — print mode "has access to all tools,
 * including write and shell" and `--sandbox` gates commands, not file edits.
 * Under the same argv plus `--mode ask` it refused: "I'm in Ask mode right
 * now, so I can't create or modify files." Ask mode is therefore the only
 * mechanism this CLI has that enforces readonly, and the `readonly` access
 * profile must dispatch onto it.
 */

const spec = (overrides: Partial<HarnessRunSpec> = {}): HarnessRunSpec =>
  HarnessRunSpec.parse({
    session_id: "s-cursor-readonly",
    intent: "review",
    prompt: "review this",
    cwd: "/repo",
    ...overrides,
  });

async function argsFor(runSpec: HarnessRunSpec): Promise<string[]> {
  let captured: string[] | undefined;
  const adapter = createCursorAdapter({
    detectVersion: async () => "cursor-test",
    nativeAuthOk: async () => ({ authed: true, probeError: null }),
    cursorApiKey: () => null,
    runCliHarness: async function* (opts: CliRunLoopOptions): AsyncGenerator<HarnessEvent> {
      captured = [...opts.args];
      yield {
        type: "completed",
        session_id: opts.spec.session_id,
        ts: "2026-01-01T00:00:00.000Z",
      };
    },
  });
  for await (const ev of adapter.run(runSpec)) void ev;
  expect(captured, "the CLI was never invoked").toBeDefined();
  return captured as string[];
}

const modesOf = (args: string[]): string[] =>
  args.flatMap((arg, i) => (arg === "--mode" ? [args[i + 1] ?? ""] : []));

describe("cursor readonly access dispatches onto Ask mode", () => {
  it("readonly rides --mode ask (sandbox stays on as a command belt)", async () => {
    const args = await argsFor(spec({ access: "readonly" }));
    expect(modesOf(args)).toEqual(["ask"]);
    expect(args).toContain("--sandbox");
    // The write-enabling force flag must never appear on a readonly run.
    expect(args).not.toContain("--force");
  });

  it("workspace_write keeps the full agent mode (no --mode flag)", async () => {
    const args = await argsFor(spec({ access: "workspace_write" }));
    expect(modesOf(args)).toEqual([]);
  });

  it("plan intent + readonly access yields exactly one --mode ask", async () => {
    const args = await argsFor(spec({ access: "readonly", intent: "plan" }));
    expect(modesOf(args)).toEqual(["ask"]);
  });

  it("plan intent alone still rides Ask mode (pre-existing behavior)", async () => {
    const args = await argsFor(spec({ intent: "plan" }));
    expect(modesOf(args)).toEqual(["ask"]);
  });
});

async function runCollecting(
  runSpec: HarnessRunSpec,
): Promise<{ events: HarnessEvent[]; args: string[] | null }> {
  let captured: string[] | null = null;
  const adapter = createCursorAdapter({
    detectVersion: async () => "cursor-test",
    nativeAuthOk: async () => ({ authed: true, probeError: null }),
    cursorApiKey: () => null,
    runCliHarness: async function* (opts: CliRunLoopOptions): AsyncGenerator<HarnessEvent> {
      captured = [...opts.args];
      yield {
        type: "completed",
        session_id: opts.spec.session_id,
        ts: "2026-01-01T00:00:00.000Z",
      };
    },
  });
  const events: HarnessEvent[] = [];
  for await (const ev of adapter.run(runSpec)) events.push(ev);
  return { events, args: captured };
}

describe("cursor external_sandbox_full stands its own sandbox down (engine boundary is THE boundary)", () => {
  it("maps external_sandbox_full to --force --sandbox disabled --trust, like codex/claude", async () => {
    const { events, args } = await runCollecting(spec({ access: "external_sandbox_full" }));
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(args).not.toBeNull();
    const argv = args as unknown as string[];
    expect(argv).toContain("--force");
    expect(argv).toContain("--trust");
    const sandboxIdx = argv.indexOf("--sandbox");
    expect(sandboxIdx).toBeGreaterThanOrEqual(0);
    expect(argv[sandboxIdx + 1]).toBe("disabled");
    // Full access inside the external boundary: never Ask mode.
    expect(modesOf(argv)).toEqual([]);
  });

  it("still refuses bare full access (no external boundary claimed) without invoking the CLI", async () => {
    const { events, args } = await runCollecting(spec({ access: "full" }));
    expect(args).toBeNull();
    const error = events.find((e) => e.type === "error");
    expect(error?.error).toContain("not conformance-proven");
    expect(events.at(-1)?.type).toBe("completed");
  });

  it("declares external_sandbox_full (and not full) in the manifest", async () => {
    const adapter = createCursorAdapter({
      detectVersion: async () => "cursor-test",
      nativeAuthOk: async () => ({ authed: true, probeError: null }),
      cursorApiKey: () => null,
    });
    const manifest = await adapter.discover();
    expect(manifest.access_profiles_supported).toContain("external_sandbox_full");
    expect(manifest.access_profiles_supported).not.toContain("full");
  });
});

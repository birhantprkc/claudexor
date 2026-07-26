import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runCapture, type CliRunLoopOptions, type HarnessAdapter } from "@claudexor/core";
import type { HarnessEvent } from "@claudexor/schema";
import { createCursorAdapter } from "../../harness-cursor/src/index.js";
import { Orchestrator } from "./orchestrator.js";

const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}

afterAll(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

async function initializedRepository(): Promise<string> {
  const root = temporaryDirectory("claudexor-cursor-plan-");
  await runCapture("git", ["-C", root, "init", "-b", "main"]);
  writeFileSync(join(root, "README.md"), "# Cursor Plan fixture\n");
  await runCapture("git", ["-C", root, "add", "-A"]);
  await runCapture("git", [
    "-C",
    root,
    "-c",
    "user.email=qa@example.invalid",
    "-c",
    "user.name=QA",
    "commit",
    "-m",
    "fixture",
  ]);
  return root;
}

describe("Cursor Plan validated transport composition", () => {
  it("uses read-only Ask transport and delivers a validated WorkReport without fallback", async () => {
    const repo = await initializedRepository();
    const configDir = temporaryDirectory("claudexor-cursor-plan-config-");
    let captured: CliRunLoopOptions | undefined;
    const adapter = createCursorAdapter({
      detectVersion: async () => "cursor-test",
      nativeAuthOk: async () => ({ authed: true, probeError: null }),
      cursorApiKey: () => null,
      listCursorModels: async () => [],
      smokeIsolatedApiKey: async () => ({ ok: false, detail: "not needed" }),
      runCliHarness: async function* (opts: CliRunLoopOptions): AsyncGenerator<HarnessEvent> {
        captured = opts;
        const envelope =
          '```json\n{"work_report":{"state":"completed","required_inputs":[]},"output":"PLAN_OK"}\n```';
        const frames = [
          { type: "system", subtype: "init", model: "cursor-test" },
          { type: "assistant", message: { content: [{ text: envelope }] } },
          { type: "result", subtype: "success", total_cost_usd: 0 },
        ];
        for (const frame of frames) {
          for (const event of opts.parseEvent?.(frame, opts.spec.session_id) ?? []) yield event;
        }
        yield {
          type: "completed",
          session_id: opts.spec.session_id,
          ts: "2026-01-01T00:00:00.000Z",
        };
      },
    });

    const previousConfig = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    let result;
    try {
      const registry = new Map<string, HarnessAdapter>([["cursor", adapter]]);
      result = await new Orchestrator({ registry, reviewers: [] }).run({
        repoRoot: repo,
        prompt: "Create a read-only implementation plan.",
        mode: "plan",
        harnesses: ["cursor"],
      });
    } finally {
      if (previousConfig === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = previousConfig;
    }

    const args = captured?.args ?? [];
    expect(args.flatMap((arg, index) => (arg === "--mode" ? [args[index + 1]] : []))).toEqual([
      "ask",
    ]);
    expect(args).toContain("--sandbox");
    expect(args[args.indexOf("--sandbox") + 1]).toBe("enabled");
    expect(args).toContain("--trust");
    expect(args).not.toContain("--force");
    expect(args.at(-1)).toContain("This block is mandatory.");

    expect(result.lifecycle).toBe("succeeded");
    expect(result.facts.work_state).toEqual({
      state: "completed",
      source: "validated",
    });
    expect(readFileSync(join(result.runDir, "final", "plan.md"), "utf8").trim()).toBe("PLAN_OK");
    const events = readFileSync(join(result.runDir, "events.jsonl"), "utf8");
    expect(events).not.toContain("route.fallback.started");
    expect(events).not.toContain("work_report contract");
    expect((await runCapture("git", ["-C", repo, "status", "--porcelain"])).stdout).toBe("");
  });
});

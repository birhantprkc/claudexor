import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");
const cliSource = fileURLToPath(new URL("./cli.ts", import.meta.url));

describe("run-command pre-daemon machine contract", () => {
  it("renders missing prompts for all five run verbs as exactly one NDJSON failure", () => {
    for (const verb of ["agent", "ask", "best-of", "plan", "create"]) {
      const result = spawnSync(process.execPath, [tsxCli, cliSource, verb, "--json-stream"], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: process.env,
      });
      expect(result.status, `${verb}: ${result.stderr}`).toBe(2);
      expect(result.stderr, verb).toBe("");
      expect(result.stdout.endsWith("\n"), verb).toBe(true);
      const lines = result.stdout.split("\n");
      expect(lines, verb).toHaveLength(2);
      expect(lines[1], verb).toBe("");
      expect(JSON.parse(lines[0] ?? "{}"), verb).toEqual({
        ok: false,
        exitCode: 2,
        code: "invalid_argument",
        message: "claudexor: missing prompt",
        error: "claudexor: missing prompt",
      });
    }
  });

  it("advertises only mode-applicable controls in dedicated Ask/Plan help", () => {
    const cases = [
      {
        verb: "ask",
        present: ["--deep-scan", "--n", "--output-schema", "--attach"],
        absent: ["--attempts", "--council", "--test", "--in-place", "--reviewer-panel"],
      },
      {
        verb: "plan",
        present: ["--council", "--n", "--attach"],
        absent: [
          "--attempts",
          "--deep-scan",
          "--synthesis",
          "--test",
          "--allow-protected-path",
          "--deny-path",
          "--output-schema",
          "--reviewer-panel",
          "--reviewer-model",
          "--reviewer-effort",
          "--in-place",
        ],
      },
    ];
    for (const fixture of cases) {
      const result = spawnSync(process.execPath, [tsxCli, cliSource, fixture.verb, "--help"], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: process.env,
      });
      expect(result.status, `${fixture.verb}: ${result.stderr}`).toBe(0);
      expect(result.stderr, fixture.verb).toBe("");
      for (const flag of fixture.present) expect(result.stdout, fixture.verb).toContain(flag);
      for (const flag of fixture.absent) expect(result.stdout, fixture.verb).not.toContain(flag);
    }
  });

  it("rejects Agent controls before daemon startup on agent --mode plan", () => {
    const result = spawnSync(
      process.execPath,
      [
        tsxCli,
        cliSource,
        "agent",
        "plan it",
        "--mode",
        "plan",
        "--reviewer-model",
        "openai=gpt-test",
        "--json",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: process.env,
      },
    );
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      exitCode: 2,
      code: "invalid_argument",
      message: expect.stringContaining("--reviewer-model"),
    });
  });
});

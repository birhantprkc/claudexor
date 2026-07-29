import { describe, expect, it, vi } from "vitest";
import { cliOutputMode, renderOutputUsageFailure } from "./output-mode.js";

describe("CLI output mode", () => {
  it("parses the full mode before dispatch", () => {
    expect(cliOutputMode({ _: [], flags: {} })).toBe("human");
    expect(cliOutputMode({ _: [], flags: { json: true } })).toBe("json");
    expect(cliOutputMode({ _: [], flags: { "json-stream": true } })).toBe("json-stream");
    expect(cliOutputMode({ _: [], flags: { json: true, "json-stream": true } })).toBe("conflict");
  });

  it("renders stream usage failures as one compact NDJSON line", () => {
    const output: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation(((value: string) => {
      output.push(value);
      return true;
    }) as typeof process.stdout.write);
    try {
      expect(renderOutputUsageFailure("json-stream", "claudexor: missing prompt")).toBe(2);
    } finally {
      write.mockRestore();
    }
    expect(output).toHaveLength(1);
    expect(output[0]?.split("\n")).toHaveLength(2);
    expect(JSON.parse(output[0] ?? "{}")).toMatchObject({
      ok: false,
      exitCode: 2,
      code: "invalid_argument",
      message: "claudexor: missing prompt",
    });
  });
});

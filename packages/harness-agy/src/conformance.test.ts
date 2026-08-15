import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  streamExpectationViolations,
  validateTypedStream,
  type FixtureStreamExpectations,
} from "@claudexor/core";
import { parse as parseYaml } from "yaml";
import { parseAgyEvent } from "./parse.js";

const FIXTURES = fileURLToPath(new URL("../fixtures", import.meta.url));
/** W3.8: per-fixture STREAM SEMANTICS expectations, declared next to the
 * fixture's provenance and asserted through the one core owner. */
const manifest = parseYaml(readFileSync(join(FIXTURES, "manifest.yaml"), "utf8")) as {
  fixtures: Record<string, { expectations?: FixtureStreamExpectations }>;
};

describe("agy adapter conformance fixtures", () => {
  for (const name of readdirSync(FIXTURES).filter((f) => f.endsWith(".jsonl"))) {
    it(`parses ${name} into a conformant typed stream`, () => {
      const events = readFileSync(join(FIXTURES, name), "utf8")
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => parseAgyEvent(JSON.parse(line), "ses-fixture") ?? []);
      const stats = validateTypedStream(events);
      const expectations = manifest.fixtures[name]?.expectations;
      expect(expectations, `manifest expectations missing for ${name}`).toBeTruthy();
      expect(streamExpectationViolations(events, expectations!)).toEqual([]);
      // Every DONE tool result carries a status (never statusless: the
      // conformance stat the engine's tool-hygiene fold depends on).
      expect(stats.statuslessToolResults).toBe(0);
      if (name === "basic-run.jsonl" || name === "schema-envelope-run.jsonl") {
        expect(stats.started).toBe(1);
        expect(stats.toolCalls).toBeGreaterThan(0);
        expect(stats.toolResults).toBeGreaterThan(0);
        expect(stats.usageEvents).toBeGreaterThan(0);
        expect(stats.errors).toBe(0);
      }
      if (name === "error-auth.jsonl") {
        // The real vendor auth-timeout terminal: exit 0 + ERROR envelope must
        // surface as a typed error, never an empty success (PLAN §1.2 F6).
        expect(stats.errors).toBe(1);
        expect(stats.messages).toBe(0);
      }
      if (name.startsWith("session-resume")) {
        // The vendor conversation id is surfaced for INV-137 lane resume.
        const started = events.find((e) => (e as { type?: string }).type === "started") as
          { payload?: Record<string, unknown> } | undefined;
        expect(started?.payload?.["native_session_id"]).toBeTruthy();
      }
    });
  }
});

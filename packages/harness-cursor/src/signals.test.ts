import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { streamExpectationViolations, type FixtureStreamExpectations } from "@claudexor/core";
import { HarnessEvent } from "@claudexor/schema";
import { createCursorParser, parseCursorEvent, parseCursorStderrFailure } from "./parse.js";

/**
 * A1 typed vendor-limit evidence. The prose is the VERBATIM live incident
 * stderr (2026-08-17, run-2a6fcadecb03) that died as a generic harness_error
 * and blocked credential rotation structurally: without a typed `rate_limit`
 * the orchestrator's reactive rotation predicate can never fire on cursor.
 * The fixture lives in fixtures/signals/ (out of the top-level conformance
 * loop, which asserts tool/usage shapes a limit-killed run cannot carry) and
 * is replayed here against its own manifest `expectations`.
 */
const FIXTURES = fileURLToPath(new URL("../fixtures", import.meta.url));
const INCIDENT_STDERR =
  "ActionRequiredError: You've hit your usage limit You've saved $567 on API model usage this " +
  "month with Ultra. Switch to a different model or set a Spend Limit to continue with Gemini. " +
  "Your usage limits will reset when your monthly cycle ends on 9/12/2026.";

function replayFixture(name: string, requestedModel?: string): HarnessEvent[] {
  const parse = createCursorParser(undefined, undefined, false, false, requestedModel);
  return readFileSync(join(FIXTURES, name), "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => parse(JSON.parse(line), "ses-signal") ?? []);
}

describe("cursor vendor-limit signals (A1)", () => {
  it("usage-limit-error.jsonl meets its manifest expectations (typed rate_limit + retry class)", () => {
    const manifest = parseYaml(readFileSync(join(FIXTURES, "manifest.yaml"), "utf8")) as {
      fixtures: Record<string, { expectations?: FixtureStreamExpectations }>;
    };
    const expectations = manifest.fixtures["signals/usage-limit-error.jsonl"]?.expectations;
    expect(
      expectations,
      "manifest expectations missing for signals/usage-limit-error.jsonl",
    ).toBeTruthy();
    const events = replayFixture("signals/usage-limit-error.jsonl", "gemini-3.7-flash-high");
    for (const ev of events) expect(() => HarnessEvent.parse(ev)).not.toThrow();
    expect(streamExpectationViolations(events, expectations!)).toEqual([]);
  });

  it("scopes the signal to the REQUESTED model (operational rejection scope), never account-wide", () => {
    const events = replayFixture("signals/usage-limit-error.jsonl", "gemini-3.7-flash-high");
    const limited = events.find((ev) => ev.rate_limit !== undefined);
    expect(limited?.type).toBe("error");
    expect(limited?.rate_limit?.applies_to_models).toEqual(["gemini-3.7-flash-high"]);
    // Rotation-scope pin: the vendor prose names a billing pool ("…continue
    // with Gemini"), NOT a per-model quota — a grok run on the same account
    // must never be cooled by this gemini-scoped signal.
    expect(limited?.rate_limit?.applies_to_models).not.toContain("cursor-grok-4.6-high");
  });

  it("a grok-requested run's limit is scoped to grok, symmetrically", () => {
    const events = replayFixture("signals/usage-limit-error.jsonl", "cursor-grok-4.6-high");
    const limited = events.find((ev) => ev.rate_limit !== undefined);
    expect(limited?.rate_limit?.applies_to_models).toEqual(["cursor-grok-4.6-high"]);
  });

  it("does NOT fabricate a precise reset instant from the day-granular vendor date", () => {
    const events = replayFixture("signals/usage-limit-error.jsonl", "gemini-3.7-flash-high");
    const limited = events.find((ev) => ev.rate_limit !== undefined);
    // "resets when your monthly cycle ends on 9/12/2026" carries no timezone
    // or time of day: resets_at stays null (downstream cooldown TTL bounds
    // apply) and the parsed DAY rides as explicit day-granular evidence.
    expect(limited?.rate_limit?.resets_at).toBeNull();
    expect(limited?.payload?.["vendor_reset_day"]).toBe("2026-09-12");
    expect(limited?.payload?.["vendor_reset_granularity"]).toBe("day");
  });

  it("falls back to the init frame's model identity when no requested model was passed", () => {
    const events = replayFixture("signals/usage-limit-error.jsonl");
    const limited = events.find((ev) => ev.rate_limit !== undefined);
    expect(limited?.rate_limit?.applies_to_models).toEqual(["Gemini 3.7 Flash High"]);
  });

  it("types the stderr-only fatal (the exact incident shape) with profile stamping", () => {
    const event = parseCursorStderrFailure(
      INCIDENT_STDERR,
      "ses-incident",
      "gemini-3.7-flash-high",
      {
        profile_id: "cursor/sol-validator",
      },
    );
    expect(event).toMatchObject({
      type: "error",
      error: INCIDENT_STDERR,
      credential_profile_id: "cursor/sol-validator",
      rate_limit: {
        resets_at: null,
        retry_delay_ms: null,
        applies_to_models: ["gemini-3.7-flash-high"],
      },
      status: { kind: "api_retry", error_category: "rate_limit" },
    });
    expect(event?.payload?.["vendor_reset_day"]).toBe("2026-09-12");
    expect(() => HarnessEvent.parse(event)).not.toThrow();
  });

  it("returns null for unclassified stderr so the generic exit disclosure stays authoritative", () => {
    expect(
      parseCursorStderrFailure("segmentation fault", "ses-x", "gemini-3.7-flash-high"),
    ).toBeNull();
    // The bare ActionRequiredError wrapper is used for other required actions
    // (e.g. re-login) too — without limit prose it must NOT classify.
    expect(
      parseCursorStderrFailure("ActionRequiredError: Please log in again", "ses-x"),
    ).toBeNull();
  });

  it("types a vendor limit arriving as a non-success result frame (sawError path)", () => {
    const out = parseCursorEvent(
      { type: "result", subtype: "error", is_error: true, result: INCIDENT_STDERR },
      "ses-result",
    );
    const failure = (out ?? []).find((ev) => ev.type === "error");
    expect(failure?.rate_limit).toMatchObject({ resets_at: null });
    expect(failure?.status?.error_category).toBe("rate_limit");
    // A3 deliverable hygiene: the prose surfaces as a STATUS event (timeline
    // visibility), never as a message the answer assembly could adopt.
    expect((out ?? []).some((ev) => ev.type === "message")).toBe(false);
    const status = (out ?? []).find(
      (ev) => ev.type === "status" && ev.payload?.["non_success_result"] === true,
    );
    expect(status?.text).toBe(INCIDENT_STDERR);
  });

  it("ignores implausible calendar days instead of emitting garbage evidence", () => {
    const event = parseCursorStderrFailure(
      "You've hit your usage limit. Your usage limits will reset when your monthly cycle ends on 13/40/2026.",
      "ses-bad-date",
    );
    expect(event?.rate_limit).toBeTruthy();
    expect(event?.payload?.["vendor_reset_day"]).toBeUndefined();
  });
});

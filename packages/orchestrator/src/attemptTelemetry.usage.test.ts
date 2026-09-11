import { describe, expect, it } from "vitest";
import {
  AttemptTelemetryRecord,
  InputTokenUsage,
  ModelUsage,
  type HarnessEvent,
} from "@claudexor/schema";
import {
  aggregateRunTokenUsage,
  attemptTelemetryRecord,
  createAttemptTelemetry,
  observeAttemptTelemetry,
} from "./attemptTelemetry.js";

const measured: InputTokenUsage = {
  total_tokens: 100,
  cache_read_tokens: 80,
  cache_write_tokens: null,
};
function usage(value: NonNullable<HarnessEvent["usage"]>): HarnessEvent {
  return { type: "usage", session_id: "s1", ts: new Date(0).toISOString(), usage: value };
}
function attempt(events: HarnessEvent[]) {
  const state = createAttemptTelemetry("off", false);
  events.forEach((event) => observeAttemptTelemetry(state, event));
  return AttemptTelemetryRecord.parse(attemptTelemetryRecord("a1", "codex", state));
}

describe("normalized input telemetry", () => {
  it("preserves independent known fields and legacy values across the complete attempt/run pipeline", () => {
    const codex = attempt([
      usage({
        input_tokens: 100,
        output_tokens: 2,
        cached_input_tokens: 80,
        input_token_usage: measured,
      }),
    ]);
    const claude = attempt([
      usage({
        input_tokens: 100,
        output_tokens: 3,
        cached_input_tokens: 70,
        input_token_usage: { total_tokens: 170, cache_read_tokens: 50, cache_write_tokens: 20 },
      }),
    ]);
    expect(aggregateRunTokenUsage([codex, claude])).toEqual({
      input_tokens: 200,
      output_tokens: 5,
      cached_input_tokens: 150,
      input_token_usage: { total_tokens: 270, cache_read_tokens: 130, cache_write_tokens: null },
    });
  });

  it.each([false, true])(
    "never revives an unknown field when unknown-first is %s",
    (unknownFirst) => {
      const unknown = usage({
        input_token_usage: { total_tokens: null, cache_read_tokens: 7, cache_write_tokens: null },
      });
      const known = usage({ input_token_usage: measured });
      const events = unknownFirst ? [unknown, known] : [known, unknown];
      expect(attempt(events).usage.input_token_usage).toEqual({
        total_tokens: null,
        cache_read_tokens: 87,
        cache_write_tokens: null,
      });
      expect(
        aggregateRunTokenUsage(events.map((event) => attempt([event]))).input_token_usage,
      ).toEqual({ total_tokens: null, cache_read_tokens: 87, cache_write_tokens: null });
    },
  );

  it.each([false, true])(
    "discloses incomplete coverage for mixed old/new contributions, legacy-first=%s",
    (legacyFirst) => {
      const old = usage({ input_tokens: 20, output_tokens: 1 });
      const current = usage({ input_tokens: 100, input_token_usage: measured });
      const events = legacyFirst ? [old, current] : [current, old];
      const expected = { total_tokens: null, cache_read_tokens: null, cache_write_tokens: null };
      expect(attempt(events).usage).toMatchObject({
        input_tokens: 120,
        output_tokens: 1,
        input_token_usage: expected,
      });
      expect(
        aggregateRunTokenUsage(events.map((event) => attempt([event]))).input_token_usage,
      ).toEqual(expected);
      expect(aggregateRunTokenUsage([attempt([current]), attempt([])]).input_token_usage).toEqual(
        expected,
      );
    },
  );

  it.each([0, 1, 2])("retains a missing middle/edge contribution at index %s", (missing) => {
    const events = [0, 1, 2].map((index) =>
      usage(index === missing ? { input_tokens: 20 } : { input_token_usage: measured }),
    );
    const expected = { total_tokens: null, cache_read_tokens: null, cache_write_tokens: null };
    expect(attempt(events).usage.input_token_usage).toEqual(expected);
    expect(
      aggregateRunTokenUsage(events.map((event) => attempt([event]))).input_token_usage,
    ).toEqual(expected);
  });

  it("distinguishes no contribution, explicit zero and a cost-only generation receipt", () => {
    expect(aggregateRunTokenUsage([])).not.toHaveProperty("input_token_usage");
    const zero = { total_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };
    expect(attempt([usage({ input_token_usage: zero })]).usage.input_token_usage).toEqual(zero);
    expect(
      attempt([usage({ input_token_usage: zero }), usage({ cost_usd: 0.01 })]).usage
        .input_token_usage,
    ).toEqual({ total_tokens: null, cache_read_tokens: null, cache_write_tokens: null });
  });

  it("requires all nullable keys without extending raw model usage", () => {
    expect(InputTokenUsage.safeParse({ total_tokens: 100 }).success).toBe(false);
    for (const bad of [-1, 0.5, Infinity, NaN])
      expect(InputTokenUsage.safeParse({ ...measured, total_tokens: bad }).success).toBe(false);
    expect(ModelUsage.parse({})).not.toHaveProperty("input_token_usage");
  });
});

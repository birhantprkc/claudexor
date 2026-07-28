import { describe, expect, it } from "vitest";
import {
  ControlSettingsSnapshot,
  ControlSettingsUpdateRequest,
  GlobalConfig,
  INTERACTION_TIMEOUT_MAX_MS,
} from "./index.js";

describe("finite-or-disabled interactive answer timeout", () => {
  it("keeps the absent config default while preserving an explicit null", () => {
    expect(GlobalConfig.parse({}).interaction_timeout_ms).toBe(900_000);
    expect(GlobalConfig.parse({ interaction_timeout_ms: null }).interaction_timeout_ms).toBeNull();
  });

  it("accepts only a positive integer or null", () => {
    expect(GlobalConfig.parse({ interaction_timeout_ms: 60_000 }).interaction_timeout_ms).toBe(
      60_000,
    );
    expect(() => GlobalConfig.parse({ interaction_timeout_ms: 0 })).toThrow();
    expect(() => GlobalConfig.parse({ interaction_timeout_ms: -1 })).toThrow();
    expect(() => GlobalConfig.parse({ interaction_timeout_ms: 1.5 })).toThrow();
    expect(() =>
      GlobalConfig.parse({ interaction_timeout_ms: Number.MAX_SAFE_INTEGER + 1 }),
    ).toThrow();
    expect(
      GlobalConfig.parse({ interaction_timeout_ms: INTERACTION_TIMEOUT_MAX_MS })
        .interaction_timeout_ms,
    ).toBe(INTERACTION_TIMEOUT_MAX_MS);
    expect(() => GlobalConfig.parse({ interaction_timeout_ms: 8_640_000_000_000_000 })).toThrow();
  });

  it("projects disabled in snapshots and distinguishes patch omission from explicit null", () => {
    expect(
      ControlSettingsSnapshot.parse({ interactionTimeoutMs: null }).interactionTimeoutMs,
    ).toBeNull();
    expect(ControlSettingsSnapshot.parse({}).interactionTimeoutMs).toBe(900_000);

    const omitted = ControlSettingsUpdateRequest.parse({ routingGoal: "auto" });
    const disabled = ControlSettingsUpdateRequest.parse({ interactionTimeoutMs: null });
    expect(Object.hasOwn(omitted, "interactionTimeoutMs")).toBe(false);
    expect(Object.hasOwn(disabled, "interactionTimeoutMs")).toBe(true);
    expect(disabled.interactionTimeoutMs).toBeNull();
    expect(
      ControlSettingsUpdateRequest.parse({ interactionTimeoutMs: INTERACTION_TIMEOUT_MAX_MS })
        .interactionTimeoutMs,
    ).toBe(INTERACTION_TIMEOUT_MAX_MS);
    expect(() =>
      ControlSettingsUpdateRequest.parse({ interactionTimeoutMs: 8_640_000_000_000_000 }),
    ).toThrow();
  });
});

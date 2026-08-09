import { describe, expect, it, vi } from "vitest";
import type { ControlQuotaResponse } from "@claudexor/schema";
import { quotaControlServices } from "./quota-services.js";

const raw: ControlQuotaResponse = {
  snapshots: [
    {
      subject: {
        harness: "claude",
        credential_route: "vendor_native",
        plan_label: null,
        subject_id: "work",
      },
      constraints: [
        {
          id: "fable_only",
          label: "7 day (Fable)",
          applies_to_models: ["fable"],
          used_ratio: 1,
          window_seconds: 604_800,
          resets_at: "2099-08-09T00:00:00.000Z",
          cooldown_until: null,
        },
      ],
      source: "claude_oauth_usage",
      observed_at: "2026-08-09T00:00:00.000Z",
      freshness: "fresh",
    },
  ],
  absences: [],
  refreshed_at: null,
};

describe("quotaControlServices", () => {
  it("decorates cheap and refreshed responses without changing registry-owned raw quota", async () => {
    const read = vi.fn(() => raw);
    const refresh = vi.fn(async () => raw);
    const services = quotaControlServices(() => ({ read, refresh }) as never);

    const cheap = await services.quota();
    const full = await services.refreshQuota({ model: "fable" });
    expect(cheap.snapshots[0]?.availability).toMatchObject({
      state: "available",
      blocking_constraints: [],
      model_scoped_exhaustions: [expect.objectContaining({ constraint_id: "fable_only" })],
    });
    expect(full.snapshots[0]?.availability).toMatchObject({
      state: "exhausted",
      blocking_constraints: ["fable_only"],
    });
    expect(raw.snapshots[0]).not.toHaveProperty("availability");
    expect(read).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledOnce();
  });
});

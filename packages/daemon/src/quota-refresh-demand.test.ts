import { describe, expect, it } from "vitest";
import type { QuotaSnapshot, QuotaSubject } from "@claudexor/schema";
import { remainingQuotaRefreshDemand } from "./quota-refresh-demand.js";

const subject = (harness: string, subjectId: string | null): QuotaSubject => ({
  harness,
  credential_route: "vendor_native",
  plan_label: null,
  subject_id: subjectId,
});

const snapshot = (owner: QuotaSubject, source: QuotaSnapshot["source"]): QuotaSnapshot => ({
  subject: owner,
  constraints: [],
  source,
  observed_at: "2026-08-09T00:00:00.000Z",
  freshness: "fresh",
});

describe("remainingQuotaRefreshDemand", () => {
  it("ignores subjects without a refresh-capable primary harness", () => {
    expect(remainingQuotaRefreshDemand([], [subject("cursor", "work")])).toEqual(new Set());
  });

  it("requires matching primary evidence rather than reactive evidence", () => {
    const owner = subject("codex", "work");
    expect(remainingQuotaRefreshDemand([snapshot(owner, "codex_rollout")], [owner])).toEqual(
      new Set(["codex\0work"]),
    );
    expect(remainingQuotaRefreshDemand([snapshot(owner, "codex_app_server")], [owner])).toEqual(
      new Set(),
    );
  });
});

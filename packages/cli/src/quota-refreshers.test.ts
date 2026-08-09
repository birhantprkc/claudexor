import { describe, expect, it } from "vitest";
import { quotaSourcesProducedByRefreshers } from "@claudexor/schema";
import { QUOTA_REFRESHER_REGISTRATIONS, quotaRefreshers } from "./quota-refreshers.js";

describe("quota refresher composition", () => {
  it("matches every schema source declared as produced by a refresher", () => {
    expect(QUOTA_REFRESHER_REGISTRATIONS.map(({ source }) => source).sort()).toEqual(
      quotaSourcesProducedByRefreshers().sort(),
    );
    expect(quotaRefreshers()).toHaveLength(QUOTA_REFRESHER_REGISTRATIONS.length);
  });
});

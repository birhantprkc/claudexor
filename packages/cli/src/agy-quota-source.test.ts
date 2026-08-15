import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { QuotaConstraint } from "@claudexor/schema";
import { parseAgyQuotaEnvelope } from "./agy-quota-source.js";

const FIXTURES = fileURLToPath(new URL("./__fixtures__", import.meta.url));
const read = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

describe("parseAgyQuotaEnvelope", () => {
  it("maps tier-1 (4 windows) to model-scoped constraints, both groups tagged", () => {
    const out = parseAgyQuotaEnvelope(read("agy-quota-tier1.json"));
    expect(out.kind).toBe("constraints");
    if (out.kind !== "constraints") return;
    // Every constraint validates against the schema.
    for (const c of out.constraints) expect(() => QuotaConstraint.parse(c)).not.toThrow();
    const byId = Object.fromEntries(out.constraints.map((c) => [c.id, c]));
    // remaining_fraction 1.0 -> used_ratio 0; a partial remaining inverts.
    expect(byId["gemini-weekly"].used_ratio).toBe(0);
    // Gemini windows tag only gemini slugs; the 3p group tags claude/gpt slugs.
    expect(byId["gemini-weekly"].applies_to_models).toContain("gemini-3.1-pro-high");
    expect(byId["gemini-weekly"].applies_to_models).not.toContain("claude-opus-4-6-thinking");
    expect(byId["3p-weekly"].applies_to_models).toContain("claude-opus-4-6-thinking");
    // 5h window carries its second budget.
    expect(byId["gemini-5h"].window_seconds).toBe(5 * 60 * 60);
    expect(byId["gemini-weekly"].window_seconds).toBe(7 * 24 * 60 * 60);
    expect(byId["gemini-weekly"].resets_at).toBeTruthy();
  });

  it("tolerates a lower tier with NO 5-hour windows (missing window is normal)", () => {
    const out = parseAgyQuotaEnvelope(read("agy-quota-tier2.json"));
    expect(out.kind).toBe("constraints");
    if (out.kind !== "constraints") return;
    const windows = out.constraints.map((c) => c.id);
    expect(windows).toContain("gemini-weekly");
    expect(windows).not.toContain("gemini-5h"); // tier-2 has no 5h window at all
  });

  it("classifies an auth error envelope as auth_revoked, not a snapshot", () => {
    const out = parseAgyQuotaEnvelope(
      JSON.stringify({ status: "ERROR", error: "authentication required. Run agy to log in" }),
    );
    expect(out).toMatchObject({ kind: "auth_revoked" });
  });

  it("classifies a non-auth error as failed", () => {
    const out = parseAgyQuotaEnvelope(JSON.stringify({ status: "ERROR", error: "network down" }));
    expect(out).toMatchObject({ kind: "failed" });
  });

  it("never throws on garbage input", () => {
    expect(parseAgyQuotaEnvelope("not json").kind).toBe("failed");
    expect(parseAgyQuotaEnvelope("{}").kind).toBe("failed");
    expect(parseAgyQuotaEnvelope('{"command":{"data":{"groups":[]}}}').kind).toBe("failed");
  });
});

import { describe, expect, it } from "vitest";
import { mergeEffortLadders } from "@claudexor/schema";
import { normalizeEffort, resolveEffort } from "./effort.js";

/**
 * There is NO static rank table: rank is a level's position in the ladder the
 * VENDOR advertised. `advertised` is what the resolved target accepts;
 * `ladder` (optional) is the harness's merged vendor order, which is what lets
 * a sibling model's level clamp onto this model's ceiling.
 */
describe("normalizeEffort against vendor-ordered ladders", () => {
  it("passes an exactly-supported level through unchanged", () => {
    expect(normalizeEffort("high", ["low", "medium", "high"])).toBe("high");
    expect(normalizeEffort("low", ["low", "medium", "high"])).toBe("low");
  });

  it("clamps a too-strong request DOWN inside the merged vendor order", () => {
    const MERGED = ["low", "medium", "high", "xhigh", "max", "ultra"];
    // ultra on a model that stops at xhigh -> xhigh, because the merged codex
    // ladder places ultra above it (the codex ultra->xhigh behavior).
    expect(normalizeEffort("ultra", ["low", "medium", "high", "xhigh"], MERGED)).toBe("xhigh");
    expect(normalizeEffort("max", ["low", "medium", "high", "xhigh"], MERGED)).toBe("xhigh");
  });

  it("clamps a too-weak request UP to the weakest supported level", () => {
    const MERGED = ["low", "medium", "high", "xhigh"];
    expect(normalizeEffort("low", ["high", "xhigh"], MERGED)).toBe("high");
  });

  it("clamps an interior gap to the nearest position (ties -> the cheaper level)", () => {
    const MERGED = ["low", "medium", "high", "xhigh", "max"];
    // medium is equidistant from low and high in the merged order -> the lower wins.
    expect(normalizeEffort("medium", ["low", "high"], MERGED)).toBe("low");
    // xhigh between high and max is a tie -> high (cheaper).
    expect(normalizeEffort("xhigh", ["high", "max"], MERGED)).toBe("high");
  });

  it("returns null when effort is not a tunable surface (empty supported)", () => {
    expect(normalizeEffort("high", [])).toBeNull();
    expect(normalizeEffort("max", [])).toBeNull();
  });

  it("returns null when nothing was requested", () => {
    expect(normalizeEffort(null, ["low", "medium", "high"])).toBeNull();
    expect(normalizeEffort(undefined, ["low", "medium", "high"])).toBeNull();
  });

  it("without a wider ladder, an unadvertised level cannot clamp and is refused", () => {
    // The degenerate single-list case: the target's own order IS the only order
    // known, so there is no honest position for `xhigh` here — no invented
    // "nearest", the caller discloses instead (the claude 2.1.89 shape).
    expect(normalizeEffort("xhigh", ["low", "medium", "high", "max"])).toBeNull();
    const check = resolveEffort("xhigh", ["low", "medium", "high", "max"]);
    expect(check.status).toBe("rejected");
  });
});

describe("merged-order derivation from vendor lists", () => {
  it("merges subset/prefix lists into the longest vendor ladder", () => {
    const merged = mergeEffortLadders([
      ["low", "medium", "high", "xhigh"],
      ["low", "medium", "high", "xhigh", "max", "ultra"],
      ["low", "medium", "high"],
    ]);
    expect(merged.consistent).toBe(true);
    expect(merged.order).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
  });

  it("a brand-new vendor level ('hyper') sorts by its VENDOR position, not a table", () => {
    // The generalization proof: no code here knows `hyper`, yet it lands where
    // the vendor put it — between xhigh and max — because position in the
    // advertised list IS the rank.
    const merged = mergeEffortLadders([
      ["low", "medium", "high", "xhigh", "max", "ultra"],
      ["low", "medium", "high", "xhigh", "hyper", "max"],
    ]);
    expect(merged.consistent).toBe(true);
    expect(merged.order).toEqual(["low", "medium", "high", "xhigh", "hyper", "max", "ultra"]);
    // ...and it passes through verbatim where advertised, and hosts clamps.
    expect(normalizeEffort("hyper", ["low", "xhigh", "hyper", "max"], merged.order)).toBe("hyper");
    expect(normalizeEffort("hyper", ["low", "medium", "high", "xhigh"], merged.order)).toBe(
      "xhigh",
    );
  });

  it("flags genuinely contradictory vendor orders instead of inventing one", () => {
    const merged = mergeEffortLadders([
      ["low", "high"],
      ["high", "low"],
    ]);
    expect(merged.consistent).toBe(false);
    // First-seen fallback is a display set only; clamping against it is the
    // caller's responsibility to REFUSE (pass advertised as its own ladder).
    expect(merged.order).toEqual(["low", "high"]);
  });

  it("merges the empty and trivial cases without noise", () => {
    expect(mergeEffortLadders([])).toEqual({ order: [], consistent: true });
    expect(mergeEffortLadders([[], ["low"]])).toEqual({ order: ["low"], consistent: true });
  });
});

describe("open vocabulary: levels no ladder places", () => {
  it("passes an ADVERTISED but never-seen vendor level through untouched", () => {
    // The whole point of the design: codex types ReasoningEffort as any non-empty
    // advertised string, so a level newer than this repo must work with NO code
    // change here. It must not be clamped to a neighbour we merely guessed at.
    const FUTURE = ["low", "medium", "high", "hyper"] as const;
    expect(normalizeEffort("hyper", FUTURE)).toBe("hyper");
    expect(resolveEffort("hyper", FUTURE)).toEqual({
      status: "ok",
      effort: "hyper",
      clamped: false,
    });
  });

  it("REFUSES a level the ladder cannot place, naming what IS advertised", () => {
    const CODEX_54 = ["low", "medium", "high", "xhigh"] as const;
    const check = resolveEffort("turbo", CODEX_54);
    expect(check.status).toBe("rejected");
    if (check.status !== "rejected") throw new Error("expected a rejection");
    expect(check.message).toContain("turbo");
    expect(check.message).toContain("low, medium, high, xhigh");
  });

  it("never silently downgrades an unplaceable level: the arg builder gets null, not a guess", () => {
    // A typo must not quietly become `high`. normalizeEffort answers "send no
    // flag" so the vendor default stands, and the refusal text reaches the user
    // through the surfaces that can talk back.
    expect(normalizeEffort("turbo", ["low", "medium", "high"])).toBeNull();
  });

  it("refuses to clamp when the ladder places the request but none of the advertised levels", () => {
    // Defensive shape: a ladder that knows the request but not the targets has
    // no honest landing spot either.
    const check = resolveEffort("high", ["hyper", "turbo"], ["low", "high"]);
    expect(check.status).toBe("rejected");
  });
});

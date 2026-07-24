import { describe, expect, it } from "vitest";
import { EFFORT_RANK_ORDER } from "@claudexor/schema";
import { normalizeEffort, resolveEffort } from "./effort.js";

describe("normalizeEffort", () => {
  it("passes an exactly-supported level through unchanged", () => {
    expect(normalizeEffort("high", ["low", "medium", "high"])).toBe("high");
    expect(normalizeEffort("low", ["low", "medium", "high"])).toBe("low");
  });

  it("clamps a too-strong request DOWN to the strongest supported level", () => {
    // xhigh is above the ceiling of [low,medium,high] -> high (the claude bug fix).
    expect(normalizeEffort("xhigh", ["low", "medium", "high"])).toBe("high");
    // max above a [..,xhigh] ceiling -> xhigh (the codex max->xhigh behavior).
    expect(normalizeEffort("max", ["low", "medium", "high", "xhigh"])).toBe("xhigh");
  });

  it("clamps a too-weak request UP to the weakest supported level", () => {
    expect(normalizeEffort("low", ["high", "xhigh"])).toBe("high");
  });

  it("clamps an interior gap to the nearest rank (ties -> the cheaper level)", () => {
    // medium (rank 1) is equidistant from low (0) and high (2) -> the lower wins.
    expect(normalizeEffort("medium", ["low", "high"])).toBe("low");
    // xhigh (rank 3) between high(2) and max(4) is a tie -> high (cheaper).
    expect(normalizeEffort("xhigh", ["high", "max"])).toBe("high");
  });

  it("returns null when effort is not a tunable surface (empty supported)", () => {
    expect(normalizeEffort("high", [])).toBeNull();
    expect(normalizeEffort("max", [])).toBeNull();
  });

  it("returns null when nothing was requested", () => {
    expect(normalizeEffort(null, ["low", "medium", "high"])).toBeNull();
    expect(normalizeEffort(undefined, ["low", "medium", "high"])).toBeNull();
  });
});

describe("expanded vocabulary: the open ladder (official vendor ladders)", () => {
  it("ranks the full vocabulary weakest -> strongest", () => {
    // The rank table is the SSOT for ordering; this pins it. It is deliberately
    // WIDER than what anyone advertises: none/minimal are rank positions kept so
    // they sort correctly the day a vendor ships them.
    expect([...EFFORT_RANK_ORDER]).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
  });

  it("xhigh passes through a claude-shaped ladder unchanged (regression: the old 4-level ladder silently downgraded xhigh)", () => {
    const CLAUDE = ["low", "medium", "high", "xhigh", "max"] as const;
    expect(normalizeEffort("xhigh", CLAUDE)).toBe("xhigh");
  });

  it("ultra clamps DOWN to max on a ladder without ultra (claude)", () => {
    const CLAUDE = ["low", "medium", "high", "xhigh", "max"] as const;
    expect(normalizeEffort("ultra", CLAUDE)).toBe("max");
  });

  it("max and ultra pass through a codex-shaped ladder (regression: the old ladder clamped max to xhigh, under-driving models that accept max/ultra)", () => {
    const CODEX = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
    expect(normalizeEffort("max", CODEX)).toBe("max");
    expect(normalizeEffort("ultra", CODEX)).toBe("ultra");
  });

  it("minimal clamps UP to low on ladders that exclude it (no current model advertises minimal)", () => {
    const CODEX = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
    expect(normalizeEffort("minimal", CODEX)).toBe("low");
  });
});

describe("open vocabulary: levels the rank table has never heard of", () => {
  it("passes an ADVERTISED but unrankable vendor level through untouched", () => {
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

  it("still ranks and clamps the KNOWN levels on a ladder that also advertises an unknown one", () => {
    const FUTURE = ["low", "medium", "high", "hyper"] as const;
    // `max` is rankable and unadvertised -> clamps onto the nearest RANKABLE
    // advertised level; the unrankable `hyper` can never be a clamp target.
    expect(normalizeEffort("max", FUTURE)).toBe("high");
  });

  it("REFUSES an unrankable level the model does not advertise, naming what IS advertised", () => {
    const CODEX_54 = ["low", "medium", "high", "xhigh"] as const;
    const check = resolveEffort("turbo", CODEX_54);
    expect(check.status).toBe("rejected");
    if (check.status !== "rejected") throw new Error("expected a rejection");
    expect(check.message).toContain("turbo");
    expect(check.message).toContain("low, medium, high, xhigh");
  });

  it("never silently downgrades an unrankable level: the arg builder gets null, not a guess", () => {
    // A typo must not quietly become `high`. normalizeEffort answers "send no
    // flag" so the vendor default stands, and the refusal text reaches the user
    // through the surfaces that can talk back.
    expect(normalizeEffort("turbo", ["low", "medium", "high"])).toBeNull();
  });

  it("refuses when NOTHING advertised can be ranked and the request is not one of them", () => {
    const check = resolveEffort("high", ["hyper", "turbo"]);
    expect(check.status).toBe("rejected");
  });
});

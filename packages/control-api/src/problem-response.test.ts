import { describe, expect, it } from "vitest";
import {
  controlProblemError,
  normalizeRequestValidationError,
  revertRefusedProblem,
} from "./problem-response.js";

describe("controlProblemError context projection", () => {
  it("keeps explicit context flat and merges legacy top-level recovery ids", () => {
    const error = controlProblemError(503, {
      code: "git_missing",
      message: "Git unavailable",
      retryable: true,
      context: { turnId: "tn-1", capability: "git" },
      threadId: "th-1",
    });
    expect(error.context).toEqual({
      threadId: "th-1",
      turnId: "tn-1",
      capability: "git",
    });
    expect(error.context).not.toHaveProperty("context");
  });
});

describe("request validation bounds", () => {
  it("bounds a huge attacker-controlled issue path without quadratic truncation", () => {
    const started = performance.now();
    const error = normalizeRequestValidationError({
      issues: [
        {
          code: "custom",
          path: ["x".repeat(10 * 1024 * 1024)],
          message: "invalid",
        },
      ],
    }) as Error & { fieldErrors: Record<string, string[]> };
    const elapsed = performance.now() - started;
    const [pointer] = Object.keys(error.fieldErrors);
    expect(Buffer.byteLength(pointer ?? "", "utf8")).toBeLessThanOrEqual(256);
    expect(elapsed).toBeLessThan(2_000);
  });
});

// W3 / QA-051: the revert-refusal CLASS comes from the producer's typed
// reasonCode, not from regexing the English message.
describe("revertRefusedProblem — typed reason from the producer (W3)", () => {
  it("uses the producer's typed reasonCode even when the message text disagrees", () => {
    // A localized/rewritten message that would NOT match the legacy regex; the
    // typed code still classifies it correctly.
    const p = revertRefusedProblem("git: локальная ошибка stderr", "postimage_diverged");
    expect(p.context.reason).toBe("postimage_diverged");
    expect(p.message).toContain("affected files changed after this turn");
    // The raw (redacted, bounded) vendor stderr rides as evidence, not as the message.
    expect(p.context.detail).toContain("stderr");
  });

  it("classifies reverse_apply_failed from the typed code", () => {
    const p = revertRefusedProblem("anything at all", "reverse_apply_failed");
    expect(p.context.reason).toBe("reverse_apply_failed");
    expect(p.message).toContain("could not be applied");
  });

  it("falls back to the English-prefix regex for a legacy result with no typed code", () => {
    expect(revertRefusedProblem("turn-owned postimage no longer matches; ...").context.reason).toBe(
      "postimage_diverged",
    );
    expect(revertRefusedProblem("reverse apply failed after preflight: ...").context.reason).toBe(
      "reverse_apply_failed",
    );
    expect(revertRefusedProblem(undefined).context.reason).toBe("reverse_apply_failed");
  });
});

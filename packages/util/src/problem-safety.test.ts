import { describe, expect, it } from "vitest";
import {
  safeProblemContext,
  safeProblemMessage,
  safeProblemRequiredActions,
} from "./problem-safety.js";

describe("problem safety projection", () => {
  it("redacts and bounds durable actions and structured context", () => {
    const token = `sk-${"a".repeat(40)}`;
    const message = safeProblemMessage(`failed with ${token}: ${"x".repeat(2_100)}`);
    expect(message).not.toContain(token);
    expect(message).toContain("truncated");
    expect(safeProblemMessage(new Error(""))).toBe("unknown error");

    const actions = safeProblemRequiredActions([
      `replace ${token}`,
      ...Array.from({ length: 20 }, (_, index) => `action-${index}`),
    ]);
    expect(actions).toHaveLength(16);
    expect(JSON.stringify(actions)).not.toContain(token);

    const context = safeProblemContext({
      turnId: "tn-1",
      secret: token,
      detail: "x".repeat(2_100),
      nested: { one: { two: { three: { four: "never unbounded" } } } },
    });
    expect(context.turnId).toBe("tn-1");
    expect(JSON.stringify(context)).not.toContain(token);
    expect(String(context.detail)).toContain("truncated");
    expect(JSON.stringify(context)).toContain("[bounded]");
  });

  it("applies one aggregate budget to a highly branching context", () => {
    const branch = Object.fromEntries(
      Array.from({ length: 32 }, (_, outer) => [
        `outer-${outer}`,
        Object.fromEntries(
          Array.from({ length: 32 }, (_, inner) => [
            `inner-${inner}`,
            Array.from({ length: 32 }, () => "x".repeat(2_000)),
          ]),
        ),
      ]),
    );
    const encoded = JSON.stringify(safeProblemContext(branch));
    expect(encoded.length).toBeLessThan(12_000);
  });
});

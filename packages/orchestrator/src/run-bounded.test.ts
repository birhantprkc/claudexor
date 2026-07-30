import { describe, expect, it } from "vitest";
import { runBounded } from "./run-bounded.js";

describe("runBounded", () => {
  it("waits for every admitted worker before rethrowing a sibling failure", async () => {
    let releaseSibling!: () => void;
    const sibling = new Promise<void>((resolve) => {
      releaseSibling = resolve;
    });
    let siblingSettled = false;
    const run = runBounded(["fail", "slow"], 2, async (item) => {
      if (item === "fail") throw new Error("setup rejected");
      await sibling;
      siblingSettled = true;
    });

    let rejected = false;
    void run.catch(() => {
      rejected = true;
    });
    await Promise.resolve();
    expect(rejected).toBe(false);
    expect(siblingSettled).toBe(false);

    releaseSibling();
    await expect(run).rejects.toThrow("setup rejected");
    expect(siblingSettled).toBe(true);
  });
});

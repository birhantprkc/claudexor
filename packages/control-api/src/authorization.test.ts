import { describe, expect, it } from "vitest";
import { bearerCredential } from "./authorization.js";

describe("bearerCredential", () => {
  it("accepts the HTTP scheme case-insensitively with SP or HTAB separators", () => {
    expect(bearerCredential("Bearer token-1")).toBe("token-1");
    expect(bearerCredential("bEaReR \t  token-2  ")).toBe("token-2");
  });

  it("rejects missing credentials and scans long header whitespace linearly", () => {
    const whitespace = " ".repeat(128 * 1024);
    expect(bearerCredential("Bearer" + whitespace)).toBeUndefined();
    expect(bearerCredential("Bearer" + whitespace + "token-3")).toBe("token-3");
    expect(bearerCredential("Basic" + whitespace + "token-3")).toBeUndefined();
  });
});

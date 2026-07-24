import { describe, expect, it } from "vitest";
import { createTailBuffer, boundedTail } from "./setup-login-runner.js";

describe("device-login output tail redaction (X224 ring path)", () => {
  it("a secret split by the 4096-byte ring boundary does not survive as a prefix-less fragment", () => {
    const buf = createTailBuffer();
    // Fill the ring, then push a secret whose head is cut by the boundary.
    buf.push(Buffer.from("A".repeat(4090)));
    const secret = ["sk", "ant", "DEADBEEFCAFEBABE0123456789"].join("-"); // runtime-assembled: never a literal token at rest
    buf.push(Buffer.from(secret + " trailing\n"));
    const out = buf.text();
    // The full token is redacted; the boundary fragment must not leak either.
    expect(out).not.toContain("DEADBEEFCAFEBABE0123456789");
    expect(out).toContain("trailing");
  });

  it("untruncated short output keeps its first token whole", () => {
    const buf = createTailBuffer();
    buf.push(Buffer.from("device code rejected by server\n"));
    expect(buf.text()).toBe("device code rejected by server");
  });

  it("boundedTail leaves a whole non-truncated string's leading word intact", () => {
    expect(boundedTail("firstword then rest", false)).toBe("firstword then rest");
  });
});

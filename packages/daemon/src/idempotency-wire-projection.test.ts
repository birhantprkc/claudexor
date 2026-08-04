import { describe, expect, it } from "vitest";
import { ControlRunStartRequest } from "@claudexor/schema";
import { hashJson } from "@claudexor/util";
import { idempotencyWireProjection } from "./idempotency-wire-projection.js";
import { threadCreationIdempotency, turnIdempotency } from "./thread-store-support.js";

/** The parse of this exact wire body as published 3.2.1 stored it: execution
 * exists (isolation only) and the project scope has no `ephemeral` property —
 * neither `execution.delegated` nor `scope.ephemeral` was in that schema. */
const legacyParsedShape = {
  prompt: "fix the bug",
  mode: "agent",
  scope: { kind: "project", root: "/tmp/proj", context: "auto" },
  execution: { isolation: "envelope" },
};

const wireBody = {
  prompt: "fix the bug",
  mode: "agent",
  scope: { kind: "project", root: "/tmp/proj" },
  execution: { isolation: "envelope" },
};

describe("idempotencyWireProjection (upgrade replay must return the original handle)", () => {
  it("hashes a current parse of a pre-3.3.7 wire body to the pre-3.3.7 digest", () => {
    const parsed = ControlRunStartRequest.parse(wireBody);
    // The current schema injects the two defaults the legacy engines never saw.
    expect(parsed.execution.delegated).toBe(false);
    expect(parsed.scope).toMatchObject({ ephemeral: false });
    const projected = idempotencyWireProjection(parsed) as Record<string, unknown>;
    expect(projected["execution"]).toEqual({ isolation: "envelope" });
    expect(projected["scope"]).toEqual({ kind: "project", root: "/tmp/proj", context: "auto" });
    expect(hashJson(idempotencyWireProjection(parsed))).toBe(
      hashJson(idempotencyWireProjection(legacyParsedShape)),
    );
  });

  it("keeps an explicit delegation or one-shot declaration in the digest", () => {
    const delegated = ControlRunStartRequest.parse({
      ...wireBody,
      execution: { isolation: "live", delegated: true },
    });
    const ephemeral = ControlRunStartRequest.parse({
      ...wireBody,
      scope: { kind: "project", root: "/tmp/proj", ephemeral: true },
    });
    const base = hashJson(idempotencyWireProjection(ControlRunStartRequest.parse(wireBody)));
    expect(hashJson(idempotencyWireProjection(delegated))).not.toBe(base);
    expect(hashJson(idempotencyWireProjection(ephemeral))).not.toBe(base);
    const projected = idempotencyWireProjection(delegated) as Record<string, unknown>;
    expect(projected["execution"]).toEqual({ isolation: "live", delegated: true });
  });

  it("leaves foreign shapes alone (no scope/execution, kind none, non-objects)", () => {
    expect(idempotencyWireProjection(null)).toBe(null);
    expect(idempotencyWireProjection("x")).toBe("x");
    expect(idempotencyWireProjection({ retryOf: "run-1" })).toEqual({ retryOf: "run-1" });
    const noneScope = { scope: { kind: "none" }, execution: { isolation: "envelope" } };
    expect(idempotencyWireProjection(noneScope)).toEqual(noneScope);
  });

  it("gives thread create/turn records the same digest for legacy and current parses", () => {
    const parsed = ControlRunStartRequest.parse(wireBody);
    for (const idem of [threadCreationIdempotency, turnIdempotency] as const) {
      const stored =
        idem === turnIdempotency
          ? turnIdempotency("p1", "t1", { key: "k", client: "c", request: legacyParsedShape })
          : threadCreationIdempotency("p1", { key: "k", client: "c", request: legacyParsedShape });
      const replayed =
        idem === turnIdempotency
          ? turnIdempotency("p1", "t1", { key: "k", client: "c", request: parsed })
          : threadCreationIdempotency("p1", { key: "k", client: "c", request: parsed });
      expect(stored?.requestDigest).toBe(replayed?.requestDigest);
    }
  });
});

import { describe, expect, it } from "vitest";
import type { JobRecord } from "./server.js";
import { admitDelegatedRequest } from "./delegation-admission.js";

function record(id: string, runId: string, params: Record<string, unknown>): JobRecord {
  return {
    id,
    runId,
    state: "running",
    params,
    createdAt: "2026-07-26T00:00:00.000Z",
  };
}

const parent = record("job-parent", "run-parent", { delegate: true });
const request = {
  prompt: "child",
  parentRunId: "run-parent",
  delegatedFromRunId: "run-parent",
};
const availableAuthority = { assertCanAdmitChild: () => {} };

function capturedError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected function to throw");
}

describe("daemon-atomic delegation admission", () => {
  it("accepts scoped belt lineage only when the declared Delegate parent exists", () => {
    expect(admitDelegatedRequest(request, "delegated-run", [parent], availableAuthority)).toBe(
      request,
    );
    expect(() =>
      admitDelegatedRequest(request, "ordinary-run", [parent], availableAuthority),
    ).toThrow(/reserved for the scoped belt/);
    expect(() => admitDelegatedRequest(request, "delegated-run", [])).toThrow(
      /no running Delegate parent/,
    );
  });

  it("refuses a running parent without live effective budget authority", () => {
    expect(
      capturedError(() => admitDelegatedRequest(request, "delegated-run", [parent])),
    ).toMatchObject({ code: "delegation_budget_parent_unavailable", status: 409 });
  });

  it.each(["queued", "succeeded", "failed", "cancelled", "interrupted"] as const)(
    "refuses a child when its Delegate parent is %s",
    (state) => {
      const stoppedParent = { ...parent, state };
      expect(
        capturedError(() =>
          admitDelegatedRequest(request, "delegated-run", [stoppedParent], availableAuthority),
        ),
      ).toMatchObject({ code: "delegation_parent_invalid", status: 403 });
    },
  );

  it("refuses Delegate recursion on a delegated child", () => {
    expect(
      capturedError(() =>
        admitDelegatedRequest(
          { ...request, delegate: true },
          "delegated-run",
          [parent],
          availableAuthority,
        ),
      ),
    ).toMatchObject({ code: "delegation_depth_forbidden", status: 403 });
  });

  it("uses the live authority's monotonic cap instead of prunable journal rows", () => {
    const capped = {
      assertCanAdmitChild: () => {
        throw Object.assign(new Error("delegation sub-run cap reached (8/8)"), {
          code: "delegation_subrun_cap",
          status: 409,
        });
      },
    };
    expect(() => admitDelegatedRequest(request, "delegated-run", [parent], capped)).toThrow(
      /cap reached \(8\/8\)/,
    );
  });

  it("does not count ordinary thread/retry parentRunId lineage", () => {
    const ordinary = Array.from({ length: 20 }, (_, index) =>
      record(`job-ordinary-${index}`, `run-ordinary-${index}`, {
        parentRunId: "run-parent",
      }),
    );
    expect(
      admitDelegatedRequest(request, "delegated-run", [parent, ...ordinary], availableAuthority),
    ).toBe(request);
  });
});

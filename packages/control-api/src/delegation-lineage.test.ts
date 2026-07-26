import { describe, expect, it } from "vitest";
import {
  directDelegatedChildrenFromRecords,
  delegatedDescendantsFromRecords,
  type DaemonRunRecord,
} from "./run-record.js";

function run(id: string, params: Record<string, unknown>, state = "running"): DaemonRunRecord {
  return { id: `job-${id}`, runId: id, state, params };
}

describe("Delegate lineage projection and cancellation graph", () => {
  it("walks only persisted delegatedFromRunId edges and ignores ordinary parentRunId", () => {
    const child = run("run-child", {
      parentRunId: "run-parent",
      delegatedFromRunId: "run-parent",
    });
    const grandchild = run("run-grandchild", {
      parentRunId: "run-child",
      delegatedFromRunId: "run-child",
    });
    const ordinaryFollowup = run("run-followup", { parentRunId: "run-parent" });
    expect(
      delegatedDescendantsFromRecords("run-parent", [child, grandchild, ordinaryFollowup]).map(
        (record) => record.runId,
      ),
    ).toEqual(["run-child", "run-grandchild"]);
  });

  it("breaks malformed cycles instead of looping forever", () => {
    const a = run("run-a", { delegatedFromRunId: "run-parent" });
    const b = run("run-b", { delegatedFromRunId: "run-a" });
    const duplicateA = run("run-a", { delegatedFromRunId: "run-b" });
    expect(
      delegatedDescendantsFromRecords("run-parent", [a, b, duplicateA]).map(
        (record) => record.runId,
      ),
    ).toEqual(["run-a", "run-b"]);
  });

  it("fails closed on a malformed self-edge and never returns the parent as its own child", () => {
    const self = run("run-parent", { delegatedFromRunId: "run-parent" });
    const child = run("run-child", { delegatedFromRunId: "run-parent" });
    expect(
      delegatedDescendantsFromRecords("run-parent", [self, child]).map((record) => record.runId),
    ).toEqual(["run-child"]);
    expect(
      directDelegatedChildrenFromRecords("run-parent", [self, child]).map((record) => record.runId),
    ).toEqual(["run-child"]);
  });

  it("bounds, deduplicates, and deterministically orders direct children", () => {
    const children: DaemonRunRecord[] = Array.from({ length: 10 }, (_, index) => ({
      ...run(`run-c${index}`, { delegatedFromRunId: "run-parent" }),
      createdAt: `2026-07-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
    })).reverse();
    children.push({ ...children[0]!, id: "duplicate-job" });
    children.push(run("ordinary", { parentRunId: "run-parent" }));
    expect(
      directDelegatedChildrenFromRecords("run-parent", children).map((record) => record.runId),
    ).toEqual(["run-c0", "run-c1", "run-c2", "run-c3", "run-c4", "run-c5", "run-c6", "run-c7"]);
  });

  it("chooses the same canonical duplicate across daemon-list permutations", () => {
    const older = {
      ...run("run-a", { delegatedFromRunId: "run-parent" }),
      id: "job-a-older",
      createdAt: "2026-07-01T00:00:00.000Z",
    };
    const newerDuplicate = {
      ...run("run-a", { delegatedFromRunId: "run-parent" }),
      id: "job-a-newer",
      createdAt: "2026-07-03T00:00:00.000Z",
    };
    const middle = {
      ...run("run-b", { delegatedFromRunId: "run-parent" }),
      createdAt: "2026-07-02T00:00:00.000Z",
    };
    const project = (records: DaemonRunRecord[]) =>
      directDelegatedChildrenFromRecords("run-parent", records).map(
        (record) => `${record.runId}:${record.id}`,
      );
    expect(project([older, newerDuplicate, middle])).toEqual([
      "run-a:job-a-older",
      "run-b:job-run-b",
    ]);
    expect(project([middle, newerDuplicate, older])).toEqual([
      "run-a:job-a-older",
      "run-b:job-run-b",
    ]);
    expect(directDelegatedChildrenFromRecords("run-parent", [older], 0)).toEqual([]);
  });
});

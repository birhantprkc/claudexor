import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DurableJournal } from "./index.js";

const roots: string[] = [];
const journals: DurableJournal[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const journal of journals.splice(0)) journal.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function journal(): DurableJournal {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "claudexor-selected-records-")));
  roots.push(root);
  const value = new DurableJournal({ rootDir: join(root, "journal"), partition: "global" });
  journals.push(value);
  return value;
}

describe("exact journal record selection", () => {
  it("preserves sparse sequence/cursor order and unknown types in the complete history", () => {
    const value = journal();
    value.appendBatch([
      { type: "chosen", payload: { value: 1 } },
      { type: "future.unknown", payload: { value: 2 } },
      { type: "chosen.extra", payload: { value: 3 } },
      { type: "chosen", payload: { value: 4 } },
      { type: "Chosen", payload: { value: 5 } },
      { type: "second", payload: { value: 6 } },
    ]);
    const cursor = value.cursorAt(1);
    expect(
      value.records(value.sequenceAfter(cursor), ["second", "chosen"]).map((r) => r.seq),
    ).toEqual([4, 6]);
    expect(value.records(0, []).length).toBe(0);
    expect(value.records(0, ["absent"]).length).toBe(0);
    expect(value.currentSequence()).toBe(6);
    expect(value.records().map((r) => r.type)).toEqual([
      "chosen",
      "future.unknown",
      "chosen.extra",
      "chosen",
      "Chosen",
      "second",
    ]);
    expect(value.records(1).map((r) => r.seq)).toEqual([2, 3, 4, 5, 6]);
  });

  it("does not materialize unrelated payloads and isolates selected returned objects", () => {
    const value = journal();
    value.append("chosen", { nested: { value: 1 } });
    value.append("unrelated", { unrelatedPayload: true });
    const original = JSON.stringify;
    vi.spyOn(JSON, "stringify").mockImplementation((input, replacer, space) => {
      if (input && typeof input === "object" && "unrelatedPayload" in input) {
        throw new Error("unrelated payload must not be copied");
      }
      return original(input, replacer, space);
    });
    const selected = value.records<{ nested: { value: number } }>(0, ["chosen"]);
    selected[0]!.payload.nested.value = 99;
    expect(
      value.records<{ nested: { value: number } }>(0, ["chosen"])[0]?.payload.nested.value,
    ).toBe(1);
    expect(() => value.records()).toThrow("unrelated payload must not be copied");
    vi.restoreAllMocks();
    expect(value.records()[1]?.payload).toEqual({ unrelatedPayload: true });
  });
});

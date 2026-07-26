import { describe, expect, it } from "vitest";
import { cancelDelegationFamily, type DelegationControlRecord } from "./delegation-control.js";

const parent = { id: "job-parent", runId: "run-parent", state: "running" };
const child = { id: "job-child", runId: "run-child", state: "running" };

describe("cancelDelegationFamily", () => {
  it("fences before the child snapshot, cancels descendants, then drains them", async () => {
    const order: string[] = [];
    const records = new Map<string, DelegationControlRecord>([[child.id, { ...child }]]);
    const result = await cancelDelegationFamily({
      daemon: {
        async fenceDelegationParent() {
          order.push("fence");
        },
        async cancel(id) {
          order.push(`cancel:${id}`);
          const record = records.get(id);
          if (record) record.state = "cancelled";
        },
        async status(id) {
          order.push(`status:${id}`);
          return records.get(id)!;
        },
      },
      parent,
      descendantsAfterFence: async () => {
        order.push("snapshot");
        return [...records.values()];
      },
    });
    expect(result.descendants).toEqual([expect.objectContaining({ id: "job-child" })]);
    expect(order).toEqual([
      "fence",
      "snapshot",
      "cancel:job-child",
      "cancel:job-parent",
      "status:job-child",
    ]);
  });

  it("cancels the parent before snapshot when the dedicated fence is unavailable", async () => {
    const order: string[] = [];
    const result = await cancelDelegationFamily({
      daemon: {
        async cancel(id) {
          order.push(`cancel:${id}`);
        },
        async status() {
          return { ...child, state: "cancelled" };
        },
      },
      parent,
      descendantsAfterFence: async () => {
        order.push("snapshot");
        return [];
      },
    });
    expect(result.descendants).toEqual([]);
    expect(order).toEqual(["cancel:job-parent", "snapshot"]);
  });

  it("still signals the parent and reports a typed incomplete result when snapshot or child cancel fails", async () => {
    const cancelled: string[] = [];
    await expect(
      cancelDelegationFamily({
        daemon: {
          async fenceDelegationParent() {},
          async cancel(id) {
            cancelled.push(id);
            if (id === child.id) throw new Error("child abort failed");
          },
          async status() {
            return { ...child, state: "cancelled" };
          },
        },
        parent,
        descendantsAfterFence: async () => [child],
      }),
    ).rejects.toMatchObject({ code: "delegation_cancel_incomplete", status: 503 });
    expect(cancelled).toEqual(["job-child", "job-parent"]);

    cancelled.length = 0;
    await expect(
      cancelDelegationFamily({
        daemon: {
          async fenceDelegationParent() {},
          async cancel(id) {
            cancelled.push(id);
          },
          async status() {
            throw new Error("unreachable");
          },
        },
        parent,
        descendantsAfterFence: async () => {
          throw new Error("list failed");
        },
      }),
    ).rejects.toMatchObject({ code: "delegation_cancel_incomplete", status: 503 });
    expect(cancelled).toEqual(["job-parent"]);
  });
});

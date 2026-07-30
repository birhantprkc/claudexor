import { describe, expect, it, vi } from "vitest";
import type { DaemonRunRecord } from "./daemon-server.js";
import { inspectThreadTurnCreateReplay, resolveThreadRecoveryTurn } from "./thread-recovery.js";

const source: DaemonRunRecord = {
  id: "job-source",
  runId: "run-source",
  state: "succeeded",
  params: { threadId: "th-1", turnId: "tn-source" },
};

const idempotency = {
  key: "same-key",
  client: "control-api",
  request: { retryOf: "run-source" },
};

describe("thread recovery admission", () => {
  it("refuses a runless idempotent turn after the conversation moved on", async () => {
    const list = vi.fn(async () => []);
    const createThreadTurn = vi.fn();

    await expect(
      resolveThreadRecoveryTurn(
        { list },
        {
          findThreadTurnByIdempotency: async () => ({ id: "tn-orphan" }),
          createThreadTurn,
          threadDetail: async () => ({
            thread: {},
            sessions: [],
            turns: [{ id: "tn-orphan" }, { id: "tn-newer" }],
          }),
        },
        source,
        "th-1",
        "retry",
        {},
        idempotency,
        async () => null,
      ),
    ).rejects.toMatchObject({ code: "thread_turn_not_latest", status: 409 });
    expect(list).not.toHaveBeenCalled();
    expect(createThreadTurn).not.toHaveBeenCalled();
  });

  it("returns the original accepted handle even after the conversation moved on", async () => {
    const list = vi.fn(async () => {
      throw new Error("idle state must not replace an accepted replay");
    });
    const threadDetail = vi.fn();

    await expect(
      resolveThreadRecoveryTurn(
        { list },
        {
          findThreadTurnByIdempotency: async () => ({ id: "tn-original" }),
          createThreadTurn: vi.fn(),
          threadDetail,
        },
        source,
        "th-1",
        "retry",
        {},
        idempotency,
        async () => ({ id: "job-original" }),
      ),
    ).resolves.toEqual({ id: "tn-original" });
    expect(threadDetail).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it("refuses a bound recovery turn after its accepted command was retained away", async () => {
    await expect(
      resolveThreadRecoveryTurn(
        { list: async () => [] },
        {
          findThreadTurnByIdempotency: async () => ({ id: "tn-bound" }),
          createThreadTurn: vi.fn(),
          threadDetail: async () => ({
            thread: {},
            sessions: [],
            turns: [{ id: "tn-bound", run_id: "run-original" }],
          }),
        },
        source,
        "th-1",
        "retry",
        {},
        idempotency,
        async () => null,
      ),
    ).rejects.toMatchObject({ code: "thread_turn_already_bound", status: 409 });
  });

  it("refuses a bound ordinary turn after its accepted command was retained away", async () => {
    await expect(
      inspectThreadTurnCreateReplay(
        {
          findAccepted: async () => null,
        },
        {
          findThreadTurnByIdempotency: async () => ({ id: "tn-bound" }),
          threadDetail: async () => ({
            thread: {},
            sessions: [],
            turns: [{ id: "tn-bound", run_id: "run-original" }],
          }),
        },
        "th-1",
        { ...idempotency, request: { threadId: "th-1", body: { prompt: "old" } } },
      ),
    ).rejects.toMatchObject({ code: "thread_turn_already_bound", status: 409 });
  });
});

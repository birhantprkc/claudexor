import { afterEach, describe, expect, it, vi } from "vitest";
import { INTERACTION_TIMEOUT_MAX_MS } from "@claudexor/schema";
import { interactionChannelFor } from "./interaction.js";

type CapturedEvent = { type: string; payload: Record<string, unknown> };

function eventLog(events: CapturedEvent[]) {
  return {
    emit(type: string, payload: Record<string, unknown>) {
      events.push({ type, payload });
    },
  };
}

function request() {
  return {
    interaction_id: "int-1",
    source_tool: "AskUserQuestion",
    questions: [],
  };
}

afterEach(() => vi.useRealTimers());

describe("interactionChannelFor finite-or-disabled policy", () => {
  it("emits a nullable deadline and never age-expires a disabled interaction", async () => {
    vi.useFakeTimers();
    const events: CapturedEvent[] = [];
    const controller = new AbortController();
    const channel = interactionChannelFor(
      {
        interactionTimeoutMs: null,
        signal: controller.signal,
        onInteraction: () => new Promise(() => undefined),
      },
      eventLog(events) as never,
      "run-1",
      "task-1",
      "a01",
      "claude",
      true,
      900_000,
    );
    const pending = channel!.request(request() as never);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(900_001);

    expect(settled).toBe(false);
    expect(
      events.find((event) => event.type === "interaction.requested")?.payload["timeout_at"],
    ).toBeNull();
    expect(events.some((event) => event.type === "interaction.timeout")).toBe(false);

    controller.abort();
    await expect(pending).resolves.toBeNull();
    expect(channel!.pendingCount!()).toBe(0);
    expect(events.filter((event) => event.type === "interaction.timeout")).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ reason: "cancelled" }) }),
    ]);
  });

  it("keeps the finite policy and emits one benign automatic timeout", async () => {
    vi.useFakeTimers();
    const events: CapturedEvent[] = [];
    const channel = interactionChannelFor(
      {
        interactionTimeoutMs: 50,
        onInteraction: () => new Promise(() => undefined),
      },
      eventLog(events) as never,
      "run-2",
      "task-2",
      "a01",
      "claude",
      true,
      900_000,
    );
    const pending = channel!.request(request() as never);
    await vi.advanceTimersByTimeAsync(50);
    await expect(pending).resolves.toBeNull();
    const requested = events.find((event) => event.type === "interaction.requested");
    expect(typeof requested?.payload["timeout_at"]).toBe("string");
    expect(events.filter((event) => event.type === "interaction.timeout")).toHaveLength(1);
  });

  it("releases a disabled wait when its live answer owner terminates", async () => {
    const events: CapturedEvent[] = [];
    const channel = interactionChannelFor(
      {
        interactionTimeoutMs: null,
        onInteraction: async () => null,
      },
      eventLog(events) as never,
      "run-3",
      "task-3",
      "a01",
      "claude",
      true,
      900_000,
    );
    await expect(channel!.request(request() as never)).resolves.toBeNull();
    expect(channel!.pendingCount!()).toBe(0);
    expect(events.some((event) => event.type === "interaction.timeout")).toBe(false);
  });

  it("preserves a daemon-owned timeout disposition and emits exactly one timeout", async () => {
    const events: CapturedEvent[] = [];
    const channel = interactionChannelFor(
      {
        interactionTimeoutMs: 50,
        onInteraction: async () => ({ kind: "released", reason: "timeout" }),
      },
      eventLog(events) as never,
      "run-daemon-timeout",
      "task-daemon-timeout",
      "a01",
      "claude",
      true,
      900_000,
    );

    await expect(channel!.request(request() as never)).resolves.toBeNull();
    expect(events.filter((event) => event.type === "interaction.timeout")).toHaveLength(1);
  });

  it("does not relabel a daemon terminal release as a timeout", async () => {
    const events: CapturedEvent[] = [];
    const channel = interactionChannelFor(
      {
        interactionTimeoutMs: 1,
        onInteraction: async () => ({ kind: "released", reason: "run_terminal" }),
      },
      eventLog(events) as never,
      "run-terminal-release",
      "task-terminal-release",
      "a01",
      "claude",
      true,
      900_000,
    );

    await expect(channel!.request(request() as never)).resolves.toBeNull();
    expect(events.some((event) => event.type === "interaction.timeout")).toBe(false);
  });

  it("does not let a tagged release invent expiry under a disabled policy", async () => {
    const events: CapturedEvent[] = [];
    const channel = interactionChannelFor(
      {
        interactionTimeoutMs: null,
        onInteraction: async () => ({ kind: "released", reason: "timeout" }),
      },
      eventLog(events) as never,
      "run-disabled-release",
      "task-disabled-release",
      "a01",
      "claude",
      true,
      900_000,
    );

    await expect(channel!.request(request() as never)).resolves.toBeNull();
    expect(events.some((event) => event.type === "interaction.timeout")).toBe(false);
  });

  it("chunks a finite timeout above Node's single-timer ceiling", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T00:00:00.000Z"));
    const events: CapturedEvent[] = [];
    const timeoutMs = 2_147_483_647 + 5_000;
    const channel = interactionChannelFor(
      {
        interactionTimeoutMs: timeoutMs,
        onInteraction: () => new Promise(() => undefined),
      },
      eventLog(events) as never,
      "run-large",
      "task-large",
      "a01",
      "claude",
      true,
      900_000,
    );
    const pending = channel!.request(request() as never);

    await vi.advanceTimersByTimeAsync(2_147_483_647);
    expect(events.some((event) => event.type === "interaction.timeout")).toBe(false);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(events.some((event) => event.type === "interaction.timeout")).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toBeNull();
    expect(events.filter((event) => event.type === "interaction.timeout")).toHaveLength(1);
  });

  it("accepts the schema maximum and materializes the first question deadline", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-07-28T00:00:00.000Z");
    vi.setSystemTime(now);
    const events: CapturedEvent[] = [];
    const controller = new AbortController();
    const channel = interactionChannelFor(
      {
        interactionTimeoutMs: INTERACTION_TIMEOUT_MAX_MS,
        signal: controller.signal,
        onInteraction: () => new Promise(() => undefined),
      },
      eventLog(events) as never,
      "run-max",
      "task-max",
      "a01",
      "claude",
      true,
      900_000,
    );
    const pending = channel!.request(request() as never);
    await vi.advanceTimersByTimeAsync(1);

    expect(
      events.find((event) => event.type === "interaction.requested")?.payload["timeout_at"],
    ).toBe(new Date(now.getTime() + INTERACTION_TIMEOUT_MAX_MS).toISOString());
    expect(events.some((event) => event.type === "interaction.timeout")).toBe(false);

    controller.abort();
    await expect(pending).resolves.toBeNull();
  });

  it("rejects a duration outside the schema-owned finite domain", () => {
    expect(() =>
      interactionChannelFor(
        {
          interactionTimeoutMs: 8_640_000_000_000_000,
          onInteraction: () => new Promise(() => undefined),
        },
        eventLog([]) as never,
        "run-too-large",
        "task-too-large",
        "a01",
        "claude",
        true,
        900_000,
      ),
    ).toThrow("interaction timeout exceeds the supported maximum");
  });
});

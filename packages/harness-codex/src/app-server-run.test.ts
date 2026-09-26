import type { SpawnOptions, spawnProcess } from "@claudexor/core";
import { HarnessRunSpec, type HarnessEvent } from "@claudexor/schema";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { codexAppServerInput } from "./attachments.js";
import {
  CodexAppServerController,
  codexAppServerEvents,
  codexAppServerThreadParams,
  runCodexAppServer,
  type CodexAppServerRunInput,
} from "./app-server-run.js";
import type { CodexParseState } from "./parse.js";
import { createCodexAdapter } from "./index.js";

describe("Codex app-server transport", () => {
  it("initializes, starts a thread and turn, and exposes the native thread id", async () => {
    const writes: Array<Record<string, unknown>> = [];
    const replies: string[] = [];
    let wake: (() => void) | undefined;
    let stopped = false;

    const push = (message: unknown): void => {
      replies.push(JSON.stringify(message));
      wake?.();
      wake = undefined;
    };
    const spawn: typeof spawnProcess = async function* (_bin, args, options: SpawnOptions = {}) {
      expect(args).toEqual(["app-server", "--stdio"]);
      options.onSpawn?.({
        write(data) {
          const request = JSON.parse(data) as {
            id?: number;
            method: string;
            params?: Record<string, unknown> | null;
          };
          writes.push(request);
          if (request.method === "initialize") {
            push({ id: request.id, result: {} });
          } else if (request.method === "thread/start") {
            push({ id: request.id, result: { thread: { id: "thread-1" } } });
            push({
              method: "mcpServer/startupStatus/updated",
              params: { threadId: "thread-1", name: "required_one", status: "starting" },
            });
            push({
              method: "mcpServer/startupStatus/updated",
              params: { threadId: "thread-1", name: "required_one", status: "ready" },
            });
          } else if (request.method === "turn/start") {
            push({ id: request.id, result: { turn: { id: "turn-1" } } });
            push({
              method: "turn/started",
              params: { threadId: "thread-1", turn: { id: "turn-1" } },
            });
          }
        },
        end() {
          stopped = true;
          wake?.();
        },
        closed: Promise.resolve(),
      });
      try {
        while (!stopped) {
          if (replies.length === 0) {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
            continue;
          }
          yield { type: "stdout", line: replies.shift()! };
        }
      } finally {
        stopped = true;
      }
    };

    const spec = HarnessRunSpec.parse({
      session_id: "session-1",
      intent: "implement",
      prompt: "Keep working",
      cwd: process.cwd(),
      output_schema: false,
      extra_mcp_servers: [
        { name: "required_one", command: "/bin/echo", args: [], env: {}, required: true },
      ],
    });
    let first: HarnessEvent | undefined;
    for await (const event of runCodexAppServer({
      bin: "codex",
      args: [],
      spec,
      env: {},
      spawn,
    })) {
      first = event;
      break;
    }

    expect(writes.map((request) => request.id).filter(Boolean)).toEqual([1, 2, 3]);
    expect(writes.map((request) => request.method)).toEqual([
      "initialize",
      "initialized",
      "thread/start",
      "turn/start",
    ]);
    expect(writes[0]?.params).toMatchObject({
      clientInfo: { name: "claudexor" },
      capabilities: { experimentalApi: true },
    });
    expect(writes.find((request) => request.method === "turn/start")?.params).toMatchObject({
      outputSchema: false,
    });
    expect(first).toMatchObject({
      type: "started",
      session_id: "session-1",
      payload: {
        native_session_id: "thread-1",
        native_turn_id: "turn-1",
        mcp_servers: [{ name: "required_one", status: "connected" }],
      },
    });
  });

  it("types a required MCP startup failure notification before starting the turn", async () => {
    const methods: string[] = [];
    const replies: string[] = [];
    let wake: (() => void) | undefined;
    let stop = false;
    const push = (message: unknown): void => {
      replies.push(JSON.stringify(message));
      wake?.();
      wake = undefined;
    };
    const spawn: typeof spawnProcess = async function* (_bin, _args, options = {}) {
      options.onSpawn?.({
        write(data) {
          const request = JSON.parse(data) as { id?: number; method: string };
          methods.push(request.method);
          if (request.method === "initialize") push({ id: request.id, result: {} });
          if (request.method === "thread/start") {
            push({ id: request.id, result: { thread: { id: "thread-mcp-failure" } } });
            push({
              method: "mcpServer/startupStatus/updated",
              params: {
                threadId: "thread-mcp-failure",
                name: "required_one",
                status: "starting",
              },
            });
            push({
              method: "mcpServer/startupStatus/updated",
              params: {
                threadId: "thread-mcp-failure",
                name: "required_one",
                status: "failed",
                error: "unavailable",
              },
            });
          }
        },
        end() {
          stop = true;
          wake?.();
        },
        closed: Promise.resolve(),
      });
      options.abortSignal?.addEventListener(
        "abort",
        () => {
          stop = true;
          wake?.();
        },
        { once: true },
      );
      while (!stop || replies.length) {
        if (replies.length) yield { type: "stdout", line: replies.shift()! };
        else
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
      }
    };
    const events: HarnessEvent[] = [];
    for await (const event of runCodexAppServer({
      bin: "codex",
      args: [],
      spec: HarnessRunSpec.parse({
        session_id: "session-mcp-failure",
        intent: "implement",
        prompt: "work",
        cwd: process.cwd(),
        extra_mcp_servers: [
          { name: "required_one", command: "/bin/echo", args: [], env: {}, required: true },
        ],
      }),
      env: {},
      spawn,
    }))
      events.push(event);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "error",
        payload: {
          code: "required_mcp_startup_failed",
          mcp_servers: [{ name: "required_one", status: "failed" }],
        },
      }),
    );
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      payload: { harness_reported_error: true },
    });
    expect(events.at(-1)?.aborted).toBeUndefined();
    expect(methods).not.toContain("turn/start");
  });

  it("preserves run settings and verified image input", () => {
    const imagePath = fileURLToPath(import.meta.url);
    const imageBytes = readFileSync(imagePath);
    const spec = HarnessRunSpec.parse({
      session_id: "session-parity",
      intent: "implement",
      prompt: "Inspect it",
      instructions: "Stay terse",
      cwd: process.cwd(),
      access: "readonly",
      model_hint: "gpt-test",
      effort_hint: "high",
      external_context_policy: "off",
      output_schema: { type: "object" },
      attachments: [
        {
          resource_id: "image-1",
          kind: "image",
          mime: "image/png",
          name: "image.png",
          path: imagePath,
          sha256: `sha256:${createHash("sha256").update(imageBytes).digest("hex")}`,
          size_bytes: imageBytes.length,
        },
      ],
      extra_mcp_servers: [
        {
          name: "claudexor",
          command: "/bin/echo",
          args: ["server"],
          env: { RUN_ID: "run-1" },
          required: true,
        },
      ],
    });

    expect(codexAppServerThreadParams(spec)).toMatchObject({
      cwd: process.cwd(),
      model: "gpt-test",
      sandbox: "read-only",
      approvalPolicy: "never",
      approvalsReviewer: "auto_review",
      developerInstructions: "Stay terse",
      config: {
        web_search: "disabled",
        model_reasoning_effort: "high",
        mcp_servers: {
          claudexor: {
            command: "/bin/echo",
            args: ["server"],
            env: { RUN_ID: "run-1" },
            required: true,
          },
        },
      },
    });
    expect(codexAppServerInput(spec)).toEqual([
      { type: "text", text: "Inspect it" },
      { type: "localImage", path: imagePath },
    ]);
  });

  it("maps app-server item, plan, and usage notifications to existing events", () => {
    const state: CodexParseState = {};
    expect(
      codexAppServerEvents(
        {
          method: "item/started",
          params: {
            item: {
              type: "commandExecution",
              id: "cmd-1",
              command: "sleep 10",
              status: "inProgress",
            },
          },
        },
        "session-map",
        state,
      ),
    ).toMatchObject([{ type: "tool_call", tool: { use_id: "cmd-1" } }]);
    expect(
      codexAppServerEvents(
        {
          method: "turn/plan/updated",
          params: { plan: [{ step: "Wait", status: "inProgress" }] },
        },
        "session-map",
        state,
      )?.[0]?.plan_progress,
    ).toEqual({ items: [{ id: "codex-0", title: "Wait", status: "in_progress" }] });
    expect(
      codexAppServerEvents(
        {
          method: "thread/tokenUsage/updated",
          params: {
            tokenUsage: {
              last: {
                inputTokens: 11,
                cachedInputTokens: 3,
                cacheWriteInputTokens: 2,
                outputTokens: 5,
              },
            },
          },
        },
        "session-map",
        state,
      ),
    ).toMatchObject([
      {
        type: "usage",
        usage: {
          input_tokens: 11,
          cached_input_tokens: 3,
          output_tokens: 5,
          input_token_usage: {
            total_tokens: 11,
            cache_read_tokens: 3,
            cache_write_tokens: 2,
          },
        },
      },
    ]);
    expect(
      codexAppServerEvents(
        {
          method: "item/completed",
          params: {
            item: {
              type: "fileChange",
              id: "patch-1",
              changes: [{ path: "one.ts" }, { path: "two.ts" }],
            },
          },
        },
        "session-map",
        state,
      ),
    ).toMatchObject([
      { type: "file_change", payload: { path: "one.ts" } },
      { type: "file_change", payload: { path: "two.ts" } },
    ]);
  });

  it("keeps one run active across a goal continuation and owned background terminal", async () => {
    const replies: string[] = [];
    let wake: (() => void) | undefined;
    let stop = false;
    let snapshot = 0;
    const push = (message: unknown): void => {
      replies.push(JSON.stringify(message));
      wake?.();
      wake = undefined;
    };
    const spawn: typeof spawnProcess = async function* (_bin, _args, options = {}) {
      options.onSpawn?.({
        write(data) {
          const request = JSON.parse(data) as { id?: number; method: string };
          if (request.method === "initialize") push({ id: request.id, result: {} });
          if (request.method === "thread/start")
            push({ id: request.id, result: { thread: { id: "thread-bg" } } });
          if (request.method === "turn/start") {
            push({ id: request.id, result: { turn: { id: "turn-1" } } });
            push({
              method: "turn/started",
              params: { threadId: "thread-bg", turn: { id: "turn-1" } },
            });
            push({
              method: "item/completed",
              params: {
                item: { type: "agentMessage", id: "msg-1", text: "intermediate" },
              },
            });
            push({
              method: "item/started",
              params: {
                item: {
                  type: "commandExecution",
                  id: "cmd-owned",
                  command: "sleep 10",
                  status: "inProgress",
                },
              },
            });
            push({
              method: "turn/completed",
              params: {
                threadId: "thread-bg",
                turn: { id: "turn-1", status: "completed", items: [] },
              },
            });
          }
          if (request.method === "thread/goal/get") {
            push({
              id: request.id,
              result: { goal: { status: snapshot === 0 ? "active" : "complete" } },
            });
          }
          if (request.method === "thread/read") {
            push({
              id: request.id,
              result: {
                thread: { status: { type: snapshot === 0 ? "active" : "idle" } },
              },
            });
          }
          if (request.method === "thread/backgroundTerminals/list") {
            push({
              id: request.id,
              result: {
                data: snapshot++ === 0 ? [{ itemId: "cmd-owned", processId: "process-1" }] : [],
              },
            });
            if (snapshot === 1) {
              push({
                method: "turn/started",
                params: { threadId: "thread-bg", turn: { id: "turn-2" } },
              });
              push({
                method: "item/completed",
                params: { item: { type: "agentMessage", id: "msg-2", text: "final" } },
              });
              push({
                method: "turn/completed",
                params: {
                  threadId: "thread-bg",
                  turn: { id: "turn-2", status: "completed", items: [] },
                },
              });
            } else {
              stop = true;
              wake?.();
            }
          }
        },
        end() {
          stop = true;
          wake?.();
        },
        closed: Promise.resolve(),
      });
      while (!stop || replies.length) {
        if (replies.length === 0) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        } else {
          yield { type: "stdout", line: replies.shift()! };
        }
      }
    };
    const spec = HarnessRunSpec.parse({
      session_id: "session-bg",
      intent: "implement",
      prompt: "work",
      cwd: process.cwd(),
    });
    const events: HarnessEvent[] = [];
    for await (const event of runCodexAppServer({
      bin: "codex",
      args: [],
      spec,
      env: {},
      spawn,
      pollIntervalMs: 0,
    }))
      events.push(event);

    expect(events.filter((event) => event.type === "started")).toHaveLength(1);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "message", text: "intermediate" }),
    );
    expect(events.find((event) => event.text === "intermediate")?.final).toBeUndefined();
    expect(events.filter((event) => event.final)).toEqual([
      expect.objectContaining({ type: "message", text: "final", final: true }),
    ]);
    expect(events.at(-1)?.type).toBe("completed");
    expect(events.at(-1)?.aborted).toBeUndefined();
  });

  it("waits for owned background before terminalizing a native system error", async () => {
    const replies: string[] = [];
    let wake: (() => void) | undefined;
    let stop = false;
    let snapshots = 0;
    const push = (message: unknown): void => {
      replies.push(JSON.stringify(message));
      wake?.();
      wake = undefined;
    };
    const spawn: typeof spawnProcess = async function* (_bin, _args, options = {}) {
      options.onSpawn?.({
        write(data) {
          const request = JSON.parse(data) as { id?: number; method: string };
          if (request.method === "initialize") push({ id: request.id, result: {} });
          if (request.method === "thread/start")
            push({ id: request.id, result: { thread: { id: "thread-wait" } } });
          if (request.method === "turn/start") {
            push({ id: request.id, result: { turn: { id: "turn-wait" } } });
            push({
              method: "turn/started",
              params: { turn: { id: "turn-wait" } },
            });
            push({
              method: "item/started",
              params: {
                item: {
                  type: "commandExecution",
                  id: "cmd-wait",
                  command: "sleep 10",
                  status: "inProgress",
                },
              },
            });
            push({
              method: "item/completed",
              params: { item: { type: "agentMessage", id: "msg-wait", text: "done" } },
            });
            push({
              method: "turn/completed",
              params: {
                turn: {
                  id: "turn-wait",
                  status: "failed",
                  error: { message: "native failed" },
                  items: [],
                },
              },
            });
          }
          if (request.method === "thread/read")
            push({
              id: request.id,
              result: { thread: { status: { type: snapshots ? "systemError" : "active" } } },
            });
          if (request.method === "thread/goal/get")
            push({ id: request.id, result: { goal: { status: "complete" } } });
          if (request.method === "thread/backgroundTerminals/list") {
            push({
              id: request.id,
              result: {
                data: snapshots++
                  ? [{ itemId: "unrelated", processId: "process-unrelated" }]
                  : [
                      { itemId: "cmd-wait", processId: "process-wait" },
                      { itemId: "unrelated", processId: "process-unrelated" },
                    ],
              },
            });
            if (snapshots === 2) {
              stop = true;
              wake?.();
            }
          }
        },
        end() {
          stop = true;
          wake?.();
        },
        closed: Promise.resolve(),
      });
      while (!stop || replies.length) {
        if (replies.length) yield { type: "stdout", line: replies.shift()! };
        else
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
      }
    };
    const spec = HarnessRunSpec.parse({
      session_id: "session-wait",
      intent: "implement",
      prompt: "work",
      cwd: process.cwd(),
    });
    const events: HarnessEvent[] = [];
    for await (const event of runCodexAppServer({
      bin: "codex",
      args: [],
      spec,
      env: {},
      spawn,
      pollIntervalMs: 0,
    }))
      events.push(event);

    expect(snapshots).toBe(2);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "error", error: "native failed" }),
    );
    expect(events.at(-1)?.type).toBe("completed");
  });

  it("Stop pauses the goal, interrupts the exact turn, and terminates only owned terminals", async () => {
    const writes: Array<{ id?: number; method: string; params?: Record<string, unknown> }> = [];
    const replies: string[] = [];
    let wake: (() => void) | undefined;
    let stop = false;
    let paused = false;
    let interrupted = false;
    const terminated = new Set<string>();
    let resolveQueued!: () => void;
    const queued = new Promise<void>((resolve) => {
      resolveQueued = resolve;
    });
    const push = (message: unknown): void => {
      replies.push(JSON.stringify(message));
      wake?.();
      wake = undefined;
    };
    const spawn: typeof spawnProcess = async function* (_bin, _args, options = {}) {
      options.onSpawn?.({
        write(data) {
          const request = JSON.parse(data) as (typeof writes)[number];
          writes.push(request);
          if (request.method === "initialize") push({ id: request.id, result: {} });
          if (request.method === "thread/start")
            push({ id: request.id, result: { thread: { id: "thread-stop" } } });
          if (request.method === "turn/start") {
            push({ id: request.id, result: { turn: { id: "turn-stop" } } });
            push({
              method: "turn/started",
              params: { turn: { id: "turn-stop" } },
            });
            push({
              method: "item/completed",
              params: { item: { type: "agentMessage", id: "msg-stop", text: "waiting" } },
            });
            push({
              method: "turn/completed",
              params: { turn: { id: "turn-stop", status: "completed", items: [] } },
            });
            push({ method: "turn/started", params: { turn: { id: "turn-next" } } });
            push({
              method: "item/started",
              params: {
                item: {
                  type: "commandExecution",
                  id: "cmd-stop",
                  command: "sleep 60",
                  status: "inProgress",
                },
              },
            });
            push({
              method: "item/started",
              params: {
                item: {
                  type: "commandExecution",
                  id: "cmd-stop-late",
                  command: "sleep 60",
                  status: "inProgress",
                },
              },
            });
          }
          if (request.method === "thread/goal/get")
            push({ id: request.id, result: { goal: { status: paused ? "paused" : "active" } } });
          if (request.method === "thread/goal/set") {
            paused = true;
            push({ id: request.id, result: { goal: { status: "paused" } } });
          }
          if (request.method === "turn/interrupt") {
            interrupted = true;
            push({ id: request.id, result: {} });
            push({
              method: "turn/completed",
              params: { turn: { id: "turn-next", status: "interrupted", items: [] } },
            });
          }
          if (request.method === "thread/backgroundTerminals/list")
            push({
              id: request.id,
              result: {
                data:
                  request.params?.["cursor"] === "owned-page"
                    ? !terminated.has("process-owned")
                      ? [{ itemId: "cmd-stop", processId: "process-owned" }]
                      : !terminated.has("process-late")
                        ? [{ itemId: "cmd-stop-late", processId: "process-late" }]
                        : []
                    : [{ itemId: "other", processId: "process-unrelated" }],
                nextCursor: request.params?.["cursor"] === "owned-page" ? null : "owned-page",
              },
            });
          if (request.method === "thread/backgroundTerminals/terminate") {
            terminated.add(String(request.params?.["processId"]));
            push({ id: request.id, result: {} });
          }
          if (request.method === "thread/read")
            push({
              id: request.id,
              result: {
                thread: {
                  status: { type: interrupted && terminated.size === 2 ? "idle" : "active" },
                },
              },
            });
        },
        end() {
          stop = true;
          wake?.();
        },
        closed: Promise.resolve(),
      });
      options.abortSignal?.addEventListener(
        "abort",
        () => {
          stop = true;
          wake?.();
        },
        { once: true },
      );
      while (!stop || replies.length) {
        if (replies.length) {
          const line = replies.shift()!;
          yield { type: "stdout", line };
          const delivered = JSON.parse(line) as {
            method?: string;
            params?: { item?: { id?: string } };
          };
          if (delivered.method === "item/started" && delivered.params?.item?.id === "cmd-stop-late")
            resolveQueued();
        } else
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
      }
    };
    const spec = HarnessRunSpec.parse({
      session_id: "session-stop",
      intent: "implement",
      prompt: "work",
      cwd: process.cwd(),
    });
    const controller = new CodexAppServerController();
    const events: HarnessEvent[] = [];
    for await (const event of runCodexAppServer({
      bin: "codex",
      args: [],
      spec,
      env: {},
      spawn,
      controller,
      pollIntervalMs: 0,
      cancelDeadlineMs: 100,
    })) {
      events.push(event);
      if (event.type === "message") {
        await queued;
        await Promise.all([controller.cancel(), controller.cancel()]);
      }
    }

    expect(writes.filter((request) => request.method === "thread/goal/set")).toHaveLength(1);
    expect(writes.filter((request) => request.method === "turn/interrupt")).toEqual([
      expect.objectContaining({ params: { threadId: "thread-stop", turnId: "turn-next" } }),
    ]);
    expect(
      writes.filter((request) => request.method === "thread/backgroundTerminals/terminate"),
    ).toEqual([
      expect.objectContaining({
        params: { threadId: "thread-stop", processId: "process-owned" },
      }),
      expect.objectContaining({
        params: { threadId: "thread-stop", processId: "process-late" },
      }),
    ]);
    expect(events.at(-1)).toMatchObject({ type: "completed", aborted: true });
  });

  it("Stop pauses a goal between continuation turns without guessing a turn id", async () => {
    const methods: string[] = [];
    const replies: string[] = [];
    let wake: (() => void) | undefined;
    let stop = false;
    let paused = false;
    let resolveGap!: () => void;
    const gap = new Promise<void>((resolve) => {
      resolveGap = resolve;
    });
    const push = (message: unknown): void => {
      replies.push(JSON.stringify(message));
      wake?.();
      wake = undefined;
    };
    const spawn: typeof spawnProcess = async function* (_bin, _args, options = {}) {
      options.onSpawn?.({
        write(data) {
          const request = JSON.parse(data) as { id?: number; method: string };
          methods.push(request.method);
          if (request.method === "initialize") push({ id: request.id, result: {} });
          if (request.method === "thread/start")
            push({ id: request.id, result: { thread: { id: "thread-gap" } } });
          if (request.method === "turn/start") {
            push({ id: request.id, result: { turn: { id: "turn-gap" } } });
            push({ method: "turn/started", params: { turn: { id: "turn-gap" } } });
            push({
              method: "turn/completed",
              params: { turn: { id: "turn-gap", status: "completed", items: [] } },
            });
          }
          if (request.method === "thread/read")
            push({
              id: request.id,
              result: { thread: { status: { type: paused ? "idle" : "active" } } },
            });
          if (request.method === "thread/goal/get")
            push({ id: request.id, result: { goal: { status: paused ? "paused" : "active" } } });
          if (request.method === "thread/goal/set") {
            paused = true;
            push({ id: request.id, result: { goal: { status: "paused" } } });
          }
          if (request.method === "thread/backgroundTerminals/list") {
            push({ id: request.id, result: { data: [] } });
            if (!paused) resolveGap();
          }
        },
        end() {
          stop = true;
          wake?.();
        },
        closed: Promise.resolve(),
      });
      options.abortSignal?.addEventListener(
        "abort",
        () => {
          stop = true;
          wake?.();
        },
        { once: true },
      );
      while (!stop || replies.length) {
        if (replies.length) yield { type: "stdout", line: replies.shift()! };
        else
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
      }
    };
    const controller = new CodexAppServerController();
    const spec = HarnessRunSpec.parse({
      session_id: "session-gap",
      intent: "implement",
      prompt: "work",
      cwd: process.cwd(),
    });
    const events: HarnessEvent[] = [];
    const collect = (async () => {
      for await (const event of runCodexAppServer({
        bin: "codex",
        args: [],
        spec,
        env: {},
        spawn,
        controller,
        pollIntervalMs: 0,
        cancelDeadlineMs: 100,
      }))
        events.push(event);
    })();
    await gap;
    await controller.cancel();
    await collect;

    expect(methods.filter((method) => method === "thread/goal/set")).toHaveLength(1);
    expect(methods).not.toContain("turn/interrupt");
    expect(events.at(-1)).toMatchObject({ type: "completed", aborted: true });
  });

  it.each([
    { caseName: "without turn/completed", emitTurnCompleted: false, goalStatus: "complete" },
    { caseName: "with a stale active goal", emitTurnCompleted: true, goalStatus: "active" },
  ])(
    "fails on a durable thread systemError $caseName",
    async ({ emitTurnCompleted, goalStatus }) => {
      const replies: string[] = [];
      let wake: (() => void) | undefined;
      let stop = false;
      const push = (message: unknown): void => {
        replies.push(JSON.stringify(message));
        wake?.();
        wake = undefined;
      };
      const spawn: typeof spawnProcess = async function* (_bin, _args, options = {}) {
        options.onSpawn?.({
          write(data) {
            const request = JSON.parse(data) as { id?: number; method: string };
            if (request.method === "initialize") push({ id: request.id, result: {} });
            if (request.method === "thread/start")
              push({ id: request.id, result: { thread: { id: "thread-system-error" } } });
            if (request.method === "turn/start") {
              push({ id: request.id, result: { turn: { id: "turn-system-error" } } });
              push({ method: "turn/started", params: { turn: { id: "turn-system-error" } } });
              if (emitTurnCompleted)
                push({
                  method: "turn/completed",
                  params: { turn: { id: "turn-system-error", status: "completed", items: [] } },
                });
              push({
                method: "thread/status/changed",
                params: {
                  threadId: "thread-system-error",
                  status: { type: "systemError" },
                },
              });
            }
            if (request.method === "thread/read")
              push({ id: request.id, result: { thread: { status: { type: "systemError" } } } });
            if (request.method === "thread/goal/get")
              push({ id: request.id, result: { goal: { status: goalStatus } } });
            if (request.method === "thread/backgroundTerminals/list")
              push({ id: request.id, result: { data: [] } });
          },
          end() {
            stop = true;
            wake?.();
          },
          closed: Promise.resolve(),
        });
        options.abortSignal?.addEventListener(
          "abort",
          () => {
            stop = true;
            wake?.();
          },
          { once: true },
        );
        while (!stop || replies.length) {
          if (replies.length) yield { type: "stdout", line: replies.shift()! };
          else
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
        }
        yield { type: "stderr", line: "app-server diagnostic" };
      };
      const events: HarnessEvent[] = [];
      for await (const event of runCodexAppServer({
        bin: "codex",
        args: [],
        spec: HarnessRunSpec.parse({
          session_id: "session-system-error",
          intent: "implement",
          prompt: "work",
          cwd: process.cwd(),
        }),
        env: {},
        spawn,
        pollIntervalMs: 0,
      }))
        events.push(event);

      expect(events).toContainEqual(
        expect.objectContaining({ type: "error", error: expect.stringContaining("systemError") }),
      );
      expect(events.at(-1)).toMatchObject({
        type: "completed",
        payload: { harness_reported_error: true, stderr_tail: "app-server diagnostic" },
      });
    },
  );

  it("does not publish success before app-server process death is confirmed", async () => {
    const replies: string[] = [];
    let wake: (() => void) | undefined;
    let aborted = false;
    const push = (message: unknown): void => {
      replies.push(JSON.stringify(message));
      wake?.();
      wake = undefined;
    };
    const spawn: typeof spawnProcess = async function* (_bin, _args, options = {}) {
      options.onSpawn?.({
        write(data) {
          const request = JSON.parse(data) as { id?: number; method: string };
          if (request.method === "initialize") push({ id: request.id, result: {} });
          if (request.method === "thread/start")
            push({ id: request.id, result: { thread: { id: "thread-survivor" } } });
          if (request.method === "turn/start") {
            push({ id: request.id, result: { turn: { id: "turn-survivor" } } });
            push({ method: "turn/started", params: { turn: { id: "turn-survivor" } } });
            push({
              method: "turn/completed",
              params: { turn: { id: "turn-survivor", status: "completed", items: [] } },
            });
          }
          if (request.method === "thread/read")
            push({ id: request.id, result: { thread: { status: { type: "idle" } } } });
          if (request.method === "thread/goal/get")
            push({ id: request.id, result: { goal: null } });
          if (request.method === "thread/backgroundTerminals/list")
            push({ id: request.id, result: { data: [] } });
        },
        end() {
          aborted = true;
          wake?.();
        },
        closed: Promise.resolve(),
      });
      options.abortSignal?.addEventListener(
        "abort",
        () => {
          aborted = true;
          wake?.();
        },
        { once: true },
      );
      while (!aborted || replies.length) {
        if (replies.length) yield { type: "stdout", line: replies.shift()! };
        else
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
      }
      yield { type: "exit", code: null, signal: "SIGINT" };
      yield {
        type: "termination_unconfirmed",
        rootPid: 42,
        survivors: [43],
        unresolved: [],
      };
    };
    const events: HarnessEvent[] = [];
    for await (const event of runCodexAppServer({
      bin: "codex",
      args: [],
      spec: HarnessRunSpec.parse({
        session_id: "session-survivor",
        intent: "implement",
        prompt: "work",
        cwd: process.cwd(),
      }),
      env: {},
      spawn,
      pollIntervalMs: 0,
    }))
      events.push(event);

    expect(events.filter((event) => event.type === "completed")).toHaveLength(1);
    expect(events.some((event) => event.final)).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "error", payload: { code: "codex_control_loss" } }),
    );
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      payload: { code: "codex_control_loss", termination_unconfirmed: { survivors: [43] } },
    });
  });

  it("fails closed when native interrupt acknowledgement misses the deadline", async () => {
    const replies: string[] = [];
    let wake: (() => void) | undefined;
    let stop = false;
    const push = (message: unknown): void => {
      replies.push(JSON.stringify(message));
      wake?.();
      wake = undefined;
    };
    const spawn: typeof spawnProcess = async function* (_bin, _args, options = {}) {
      options.onSpawn?.({
        write(data) {
          const request = JSON.parse(data) as { id?: number; method: string };
          if (request.method === "initialize") push({ id: request.id, result: {} });
          if (request.method === "thread/start")
            push({ id: request.id, result: { thread: { id: "thread-timeout" } } });
          if (request.method === "turn/start") {
            push({ id: request.id, result: { turn: { id: "turn-timeout" } } });
            push({ method: "turn/started", params: { turn: { id: "turn-timeout" } } });
          }
          if (request.method === "thread/goal/get")
            push({ id: request.id, result: { goal: null } });
          // Deliberately never answer turn/interrupt.
        },
        end() {
          stop = true;
          wake?.();
        },
        closed: Promise.resolve(),
      });
      options.abortSignal?.addEventListener(
        "abort",
        () => {
          stop = true;
          wake?.();
        },
        { once: true },
      );
      while (!stop || replies.length) {
        if (replies.length) yield { type: "stdout", line: replies.shift()! };
        else
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
      }
    };
    const controller = new CodexAppServerController();
    const spec = HarnessRunSpec.parse({
      session_id: "session-timeout",
      intent: "implement",
      prompt: "work",
      cwd: process.cwd(),
    });
    const events: HarnessEvent[] = [];
    for await (const event of runCodexAppServer({
      bin: "codex",
      args: [],
      spec,
      env: {},
      spawn,
      controller,
      cancelDeadlineMs: 1,
    })) {
      events.push(event);
      if (event.type === "started") await controller.cancel();
    }

    expect(events.find((event) => event.type === "error")?.payload?.["code"]).toBe(
      "codex_control_loss",
    );
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      aborted: true,
      payload: { code: "codex_control_loss" },
    });
  });

  it("routes adapter runs and Stop through the matching app-server controller", async () => {
    let appServerRuns = 0;
    let execRuns = 0;
    let cancels = 0;
    let release!: () => void;
    const stopped = new Promise<void>((resolve) => {
      release = resolve;
    });
    const adapter = createCodexAdapter({
      detectVersion: async () => "codex-cli 0.156.1",
      probeLogin: async () => ({ authed: true, method: "chatgpt", probeError: null }),
      hasApiKey: () => false,
      probeEfforts: async () => null,
      runCliHarness: async function* (): AsyncGenerator<HarnessEvent> {
        execRuns++;
        throw new Error("legacy exec path must not run");
      },
      runAppServer: async function* (input): AsyncGenerator<HarnessEvent> {
        appServerRuns++;
        input.controller?.bind(async () => {
          cancels++;
          release();
        });
        yield {
          type: "started",
          session_id: input.spec.session_id,
          ts: "2026-09-24T00:00:00.000Z",
          payload: { native_session_id: "native-1" },
        };
        await stopped;
        yield {
          type: "completed",
          session_id: input.spec.session_id,
          ts: "2026-09-24T00:00:01.000Z",
          aborted: true,
        };
      },
    });
    const spec = HarnessRunSpec.parse({
      session_id: "session-adapter",
      intent: "implement",
      prompt: "work",
      cwd: process.cwd(),
    });
    const iterator = adapter.run(spec)[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: "started" });
    await adapter.cancel?.("session-adapter");
    expect((await iterator.next()).value).toMatchObject({ type: "completed", aborted: true });
    expect((await iterator.next()).done).toBe(true);
    await adapter.cancel?.("session-adapter");
    expect(appServerRuns).toBe(1);
    expect(execRuns).toBe(0);
    expect(cancels).toBe(1);
  });
});

describe("Codex live messages (turn/steer)", () => {
  type Request = { id?: number; method: string; params?: Record<string, unknown> };
  type Push = (message: unknown) => void;
  const STEER_TEXT = "Change of plan: stop and answer MANGO.";

  /** A scripted app-server whose first turn stays open until `finishTurn()`;
   * `onSteer` scripts the vendor's answer to `turn/steer` (default: none). */
  function liveAppServer(onSteer: (request: Request, push: Push) => void = () => {}) {
    const writes: Request[] = [];
    const replies: string[] = [];
    let wake: (() => void) | undefined;
    let stop = false;
    let crashed = false;
    let turnOpen = true;
    const waiters: Array<{ method: string; resolve: () => void }> = [];
    const state = { goalActive: false };
    const push: Push = (message) => {
      replies.push(JSON.stringify(message));
      wake?.();
      wake = undefined;
    };
    const completeTurn = (turnId: string, status: string): void => {
      turnOpen = false;
      push({
        method: "turn/completed",
        params: { threadId: "thread-live", turn: { id: turnId, status, items: [] } },
      });
    };
    const spawn: typeof spawnProcess = async function* (_bin, _args, options = {}) {
      options.onSpawn?.({
        write(data) {
          const request = JSON.parse(data) as Request;
          writes.push(request);
          for (const waiter of waiters.splice(0)) {
            if (waiter.method === request.method) waiter.resolve();
            else waiters.push(waiter);
          }
          if (request.method === "initialize") push({ id: request.id, result: {} });
          if (request.method === "thread/start")
            push({ id: request.id, result: { thread: { id: "thread-live" } } });
          if (request.method === "turn/start") {
            push({ id: request.id, result: { turn: { id: "turn-live" } } });
            push({
              method: "turn/started",
              params: { threadId: "thread-live", turn: { id: "turn-live" } },
            });
            push({
              method: "item/started",
              params: {
                item: {
                  type: "commandExecution",
                  id: "cmd-live",
                  command: "sleep 3",
                  status: "inProgress",
                },
                threadId: "thread-live",
                turnId: "turn-live",
              },
            });
          }
          if (request.method === "turn/steer") onSteer(request, push);
          if (request.method === "turn/interrupt") {
            push({ id: request.id, result: {} });
            completeTurn("turn-live", "interrupted");
          }
          if (request.method === "thread/read")
            push({
              id: request.id,
              result: { thread: { status: { type: turnOpen ? "active" : "idle" } } },
            });
          if (request.method === "thread/goal/get")
            push({
              id: request.id,
              result: { goal: state.goalActive ? { status: "active" } : null },
            });
          if (request.method === "thread/backgroundTerminals/list")
            push({ id: request.id, result: { data: [] } });
        },
        end() {
          stop = true;
          wake?.();
        },
        closed: Promise.resolve(),
      });
      options.abortSignal?.addEventListener(
        "abort",
        () => {
          stop = true;
          wake?.();
        },
        { once: true },
      );
      while (!stop || replies.length) {
        if (replies.length) yield { type: "stdout", line: replies.shift()! };
        else
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
      }
      if (crashed) yield { type: "exit", code: 1, signal: null };
    };
    return {
      spawn,
      writes,
      push,
      state,
      finishTurn: (): void => completeTurn("turn-live", "completed"),
      startTurn: (turnId: string): void => {
        turnOpen = true;
        push({ method: "turn/started", params: { threadId: "thread-live", turn: { id: turnId } } });
      },
      completeTurn,
      crash: (): void => {
        crashed = true;
        stop = true;
        wake?.();
      },
      /** Resolves on the NEXT request of that method (register before triggering it). */
      nextWrite: (method: string): Promise<void> =>
        new Promise<void>((resolve) => waiters.push({ method, resolve })),
    };
  }

  const echo = (
    method: "item/started" | "item/completed",
    clientId: string,
    turnId = "turn-live",
  ): unknown => ({
    method,
    params: {
      item: {
        type: "userMessage",
        id: "user-live",
        clientId,
        content: [{ type: "text", text: STEER_TEXT, text_elements: [] }],
      },
      threadId: "thread-live",
      turnId,
    },
  });

  const spec = HarnessRunSpec.parse({
    session_id: "session-live",
    intent: "implement",
    prompt: "work",
    cwd: process.cwd(),
  });

  type Server = ReturnType<typeof liveAppServer>;
  /** Runs the scripted server on a free-running consumer so the run's main loop
   * keeps advancing while the test orchestrates from outside. */
  function start(server: Server, options: Partial<CodexAppServerRunInput> = {}) {
    const controller = new CodexAppServerController();
    const events: HarnessEvent[] = [];
    const watchers: Array<{ match: (event: HarnessEvent) => boolean; resolve: () => void }> = [];
    const done = (async () => {
      for await (const event of runCodexAppServer({
        bin: "codex",
        args: [],
        spec,
        env: {},
        spawn: server.spawn,
        controller,
        pollIntervalMs: 0,
        cancelDeadlineMs: 200,
        ...options,
      })) {
        events.push(event);
        for (const watcher of watchers.splice(0)) {
          if (watcher.match(event)) watcher.resolve();
          else watchers.push(watcher);
        }
      }
    })();
    return {
      controller,
      events,
      done,
      /** Resolves once an event matching `match` has been seen (past or future). */
      seen: (match: (event: HarnessEvent) => boolean): Promise<void> =>
        events.some(match)
          ? Promise.resolve()
          : new Promise<void>((resolve) => watchers.push({ match, resolve })),
    };
  }
  const started = (event: HarnessEvent): boolean => event.type === "started";
  const steerWrites = (server: Server): Request[] =>
    server.writes.filter((request) => request.method === "turn/steer");
  const statusEvents = (events: HarnessEvent[]): HarnessEvent[] =>
    events.filter((event) => event.type === "status");

  it("answers accepted on {turnId}; the later userMessage echo yields one delivered receipt", async () => {
    const server = liveAppServer((request, push) =>
      push({ id: request.id, result: { turnId: "turn-live" } }),
    );
    const run = start(server);
    await run.seen(started);
    await expect(run.controller.steer({ messageId: "msg-1", text: STEER_TEXT })).resolves.toEqual({
      outcome: "accepted",
      nativeTurnId: "turn-live",
    });
    // The vendor consumes the message later (2.9 s live) and echoes it twice
    // (item/started + item/completed): ONE receipt, and neither frame counts
    // as a dropped unrecognized event.
    server.push(echo("item/started", "msg-1"));
    server.push(echo("item/completed", "msg-1"));
    await run.seen((event) => event.type === "status");
    server.finishTurn();
    await run.done;

    expect(steerWrites(server)).toEqual([
      expect.objectContaining({
        params: {
          threadId: "thread-live",
          expectedTurnId: "turn-live",
          clientUserMessageId: "msg-1",
          input: [{ type: "text", text: STEER_TEXT, text_elements: [] }],
        },
      }),
    ]);
    expect(statusEvents(run.events)).toEqual([
      expect.objectContaining({
        type: "status",
        session_id: "session-live",
        payload: { code: "live_input_delivered", message_id: "msg-1", native_turn_id: "turn-live" },
      }),
    ]);
    expect(run.events.at(-1)).toMatchObject({ type: "completed" });
    expect(run.events.at(-1)?.aborted).toBeUndefined();
    expect(run.events.at(-1)?.payload).not.toHaveProperty("harness_reported_error");
    expect(run.events.at(-1)?.payload).not.toHaveProperty("dropped_unrecognized_events");
  });

  it("settles as delivered when the echo arrives before the vendor's reply", async () => {
    const server = liveAppServer((request, push) => {
      const clientId = String(request.params?.["clientUserMessageId"]);
      push(echo("item/started", clientId));
      push({ id: request.id, result: { turnId: "turn-live" } });
    });
    const run = start(server);
    await run.seen(started);
    await expect(
      run.controller.steer({ messageId: "msg-early", text: STEER_TEXT }),
    ).resolves.toEqual({ outcome: "delivered", nativeTurnId: "turn-live" });
    server.finishTurn();
    await run.done;
    expect(statusEvents(run.events)).toHaveLength(1);
    expect(run.events.at(-1)?.payload).not.toHaveProperty("harness_reported_error");
  });

  it("ignores a same-id echo on another turn and a foreign clientId", async () => {
    const server = liveAppServer((request, push) => {
      const clientId = String(request.params?.["clientUserMessageId"]);
      push(echo("item/started", clientId, "turn-other"));
      push(echo("item/started", "someone-else", "turn-live"));
      push({ id: request.id, result: { turnId: "turn-live" } });
    });
    const run = start(server);
    await run.seen(started);
    await expect(
      run.controller.steer({ messageId: "msg-strict", text: STEER_TEXT }),
    ).resolves.toEqual({ outcome: "accepted", nativeTurnId: "turn-live" });
    server.finishTurn();
    await run.done;
    expect(statusEvents(run.events)).toHaveLength(0);
  });

  it("answers not_active without an RPC when no turn is active (goal-continuation gap)", async () => {
    const server = liveAppServer();
    server.state.goalActive = true;
    const run = start(server);
    await run.seen(started);
    // turn/completed with an ACTIVE goal: the run stays alive waiting for the
    // continuation turn, and activeTurnId is null meanwhile.
    const gap = server.nextWrite("thread/read");
    server.finishTurn();
    await gap;
    await expect(run.controller.steer({ messageId: "msg-gap", text: STEER_TEXT })).resolves.toEqual(
      { outcome: "not_active", reason: "no_active_turn" },
    );
    server.state.goalActive = false;
    server.startTurn("turn-2");
    server.completeTurn("turn-2", "completed");
    await run.done;
    expect(steerWrites(server)).toEqual([]);
    expect(run.events.at(-1)).toMatchObject({ type: "completed" });
    expect(run.events.at(-1)?.aborted).toBeUndefined();
  });

  it("maps a vendor refusal on the still-active turn to rejected without tainting the run", async () => {
    const server = liveAppServer((request, push) =>
      // Every codex refusal shares -32600; the prose is NOT consulted.
      push({ id: request.id, error: { code: -32600, message: "no active turn to steer" } }),
    );
    const run = start(server);
    await run.seen(started);
    await expect(
      run.controller.steer({ messageId: "msg-refused", text: STEER_TEXT }),
    ).resolves.toEqual({ outcome: "rejected", reason: "rpc_refused" });
    server.finishTurn();
    await run.done;
    expect(run.events.filter((event) => event.type === "error")).toEqual([]);
    expect(run.events.at(-1)).toMatchObject({ type: "completed" });
    expect(run.events.at(-1)?.payload).not.toHaveProperty("harness_reported_error");
  });

  it("maps a refusal that lands after the turn moved on to not_active", async () => {
    const server = liveAppServer((request, push) => {
      server.finishTurn();
      push({ id: request.id, error: { code: -32600, message: "no active turn to steer" } });
    });
    const run = start(server);
    await run.seen(started);
    await expect(
      run.controller.steer({ messageId: "msg-late", text: STEER_TEXT }),
    ).resolves.toEqual({ outcome: "not_active", reason: "no_active_turn" });
    await run.done;
    expect(run.events.at(-1)?.payload).not.toHaveProperty("harness_reported_error");
  });

  it("answers delivery_unknown on a missed deadline and never cancels the run", async () => {
    const server = liveAppServer();
    const run = start(server, { steerDeadlineMs: 5 });
    await run.seen(started);
    await expect(
      run.controller.steer({ messageId: "msg-slow", text: STEER_TEXT }),
    ).resolves.toEqual({ outcome: "delivery_unknown", reason: "response_timeout" });
    server.finishTurn();
    await run.done;
    expect(steerWrites(server)).toHaveLength(1);
    expect(run.events.at(-1)).toMatchObject({ type: "completed" });
    expect(run.events.at(-1)?.aborted).toBeUndefined();
    expect(run.events.at(-1)?.payload).not.toHaveProperty("harness_reported_error");
  });

  it("answers delivery_unknown when the app-server dies before replying", async () => {
    const server = liveAppServer(() => server.crash());
    const run = start(server);
    await run.seen(started);
    await expect(
      run.controller.steer({ messageId: "msg-lost", text: STEER_TEXT }),
    ).resolves.toEqual({ outcome: "delivery_unknown", reason: "transport_lost" });
    await run.done;
    expect(run.events.at(-1)).toMatchObject({
      type: "completed",
      payload: { code: "codex_app_server_failure" },
    });
  });

  it("answers not_active after Stop and after the session ended; unsupported when never bound", async () => {
    const server = liveAppServer();
    const run = start(server);
    await run.seen(started);
    await run.controller.cancel();
    await expect(
      run.controller.steer({ messageId: "msg-stopped", text: STEER_TEXT }),
    ).resolves.toEqual({ outcome: "not_active", reason: "no_active_turn" });
    await run.done;
    expect(steerWrites(server)).toEqual([]);
    expect(run.events.at(-1)).toMatchObject({ type: "completed", aborted: true });
    await expect(
      run.controller.steer({ messageId: "msg-after", text: STEER_TEXT }),
    ).resolves.toEqual({ outcome: "not_active", reason: "no_active_turn" });
    await expect(
      new CodexAppServerController().steer({ messageId: "msg-unbound", text: STEER_TEXT }),
    ).resolves.toEqual({ outcome: "unsupported", reason: "no_live_session" });
  });

  it("routes adapter.message through the session's app-server controller", async () => {
    const seen: Array<{ messageId: string; text: string }> = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const adapter = createCodexAdapter({
      detectVersion: async () => "codex-cli 0.156.1",
      probeLogin: async () => ({ authed: true, method: "chatgpt", probeError: null }),
      hasApiKey: () => false,
      probeEfforts: async () => null,
      runCliHarness: async function* (): AsyncGenerator<HarnessEvent> {
        throw new Error("legacy exec path must not run");
      },
      runAppServer: async function* (input): AsyncGenerator<HarnessEvent> {
        input.controller?.bindSteer(async (message) => {
          seen.push(message);
          return { outcome: "accepted", nativeTurnId: "native-turn" };
        });
        yield {
          type: "started",
          session_id: input.spec.session_id,
          ts: "2026-09-26T00:00:00.000Z",
        };
        await held;
        yield {
          type: "completed",
          session_id: input.spec.session_id,
          ts: "2026-09-26T00:00:01.000Z",
        };
      },
    });
    const runSpec = HarnessRunSpec.parse({
      session_id: "session-message",
      intent: "implement",
      prompt: "work",
      cwd: process.cwd(),
    });
    const iterator = adapter.run(runSpec)[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: "started" });
    await expect(
      adapter.message?.("session-message", { messageId: "msg-a", text: "steer" }),
    ).resolves.toEqual({ outcome: "accepted", nativeTurnId: "native-turn" });
    await expect(
      adapter.message?.("session-unknown", { messageId: "msg-b", text: "steer" }),
    ).resolves.toEqual({ outcome: "unsupported", reason: "no_live_session" });
    release();
    expect((await iterator.next()).value).toMatchObject({ type: "completed" });
    expect((await iterator.next()).done).toBe(true);
    // The finished session's controller is gone from the map.
    await expect(
      adapter.message?.("session-message", { messageId: "msg-c", text: "steer" }),
    ).resolves.toEqual({ outcome: "unsupported", reason: "no_live_session" });
    expect(seen).toEqual([{ messageId: "msg-a", text: "steer" }]);
  });

  it("answers unsupported on the legacy exec path, which has no app-server channel", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const adapter = createCodexAdapter({
      detectVersion: async () => "codex-cli 0.156.1",
      probeLogin: async () => ({ authed: true, method: "chatgpt", probeError: null }),
      hasApiKey: () => false,
      probeEfforts: async () => null,
      runCliHarness: async function* (input): AsyncGenerator<HarnessEvent> {
        yield {
          type: "started",
          session_id: input.spec.session_id,
          ts: "2026-09-26T00:00:00.000Z",
        };
        await held;
        yield {
          type: "completed",
          session_id: input.spec.session_id,
          ts: "2026-09-26T00:00:01.000Z",
        };
      },
    });
    const runSpec = HarnessRunSpec.parse({
      session_id: "session-exec",
      intent: "implement",
      prompt: "work",
      cwd: process.cwd(),
    });
    const iterator = adapter.run(runSpec)[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: "started" });
    await expect(
      adapter.message?.("session-exec", { messageId: "msg-exec", text: "steer" }),
    ).resolves.toEqual({ outcome: "unsupported", reason: "no_live_session" });
    release();
    expect((await iterator.next()).value).toMatchObject({ type: "completed" });
    expect((await iterator.next()).done).toBe(true);
  });
});

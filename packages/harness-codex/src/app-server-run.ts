import { spawnProcess, type ChildStdin, type SpawnOptions } from "@claudexor/core";
import type { HarnessEvent, HarnessRunSpec } from "@claudexor/schema";
import { CLAUDEXOR_VERSION, nowIso, redactSecrets } from "@claudexor/util";
import { codexAppServerInput } from "./attachments.js";
import type { CodexEffortCatalog } from "./effort-probe.js";
import {
  asObject,
  CodexAppServerController,
  CodexRpcError,
  codexAppServerEvents,
  codexAppServerThreadParams,
  createCodexSteer,
  errorText,
  readCodexLifecycle,
  rpcProvenance,
  type CodexThreadLifecycle,
  type JsonObject,
} from "./app-server-protocol.js";
import { parseCodexEvent, parseCodexStderrFailure, type CodexParseState } from "./parse.js";

export { CodexAppServerController } from "./app-server-protocol.js";
export { codexAppServerEvents, codexAppServerThreadParams } from "./app-server-protocol.js";
export interface CodexAppServerRunInput {
  bin: string;
  args: string[];
  spec: HarnessRunSpec;
  env: Record<string, string | null | undefined>;
  spawn?: typeof spawnProcess;
  controller?: CodexAppServerController;
  effortCatalog?: CodexEffortCatalog;
  pollIntervalMs?: number;
  cancelDeadlineMs?: number;
  /** Bound on the vendor's `turn/steer` answer (default 30 s); see createCodexSteer. */
  steerDeadlineMs?: number;
}

export async function* runCodexAppServer(
  input: CodexAppServerRunInput,
): AsyncGenerator<HarnessEvent> {
  const run = input.spawn ?? spawnProcess;
  const abort = new AbortController();
  const pending = new Map<
    number,
    { resolve: (value: JsonObject) => void; reject: (error: Error) => void; taint: boolean }
  >();
  const notifications: JsonObject[] = [];
  const notificationWaiter: { wake?: () => void } = {};
  let io: ChildStdin | null = null;
  let resolveSpawn!: () => void;
  const spawned = new Promise<void>((resolve) => {
    resolveSpawn = resolve;
  });
  let nextId = 1;
  let processFailure: Error | null = null;
  let processStopped = false;
  let nativeThreadId: string | null = null;
  let activeTurnId: string | null = null;
  const ownedCommandItemIds = new Set<string>();
  const stderrRing: string[] = [];
  let droppedUnrecognizedEvents = 0;
  let harnessReportedError = false;
  let terminationUnconfirmed: { survivors: number[]; unresolved: JsonObject[] } | null = null;
  let nativeSystemError = false;
  let cancellationRequested = false;
  let cancellationQuiescent = false;
  let cancellationFailure: Error | null = null;
  const requiredMcpStatuses = new Map<
    string,
    { status: "starting" | "ready" | "failed" | "cancelled"; error?: string }
  >(
    input.spec.extra_mcp_servers
      .filter((server) => server.required)
      .map((server) => [server.name, { status: "starting" }] as const),
  );
  const parseState: CodexParseState = {
    envelopeActive: input.spec.output_schema !== undefined && input.spec.output_schema !== null,
    requiredMcpServers: input.spec.extra_mcp_servers
      .filter((server) => server.required)
      .map((server) => server.name),
    startedEmitted: true,
  };

  const rejectPending = (error: Error): void => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  const onMessage = (message: unknown): void => {
    const object = asObject(message);
    if (!object) throw new Error("Codex app-server sent a non-object JSON-RPC frame");
    if (typeof object["id"] === "number") {
      const request = pending.get(object["id"]);
      if (!request) return;
      pending.delete(object["id"]);
      const rpcError = asObject(object["error"]);
      if (rpcError) {
        if (request.taint) harnessReportedError = true;
        const code = typeof rpcError["code"] === "number" ? rpcError["code"] : null;
        request.reject(
          new CodexRpcError(code, String(rpcError["message"] ?? "Codex app-server request failed")),
        );
        return;
      }
      const result = asObject(object["result"]);
      if (!result) {
        request.reject(new Error("Codex app-server returned a malformed JSON-RPC result"));
        return;
      }
      request.resolve(result);
      return;
    }
    if (typeof object["method"] === "string") {
      const params = asObject(object["params"]);
      if (object["method"] === "turn/started") {
        const turn = asObject(params?.["turn"]);
        if (typeof turn?.["id"] === "string") activeTurnId = turn["id"];
      } else if (object["method"] === "turn/completed") {
        const turn = asObject(params?.["turn"]);
        if (!turn || turn["id"] === activeTurnId) activeTurnId = null;
      } else if (object["method"] === "item/started") {
        const item = asObject(params?.["item"]);
        if (item?.["type"] === "commandExecution" && typeof item["id"] === "string")
          ownedCommandItemIds.add(item["id"]);
      } else if (object["method"] === "thread/status/changed") {
        if (asObject(params?.["status"])?.["type"] === "systemError") nativeSystemError = true;
      } else if (object["method"] === "mcpServer/startupStatus/updated") {
        const name = params?.["name"];
        const status = params?.["status"];
        if (
          typeof name === "string" &&
          requiredMcpStatuses.has(name) &&
          (status === "starting" ||
            status === "ready" ||
            status === "failed" ||
            status === "cancelled")
        ) {
          const error = params?.["error"] ?? params?.["failureReason"];
          requiredMcpStatuses.set(name, {
            status,
            ...(typeof error === "string" ? { error } : {}),
          });
          if (status === "failed" || status === "cancelled") harnessReportedError = true;
        }
      }
      steer.observeEcho(object);
      notifications.push(object);
      notificationWaiter.wake?.();
      notificationWaiter.wake = undefined;
    }
  };

  const process = (async (): Promise<void> => {
    try {
      const options: SpawnOptions = {
        cwd: input.spec.cwd,
        env: input.env,
        inheritEnv: input.spec.env_inheritance,
        keepStdinOpen: true,
        abortSignal: abort.signal,
        onSpawn(childIo) {
          io = childIo;
          resolveSpawn();
        },
      };
      for await (const event of run(input.bin, [...input.args, "app-server", "--stdio"], options)) {
        if (event.type === "stdout") {
          try {
            onMessage(JSON.parse(event.line));
          } catch (error) {
            throw new Error(`Invalid Codex app-server frame: ${errorText(error)}`);
          }
        } else if (event.type === "stderr") {
          stderrRing.push(event.line);
          if (stderrRing.length > 40) stderrRing.shift();
        } else if (event.type === "termination_unconfirmed") {
          terminationUnconfirmed = {
            survivors: event.survivors,
            unresolved: event.unresolved,
          };
          throw new Error("Codex app-server process termination could not be confirmed");
        } else if (event.type === "exit" && !abort.signal.aborted) {
          throw new Error(
            `Codex app-server exited before the run completed (code ${event.code ?? "null"})`,
          );
        }
      }
    } catch (error) {
      processFailure = error instanceof Error ? error : new Error(String(error));
      rejectPending(processFailure);
      throw processFailure;
    } finally {
      processStopped = true;
      if (abort.signal.aborted)
        rejectPending(cancellationFailure ?? new Error("Codex app-server stopped"));
      notificationWaiter.wake?.();
      notificationWaiter.wake = undefined;
    }
  })();
  void process.catch(() => {});

  // `taint`: a refused request marks the run harness_reported_error; a live
  // message (turn/steer) passes false so a benign refusal never poisons the run.
  const request = async (method: string, params: JsonObject, taint = true): Promise<JsonObject> => {
    await Promise.race([
      spawned,
      process.then(() => {
        throw processFailure ?? new Error("Codex app-server exited before accepting requests");
      }),
    ]);
    const id = nextId++;
    const response = new Promise<JsonObject>((resolve, reject) => {
      pending.set(id, { resolve, reject, taint });
    });
    io!.write(`${JSON.stringify({ id, method, params })}\n`);
    return response;
  };
  const notify = async (method: string, params: JsonObject | null): Promise<void> => {
    await spawned;
    io!.write(`${JSON.stringify({ method, params })}\n`);
  };
  const steer = createCodexSteer({
    sessionId: input.spec.session_id,
    threadId: () => nativeThreadId,
    activeTurnId: () => activeTurnId,
    live: () => !cancellationRequested && !processStopped,
    send: (method, params) => rpcProvenance(request(method, params, false)),
    responseDeadlineMs: input.steerDeadlineMs ?? 30_000,
  });
  const nextNotification = async (method: string): Promise<JsonObject> => {
    for (;;) {
      const index = notifications.findIndex((item) => item["method"] === method);
      if (index >= 0) return notifications.splice(index, 1)[0]!;
      if (processFailure) throw processFailure;
      await new Promise<void>((resolve) => {
        notificationWaiter.wake = resolve;
      });
    }
  };
  const takeNotification = async (): Promise<JsonObject> => {
    for (;;) {
      const next = notifications.shift();
      if (next) return next;
      if (processFailure) throw processFailure;
      if (processStopped) throw cancellationFailure ?? new Error("Codex app-server disconnected");
      await new Promise<void>((resolve) => {
        notificationWaiter.wake = resolve;
      });
    }
  };
  const waitForRequiredMcp = async (): Promise<void> => {
    while (requiredMcpStatuses.size) {
      const failed = [...requiredMcpStatuses].filter(
        ([, value]) => value.status === "failed" || value.status === "cancelled",
      );
      if (failed.length) {
        throw new Error(
          `required MCP servers failed to initialize: ${failed
            .map(([name, value]) => `${name}: ${value.error ?? value.status}`)
            .join(", ")}`,
        );
      }
      if ([...requiredMcpStatuses.values()].every((value) => value.status === "ready")) return;
      await nextNotification("mcpServer/startupStatus/updated");
    }
  };
  let stopPromise: Promise<void> | null = null;
  const stopProcess = (): Promise<void> => {
    stopPromise ??= (async () => {
      if (!abort.signal.aborted) abort.abort();
      io?.end();
      await process.catch(() => {});
    })();
    return stopPromise;
  };
  const terminalPayload = (extra: JsonObject = {}): JsonObject => {
    const stderrTail = redactSecrets(stderrRing.join("\n")).slice(-1_000).trim();
    return {
      ...extra,
      ...(harnessReportedError ? { harness_reported_error: true } : {}),
      ...(stderrTail ? { stderr_tail: stderrTail } : {}),
      ...(droppedUnrecognizedEvents
        ? { dropped_unrecognized_events: droppedUnrecognizedEvents }
        : {}),
      ...(terminationUnconfirmed ? { termination_unconfirmed: terminationUnconfirmed } : {}),
    };
  };
  const readLifecycle = (): Promise<CodexThreadLifecycle> =>
    readCodexLifecycle(request, nativeThreadId, ownedCommandItemIds);
  let cancelPromise: Promise<void> | null = null;
  const cancel = (): Promise<void> => {
    if (cancelPromise) return cancelPromise;
    cancellationRequested = true;
    cancelPromise = (async () => {
      try {
        const cooperative = async (): Promise<void> => {
          await spawned;
          if (!nativeThreadId) return;
          const interruptedTurnIds = new Set<string>();
          for (;;) {
            const goalResult = await request("thread/goal/get", { threadId: nativeThreadId });
            if (asObject(goalResult["goal"])?.["status"] === "active")
              await request("thread/goal/set", { threadId: nativeThreadId, status: "paused" });
            const turnId = activeTurnId;
            if (turnId && !interruptedTurnIds.has(turnId)) {
              try {
                await request("turn/interrupt", { threadId: nativeThreadId, turnId });
                interruptedTurnIds.add(turnId);
              } catch (error) {
                const lifecycle = await readLifecycle();
                if (!lifecycle.threadSettled && activeTurnId === turnId) throw error;
              }
            }
            let lifecycle = await readLifecycle();
            for (const terminal of lifecycle.ownedBackground) {
              if (typeof terminal["processId"] !== "string") continue;
              try {
                await request("thread/backgroundTerminals/terminate", {
                  threadId: nativeThreadId,
                  processId: terminal["processId"],
                });
              } catch (error) {
                const fresh = await readLifecycle();
                if (
                  fresh.ownedBackground.some(
                    (candidate) => candidate["processId"] === terminal["processId"],
                  )
                )
                  throw error;
                lifecycle = fresh;
              }
            }
            if (lifecycle.ownedBackground.length) lifecycle = await readLifecycle();
            if (
              lifecycle.threadSettled &&
              !lifecycle.goalActive &&
              lifecycle.ownedBackground.length === 0
            ) {
              cancellationQuiescent = true;
              return;
            }
            await new Promise<void>((resolve) => setTimeout(resolve, input.pollIntervalMs ?? 250));
          }
        };
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            cooperative(),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(
                () => reject(new Error("Codex cooperative cancellation was not acknowledged")),
                input.cancelDeadlineMs ?? 5_000,
              );
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      } catch (error) {
        cancellationFailure = error instanceof Error ? error : new Error(String(error));
      } finally {
        await stopProcess();
        if (processFailure) cancellationFailure ??= processFailure;
      }
    })();
    return cancelPromise;
  };
  input.controller?.bind(cancel);
  input.controller?.bindSteer(steer.send);
  const onAbort = (): void => void cancel();
  const externalAbort = input.spec.extra["abortSignal"];
  if (externalAbort instanceof AbortSignal) {
    if (externalAbort.aborted) onAbort();
    else externalAbort.addEventListener("abort", onAbort, { once: true });
  }

  try {
    await request("initialize", {
      clientInfo: { name: "claudexor", version: CLAUDEXOR_VERSION },
      capabilities: { experimentalApi: true },
    });
    await notify("initialized", null);
    const threadResult = await request(
      input.spec.resume_session_id ? "thread/resume" : "thread/start",
      input.spec.resume_session_id
        ? {
            ...codexAppServerThreadParams(input.spec, input.effortCatalog),
            threadId: input.spec.resume_session_id,
          }
        : codexAppServerThreadParams(input.spec, input.effortCatalog),
    );
    const thread = asObject(threadResult["thread"]);
    const threadId = thread?.["id"];
    if (typeof threadId !== "string") throw new Error("Codex app-server omitted thread id");
    nativeThreadId = threadId;
    await waitForRequiredMcp();
    await request("turn/start", {
      threadId,
      input: codexAppServerInput(input.spec),
      ...(input.spec.output_schema !== undefined && input.spec.output_schema !== null
        ? { outputSchema: input.spec.output_schema }
        : {}),
    });
    const started = await nextNotification("turn/started");
    const params = asObject(started["params"]);
    const turn = asObject(params?.["turn"]);
    const turnId = turn?.["id"];
    if (typeof turnId !== "string") throw new Error("Codex app-server omitted active turn id");
    yield {
      type: "started",
      session_id: input.spec.session_id,
      ts: nowIso(),
      payload: {
        native_session_id: threadId,
        native_turn_id: turnId,
        ...(parseState.requiredMcpServers?.length
          ? {
              mcp_servers: parseState.requiredMcpServers.map((name) => ({
                name,
                status: "connected",
              })),
            }
          : {}),
      },
    };
    let pendingTerminal: JsonObject | null = null;
    for (;;) {
      const notification = await takeNotification();
      const method = notification["method"];
      const params = asObject(notification["params"]);
      if (method === "turn/started") {
        pendingTerminal = null;
        parseState.lastAgentMessage = undefined;
        continue;
      }
      const mapped =
        steer.deliveredEvents(notification) ??
        codexAppServerEvents(notification, input.spec.session_id, parseState);
      if (mapped) {
        for (const event of mapped) {
          if (event.type === "error") harnessReportedError = true;
          yield event;
        }
      } else if (
        method !== "turn/completed" &&
        method !== "thread/status/changed" &&
        method !== "mcpServer/startupStatus/updated"
      ) {
        droppedUnrecognizedEvents += 1;
      }
      if (method === "turn/completed") {
        pendingTerminal = asObject(params?.["turn"]);
      } else if (method === "thread/status/changed" && nativeSystemError && !pendingTerminal) {
        pendingTerminal = {
          id: activeTurnId,
          status: "failed",
          error: { message: "Codex app-server thread settled in systemError" },
        };
      } else if (!pendingTerminal) {
        continue;
      }

      for (;;) {
        const current =
          cancellationRequested && cancellationQuiescent
            ? {
                threadStatus: "idle",
                threadSettled: true,
                goalActive: false,
                ownedBackground: [],
              }
            : await readLifecycle();
        if (!nativeSystemError && notifications.some((item) => item["method"] === "turn/started"))
          break;
        const systemError = nativeSystemError || current.threadStatus === "systemError";
        if (!current.threadSettled || current.goalActive || current.ownedBackground.length) {
          if (systemError && current.ownedBackground.length) {
            await new Promise<void>((resolve) => setTimeout(resolve, input.pollIntervalMs ?? 250));
            continue;
          }
          if (!systemError && current.ownedBackground.length && !current.goalActive) {
            await new Promise<void>((resolve) => setTimeout(resolve, input.pollIntervalMs ?? 250));
            continue;
          }
          if (!systemError) break;
        }
        const status = pendingTerminal?.["status"];
        const terminalEvents: HarnessEvent[] = [];
        if (status === "failed") {
          const error = asObject(pendingTerminal?.["error"]);
          const failed = parseCodexEvent(
            { type: "turn.failed", error: { message: error?.["message"] ?? "turn failed" } },
            input.spec.session_id,
            parseState,
          );
          if (failed) {
            harnessReportedError = failed.some((event) => event.type === "error");
            terminalEvents.push(...failed);
          }
        } else if (systemError) {
          harnessReportedError = true;
          terminalEvents.push({
            type: "error",
            session_id: input.spec.session_id,
            ts: nowIso(),
            error: "Codex app-server thread settled in systemError",
            payload: { code: "codex_app_server_failure" },
          });
        } else if (status === "completed") {
          const final = parseCodexEvent(
            { type: "turn.completed", usage: {} },
            input.spec.session_id,
            parseState,
          );
          if (final) terminalEvents.push(...final.filter((event) => event.type !== "usage"));
        }
        await stopProcess();
        if (processFailure) throw processFailure;
        for (const event of terminalEvents) yield event;
        yield {
          type: "completed",
          session_id: input.spec.session_id,
          ts: nowIso(),
          ...(status === "interrupted" ? { aborted: true } : {}),
          payload: terminalPayload({
            native_session_id: threadId,
            native_turn_id: pendingTerminal?.["id"] ?? activeTurnId,
          }),
        };
        return;
      }
    }
  } catch (error) {
    await stopProcess();
    if (processFailure && cancellationRequested) cancellationFailure ??= processFailure;
    if (cancellationRequested && cancellationQuiescent && !cancellationFailure && !processFailure) {
      yield {
        type: "completed",
        session_id: input.spec.session_id,
        ts: nowIso(),
        aborted: true,
        payload: terminalPayload({ code: "user_cancelled", native_session_id: nativeThreadId }),
      };
      return;
    }
    const aborted = cancellationRequested;
    const failure = processFailure ?? cancellationFailure ?? error;
    const code =
      cancellationFailure || terminationUnconfirmed
        ? "codex_control_loss"
        : "codex_app_server_failure";
    const nativeError =
      failure !== processFailure && !cancellationFailure
        ? parseCodexStderrFailure(errorText(failure), input.spec.session_id, parseState)
        : null;
    if (nativeError) harnessReportedError = true;
    yield nativeError ?? {
      type: "error",
      session_id: input.spec.session_id,
      ts: nowIso(),
      error: redactSecrets(errorText(failure)),
      payload: { code },
    };
    yield {
      type: "completed",
      session_id: input.spec.session_id,
      ts: nowIso(),
      ...(aborted ? { aborted: true } : {}),
      payload: terminalPayload({ code, native_session_id: nativeThreadId }),
    };
  } finally {
    if (externalAbort instanceof AbortSignal) externalAbort.removeEventListener("abort", onAbort);
    input.controller?.clear(cancel);
    input.controller?.clearSteer(steer.send);
    await stopProcess();
  }
}

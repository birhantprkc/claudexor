/**
 * Per-attempt interaction channel. Emits the typed lifecycle events
 * (`interaction.requested` / `interaction.answered` / `interaction.timeout`)
 * around the caller-provided answer surface. The wait policy is finite or has
 * automatic expiry disabled; answers, cancellation, terminal cleanup, and
 * registry release still end either form. Undefined when the caller provides
 * no surface — the adapter then runs non-interactive.
 *
 * Capability gate: the channel is OFFERED only to routes whose manifest
 * declares `interactive` — a non-interactive harness never gets a surface it
 * cannot raise questions through.
 */
import type { InteractionChannel } from "@claudexor/core";
import type {
  InteractionAnswerSet,
  InteractionHandlerRelease,
  InteractionHandlerResult,
  InteractionRequest,
} from "@claudexor/schema";
import { INTERACTION_TIMEOUT_MAX_MS } from "@claudexor/schema";
import type { EventLog } from "@claudexor/event-log";
import { nowIso } from "@claudexor/util";
import type { PendingInteractionContext } from "./orchestrator.js";

export interface InteractionChannelWiring {
  onInteraction?: (ctx: PendingInteractionContext) => Promise<InteractionHandlerResult>;
  interactionTimeoutMs?: number | null;
  signal?: AbortSignal;
}

export type InteractionTimeoutPolicy = { kind: "finite"; timeoutMs: number } | { kind: "disabled" };

export function resolveInteractionTimeoutPolicy(
  configured: number | null | undefined,
  defaultTimeoutMs: number,
): InteractionTimeoutPolicy {
  const value = configured === undefined ? defaultTimeoutMs : configured;
  if (value === null) return { kind: "disabled" };
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("interaction timeout must be a positive safe integer or null");
  }
  if (value > INTERACTION_TIMEOUT_MAX_MS) {
    throw new Error("interaction timeout exceeds the supported maximum");
  }
  return { kind: "finite", timeoutMs: value };
}

export function interactionChannelFor(
  input: InteractionChannelWiring,
  log: EventLog,
  runId: string,
  taskId: string,
  attemptId: string,
  harnessId: string,
  supportsInteractive: boolean,
  defaultTimeoutMs: number,
): InteractionChannel | undefined {
  if (!supportsInteractive) return undefined;
  const handler = input.onInteraction;
  if (!handler) return undefined;
  const timeoutPolicy = resolveInteractionTimeoutPolicy(
    input.interactionTimeoutMs,
    defaultTimeoutMs,
  );
  // Waiting on a human is legitimate stream silence: the inactivity watchdog
  // consults this count and re-arms instead of killing the "wedged" harness.
  let pending = 0;
  let suspensionVersion = 0;
  return {
    pendingCount: () => pending,
    suspensionVersion: () => suspensionVersion,
    request: async (request: InteractionRequest): Promise<InteractionAnswerSet | null> => {
      const requestedAt = nowIso();
      const deadlineAtMs =
        timeoutPolicy.kind === "finite" ? finiteDeadline(timeoutPolicy.timeoutMs) : null;
      const timeoutAt = deadlineAtMs === null ? null : new Date(deadlineAtMs).toISOString();
      pending += 1;
      suspensionVersion += 1;
      try {
        // Invoke the answer surface BEFORE announcing the event: handlers
        // register the pending question synchronously (daemon
        // InteractionRegistry), so any subscriber that reacts to
        // interaction.requested — `claudexor follow` checks pendingInteractions
        // before prompting — finds the registry already populated. The reverse
        // order would make that guarantee depend on event-loop timing.
        // The handler is invoked SYNCHRONOUSLY (the registry-population contract
        // below depends on it); only its failure handling is normalized — a
        // synchronous throw becomes the same null-answer path as an async one.
        let answersPromise: Promise<InteractionHandlerResult>;
        try {
          answersPromise = Promise.resolve(
            handler({
              runId,
              taskId,
              attemptId,
              harnessId,
              request,
              requestedAt,
              timeoutAt,
            }),
          ).catch(() => null);
        } catch {
          answersPromise = Promise.resolve(null);
        }
        log.emit("interaction.requested", {
          interaction_id: request.interaction_id,
          attempt_id: attemptId,
          harness_id: harnessId,
          source_tool: request.source_tool,
          questions: request.questions,
          requested_at: requestedAt,
          timeout_at: timeoutAt,
        });
        let cancelTimer: (() => void) | undefined;
        let onAbort: (() => void) | undefined;
        const startedWaiting = Date.now();
        type WaitResult =
          | { kind: "handler"; result: InteractionHandlerResult }
          | { kind: "timeout" }
          | { kind: "abort" };
        const waits: Promise<WaitResult>[] = [
          answersPromise.then((result) => ({ kind: "handler", result })),
          // A cancelled run must release the interaction wait IMMEDIATELY —
          // the abort already kills the harness process, and neither a finite
          // nor disabled-expiry policy may park a dead run in waiting_on_user.
          new Promise<WaitResult>((resolve) => {
            if (!input.signal) return;
            if (input.signal.aborted) return resolve({ kind: "abort" });
            onAbort = () => resolve({ kind: "abort" });
            input.signal.addEventListener("abort", onAbort, { once: true });
          }),
        ];
        if (deadlineAtMs !== null) {
          waits.push(
            new Promise<WaitResult>((resolve) => {
              cancelTimer = scheduleSafeDeadline(deadlineAtMs, () => resolve({ kind: "timeout" }));
            }),
          );
        }
        const result = await Promise.race(waits);
        cancelTimer?.();
        if (onAbort) input.signal?.removeEventListener("abort", onAbort);
        // Run cancellation has its own terminal event and is not an expired
        // answer window. Emitting interaction.timeout here makes downstream
        // surfaces briefly claim a benign timeout before the cancellation
        // truth arrives.
        if (result.kind === "abort") {
          // Preserve late-answer honesty without fabricating an expiry. The
          // registry may still deliver an answer racing the run cancellation;
          // disclose that it was discarded for the actual terminal cause.
          void answersPromise
            .then((late) => {
              if (late && !isInteractionHandlerRelease(late) && late.answers.length > 0) {
                log.emit("interaction.answer_discarded", {
                  interaction_id: request.interaction_id,
                  attempt_id: attemptId,
                  harness_id: harnessId,
                  answer_count: late.answers.length,
                  reason: "run_cancelled",
                });
              }
            })
            .catch(() => undefined);
          return null;
        }
        const handlerResult = result.kind === "handler" ? result.result : null;
        const answers = isInteractionHandlerRelease(handlerResult) ? null : handlerResult;
        if (answers && answers.answers.length > 0) {
          log.emit("interaction.answered", {
            interaction_id: request.interaction_id,
            attempt_id: attemptId,
            harness_id: harnessId,
            answer_count: answers.answers.length,
          });
          return answers;
        }
        // An untyped external null or a terminal/restart registry release is a
        // decline, not an automatic expiry. The daemon tags only its own
        // finite expiry so that race can retain exact provenance.
        if (
          result.kind === "handler" &&
          (!isInteractionHandlerRelease(handlerResult) ||
            handlerResult.reason !== "timeout" ||
            deadlineAtMs === null)
        ) {
          return null;
        }
        log.emit("interaction.timeout", {
          interaction_id: request.interaction_id,
          attempt_id: attemptId,
          harness_id: harnessId,
          waited_ms: Date.now() - startedWaiting,
        });
        // Late-answer honesty: the run already declined this
        // interaction; an answer arriving AFTER the timeout must be visibly
        // DISCARDED, not silently swallowed (the user typed it in good faith).
        void answersPromise.then((late) => {
          if (late && !isInteractionHandlerRelease(late) && late.answers.length > 0) {
            log.emit("interaction.answer_discarded", {
              interaction_id: request.interaction_id,
              attempt_id: attemptId,
              harness_id: harnessId,
              answer_count: late.answers.length,
              reason: "timed_out",
            });
          }
        });
        return null;
      } finally {
        // ALWAYS release the suspension: a synchronous handler throw or a
        // log.emit failure must not leave the watchdog suspended forever.
        pending -= 1;
        suspensionVersion += 1;
      }
    },
  };
}

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_DATE_MS = 8_640_000_000_000_000;

function finiteDeadline(timeoutMs: number): number {
  const deadline = Date.now() + timeoutMs;
  if (!Number.isSafeInteger(deadline) || deadline > MAX_DATE_MS) {
    throw new Error("interaction timeout is too large to represent as a deadline");
  }
  return deadline;
}

/** Node clamps one setTimeout above 2^31-1 ms to ~1 ms. Re-arm in bounded
 * chunks so a large valid finite policy cannot expire immediately. */
function scheduleSafeDeadline(deadline: number, fire: () => void): () => void {
  let timer: NodeJS.Timeout | undefined;
  let cancelled = false;
  const arm = () => {
    if (cancelled) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      fire();
      return;
    }
    timer = setTimeout(arm, Math.min(remaining, MAX_TIMER_DELAY_MS));
    timer.unref?.();
  };
  arm();
  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
  };
}

function isInteractionHandlerRelease(
  result: InteractionHandlerResult,
): result is InteractionHandlerRelease {
  return result !== null && "kind" in result && result.kind === "released";
}

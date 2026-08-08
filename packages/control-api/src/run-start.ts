/**
 * Run-start normalization (single owner): both entry paths — the HTTP control
 * API and the daemon socket runner — MUST use these so scope/secret/
 * absolute-root acceptance can never drift between surfaces. Split from
 * daemon-server.ts (INV-124 ratchet).
 */
import { mkdirSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute } from "node:path";
import {
  ControlQueuedRunInfo,
  ControlRunStartRequest,
  runStartStrategyViolations,
} from "@claudexor/schema";
import { assertNoInlineSecretValues, noProjectRepoRoot } from "@claudexor/util";
import type { DaemonFacadeClient, DaemonRunRecord } from "./daemon-server.js";

const NO_PROJECT_ROOT = noProjectRepoRoot();

export function validateAbsoluteRepoRoot(repoRoot: string): string | null {
  return isAbsolute(repoRoot) ? null : "project root must be an absolute path";
}

/**
 * The one admission rule for a user-supplied project root. Run start and
 * read-only root-scoped projections must accept and echo the same spelling.
 */
export function normalizeExistingProjectRoot(requestedRoot: string): string {
  const repoRoot = requestedRoot.trim();
  const absoluteRepoError = validateAbsoluteRepoRoot(repoRoot);
  if (absoluteRepoError) throw Object.assign(new Error(absoluteRepoError), { status: 400 });
  try {
    if (statSync(repoRoot).isDirectory()) return repoRoot;
  } catch {
    // Project-root admission projects every missing/broken/raced path through
    // the same typed 400 below. statSync intentionally follows a directory
    // symlink while the returned request spelling remains unchanged.
  }
  throw Object.assign(new Error(`project root does not exist or is not a directory: ${repoRoot}`), {
    status: 400,
  });
}

export function normalizeRunStart(parsed: ControlRunStartRequest): ControlRunStartRequest {
  const mode = parsed.mode ?? "agent";
  // Empty chat is never a silent no-op (Bible): reject a blank prompt at the
  // engine boundary. Fail loud (400) rather than enqueue a doomed run that
  // produces nothing.
  if (parsed.prompt.trim().length === 0) {
    throw Object.assign(new Error("prompt must not be empty"), { status: 400 });
  }
  // The shared mode/strategy coherence owner (D11) refuses every strategy flag
  // on a mode it does not belong to (e.g. `delegate` on a non-agent mode),
  // rather than accepting a silent no-op knob (INV-023).
  const strategyViolations = runStartStrategyViolations(parsed);
  if (strategyViolations.length > 0) {
    throw Object.assign(new Error(strategyViolations.join("; ")), { status: 400 });
  }
  // Validate BEFORE enqueue (ARCHITECTURE §5): a contradictory web policy must
  // 400 here, not persist a doomed job for the orchestrator to reject later.
  if (parsed.web && parsed.externalContextPolicy && parsed.web !== parsed.externalContextPolicy) {
    throw Object.assign(
      new Error(
        `contradictory web policy: web='${parsed.web}' vs externalContextPolicy='${parsed.externalContextPolicy}' (pass one, or equal values)`,
      ),
      { status: 400 },
    );
  }
  // Live (in-place) isolation runs the harness directly in the execution tree
  // (the live project for an in-place thread, or the thread's worktree for an
  // isolated thread; also CLI convergence --in-place). It is an agent-only
  // concept — read-only modes have nothing to mutate; accepting it elsewhere
  // would silently run an envelope while claiming live semantics.
  if (parsed.execution?.isolation === "live" && mode !== "agent") {
    throw Object.assign(
      new Error(`execution.isolation='live' is only supported for agent runs, not '${mode}'`),
      { status: 400 },
    );
  }
  if (parsed.scope.kind === "project") {
    // Existence is the only filesystem precondition here: a NON-GIT folder is
    // fine — write modes initialize the git boundary themselves (announced via
    // the project.git.initialized run event; implausible roots — the user home
    // or a filesystem root — are refused there with a typed error, INV-075).
    const repoRoot = normalizeExistingProjectRoot(parsed.scope.root);
    return {
      ...parsed,
      scope: {
        kind: "project",
        root: repoRoot,
        context: parsed.scope.context ?? "auto",
        // Rebuilt field-by-field: an omitted key here would silently drop the
        // caller's one-shot declaration and register the root after all.
        ephemeral: parsed.scope.ephemeral,
      },
    };
  }
  if (mode === "ask") {
    mkdirSync(NO_PROJECT_ROOT, { recursive: true, mode: 0o700 });
    return parsed;
  }
  throw Object.assign(new Error(`project scope is required for mode '${mode}'`), { status: 400 });
}

/**
 * Single owner of run-start normalization. Both entry paths (HTTP control API
 * and the daemon socket runner) MUST use this so scope/secret/absolute-root
 * acceptance can never drift between surfaces.
 */
export function normalizeRunStartRequest(raw: unknown): ControlRunStartRequest {
  assertNoInlineSecretValues(raw);
  return normalizeRunStart(ControlRunStartRequest.parse(raw ?? {}));
}

export interface RunCreateRouteContext {
  daemon: DaemonFacadeClient;
  readBody(req: IncomingMessage): Promise<unknown>;
  requestError(res: ServerResponse, error: unknown): void;
  json(res: ServerResponse, status: number, body: unknown): void;
  respondToAcceptedJob(res: ServerResponse, jobId: string): Promise<void>;
  validateResources?: (refs: NonNullable<ControlRunStartRequest["attachments"]>) => Promise<void>;
  preflightRunRequirements?: (request: ControlRunStartRequest) => Promise<void>;
}

/**
 * Preserve a concurrently accepted idempotent command when mutable preflight
 * fails after the first durable lookup missed it. The second lookup is a
 * single race-closing probe, not polling; if it still misses (or cannot be
 * read), the original preflight error remains the response authority.
 */
export async function findAcceptedAroundPreflight<T>(
  findAccepted: () => Promise<T | null | undefined>,
  preflight: () => Promise<void>,
): Promise<T | null> {
  const prior = await findAccepted();
  if (prior) return prior;
  try {
    await preflight();
  } catch (preflightError) {
    try {
      const raced = await findAccepted();
      if (raced) return raced;
    } catch {
      // Preserve the causal preflight refusal when the race-closing probe itself fails.
    }
    throw preflightError;
  }
  return null;
}

export function unboundRunStartResponse(
  rec: DaemonRunRecord,
  terminal: boolean,
  terminalContext: Record<string, unknown> = {},
): { status: number; body: Record<string, unknown> } {
  // errorStatus is served verbatim only inside the failure range; anything
  // else (absent, or a non-4xx/5xx value from a defective writer) must not
  // turn a terminal failure body into a 2xx/3xx response.
  const errorStatus =
    typeof rec.errorStatus === "number" &&
    Number.isInteger(rec.errorStatus) &&
    rec.errorStatus >= 400 &&
    rec.errorStatus <= 599
      ? rec.errorStatus
      : 500;
  const queued = ControlQueuedRunInfo.parse({
    jobId: rec.id,
    state: rec.state,
    error: rec.error,
  });
  if (!terminal) return { status: 202, body: queued };
  return {
    status: errorStatus,
    body: {
      ...queued,
      ...(rec.errorCode ? { code: rec.errorCode } : {}),
      // The daemon producer owns retryability when it supplied the fact. A
      // legacy typed refusal without the field keeps the prior conservative
      // non-retryable fallback; an untyped terminal makes no claim.
      ...(rec.errorRetryable !== undefined
        ? { retryable: rec.errorRetryable }
        : rec.errorCode
          ? { retryable: false }
          : {}),
      requiredActions: rec.errorRequiredActions ?? [],
      context: {
        ...(rec.errorContext ?? {}),
        // Server-owned handles override any producer context with the same key.
        jobId: rec.id,
        state: rec.state,
        ...terminalContext,
      },
    },
  };
}

/** POST /v2/runs: validates, deduplicates, durably enqueues, then returns its handle.
 *
 * D10: POST /runs is the ONE-SHOT, THREAD-LESS run surface. A thread turn is
 * ALWAYS created through POST /threads/:id/turns (that route owns scope
 * resolution, turn lineage, and the continuation packet). `threadId` here is
 * therefore refused alongside the other server-owned lineage keys — routing a
 * turn past the turn pipeline would skip continuity entirely. */
export async function handleRunCreate(
  ctx: RunCreateRouteContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let idempotencyKey: string;
  let params: ControlRunStartRequest;
  try {
    idempotencyKey = requiredIdempotencyKey(req);
    const body = await ctx.readBody(req);
    assertNoInlineSecretValues(body);
    params = normalizeRunStart(ControlRunStartRequest.parse(body));
  } catch (error) {
    return ctx.requestError(res, error);
  }
  // Replay precedes every mutable capability/resource preflight. Once the
  // daemon durably accepted this exact key+request, a later Git, account, or
  // resource-state change must not replace its original handle with a new
  // admission result.
  try {
    const prior = await findAcceptedAroundPreflight(
      () =>
        ctx.daemon.findAccepted?.(params, {
          idempotencyKey,
          clientId: "control-api",
          idempotencyRequest: params,
        }) ?? Promise.resolve(null),
      async () => {
        await ctx.validateResources?.(params.attachments ?? []);
        await ctx.preflightRunRequirements?.(params);
      },
    );
    if (prior) return ctx.respondToAcceptedJob(res, prior.id);
  } catch (error) {
    return ctx.requestError(res, error);
  }
  if (params.threadId) {
    return ctx.json(res, 400, {
      error:
        "threadId is not accepted on POST /runs; continue a thread via POST /threads/:id/turns (the turn pipeline owns scope + continuity)",
    });
  }
  if (params.turnId) {
    return ctx.json(res, 400, {
      error: "turnId is not accepted on POST /runs; create the turn via POST /threads/:id/turns",
    });
  }
  if (params.planRunId) {
    return ctx.json(res, 400, {
      error:
        "planRunId is not accepted on POST /runs; use POST /threads/:id/turns (the turn pipeline implements the plan)",
    });
  }
  if (params.planRef) {
    // The frozen-plan reference is the tamper fence's INPUT: the orchestrator
    // trusts its sha256 by construction (INV-081), so a client-supplied
    // planRef would let a loopback caller point the plan brief at an
    // arbitrary file with a self-consistent hash. Only the daemon-internal
    // turn pipeline may mint one.
    return ctx.json(res, 400, {
      error:
        "planRef is not accepted on POST /runs; the frozen-plan reference is server-owned and minted by POST /threads/:id/turns at implement time",
    });
  }
  if (params.retryOf) {
    return ctx.json(res, 400, {
      error: "retryOf is server-owned; use POST /runs/:id/retry for Exact Retry",
    });
  }
  if (params.parentRunId || params.delegatedFromRunId) {
    return ctx.json(res, 400, {
      error:
        "parentRunId and delegatedFromRunId are server-owned lineage; Delegate children are created only by the scoped belt",
    });
  }
  let job: { id: string };
  try {
    job = await ctx.daemon.enqueue(params, {
      idempotencyKey,
      clientId: "control-api",
      idempotencyRequest: params,
    });
  } catch (error) {
    const status =
      error && typeof error === "object" && "status" in error
        ? Number((error as { status: number }).status)
        : 500;
    return ctx.json(res, status, {
      error: error instanceof Error ? error.message : "enqueue failed",
    });
  }
  try {
    return await ctx.respondToAcceptedJob(res, job.id);
  } catch (error) {
    return ctx.json(res, 500, {
      error: `job ${job.id} was accepted but its start could not be observed: ${error instanceof Error ? error.message : String(error)}`,
      jobId: job.id,
    });
  }
}

export function requiredIdempotencyKey(req: IncomingMessage): string {
  const header = req.headers["idempotency-key"];
  if (Array.isArray(header) || typeof header !== "string" || !header.trim()) {
    throw Object.assign(new Error("Idempotency-Key is required"), {
      code: "idempotency_key_required",
      status: 400,
      fieldErrors: { "Idempotency-Key": ["required for create operations"] },
    });
  }
  const value = header.trim();
  if (value.length > 256) {
    throw Object.assign(new Error("Idempotency-Key must contain 1-256 characters"), {
      code: "invalid_idempotency_key",
      status: 400,
    });
  }
  return value;
}

/**
 * An OPTIONAL Idempotency-Key: `undefined` when the client sent none, the
 * validated value when present. Unlike `requiredIdempotencyKey` an absent header
 * is NOT a 400 — it selects legacy non-idempotent behavior for operations whose
 * key is optional (the current installed macOS app sends no key). A present but
 * malformed key still fails loudly (a key the client believed it sent must not
 * silently degrade to non-idempotent).
 */
export function optionalIdempotencyKey(req: IncomingMessage): string | undefined {
  const header = req.headers["idempotency-key"];
  if (header === undefined) return undefined;
  if (Array.isArray(header) || typeof header !== "string" || !header.trim()) {
    throw Object.assign(new Error("Idempotency-Key, when present, must be a non-empty value"), {
      code: "invalid_idempotency_key",
      status: 400,
    });
  }
  const value = header.trim();
  if (value.length > 256) {
    throw Object.assign(new Error("Idempotency-Key must contain 1-256 characters"), {
      code: "invalid_idempotency_key",
      status: 400,
    });
  }
  return value;
}

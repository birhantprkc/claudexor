import { z } from "zod/v3";
import { CostEvidence } from "./budget.js";
import { CostKnowledge } from "./auth.js";
import { CANCEL_REASON_CODES } from "./cancel-reason.js";
import { Id, IsoTimestamp, NonBlankString } from "./primitives.js";
import { ControlProblem } from "./problem.js";
import { RunLifecycle } from "./status-projection.js";
import { TokenUsage } from "./telemetry.js";

export const ModelPayloadRef = z
  .object({
    resourceId: Id,
    sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    sizeBytes: z.number().int().nonnegative(),
  })
  .strict()
  .describe("Digest-bound model-purpose resource; never an Agent attachment.");
export type ModelPayloadRef = z.infer<typeof ModelPayloadRef>;

export const ModelAccountChoice = z
  .discriminatedUnion("mode", [
    z.object({ mode: z.literal("auto"), preferredProfileId: Id.optional() }).strict(),
    z.object({ mode: z.literal("pin"), profileId: Id }).strict(),
  ])
  .describe("Auto keeps a usable prior account; pin never selects another account.");
export type ModelAccountChoice = z.infer<typeof ModelAccountChoice>;

export const ModelRoute = z
  .object({
    source: Id,
    credentialProfileId: Id,
    accountFingerprint: z.string().nullable(),
    model: z.string().nullable(),
  })
  .strict()
  .describe("Selected route at dispatch; a result records the actually observed model, or null.");
export type ModelRoute = z.infer<typeof ModelRoute>;

export const ModelNativeContinuation = z
  .object({
    route: ModelRoute,
    format: NonBlankString,
    payload: z.unknown(),
  })
  .strict()
  .describe(
    "Complete provider-native assistant turn, bound to its account and model; replaces reconstruction on replay.",
  );
export type ModelNativeContinuation = z.infer<typeof ModelNativeContinuation>;

export const ModelToolCall = z
  .object({
    id: Id,
    type: z.literal("function"),
    function: z.object({ name: NonBlankString, arguments: z.string() }).strict(),
  })
  .strict();
export type ModelToolCall = z.infer<typeof ModelToolCall>;

export const ModelMessage = z
  .object({
    role: z.enum(["system", "developer", "user", "assistant", "tool"]),
    content: z.union([z.string(), z.array(z.record(z.string(), z.unknown()))]).nullable(),
    name: z.string().optional(),
    tool_call_id: Id.optional(),
    tool_calls: z.array(ModelToolCall).optional(),
    nativeContinuation: ModelNativeContinuation.optional(),
  })
  .strict()
  .describe(
    "Caller-owned conversation message. Text, content blocks, and tool arguments are not redacted or rewritten.",
  );
export type ModelMessage = z.infer<typeof ModelMessage>;

export const ModelTool = z
  .object({
    type: z.literal("function"),
    function: z
      .object({
        name: NonBlankString,
        description: z.string().optional(),
        parameters: z.record(z.string(), z.unknown()),
        strict: z.boolean().optional(),
      })
      .strict(),
  })
  .strict()
  .describe(
    "A caller-executed function; the model transport never executes it or rewrites its JSON schema.",
  );
export type ModelTool = z.infer<typeof ModelTool>;

export const ModelToolChoice = z.union([
  z.enum(["auto", "none", "required"]),
  z
    .object({ type: z.literal("function"), function: z.object({ name: NonBlankString }).strict() })
    .strict(),
]);
export type ModelToolChoice = z.infer<typeof ModelToolChoice>;

export const ModelCallOptions = z
  .object({
    reasoningEffort: NonBlankString.optional(),
    serviceTier: NonBlankString.optional(),
    parallelToolCalls: z.boolean().optional(),
    cacheKey: NonBlankString.optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    temperature: z.number().finite().optional(),
  })
  .strict()
  .describe(
    "Generation options only, not a caller's context/output reserve; unsupported explicit options refuse before inference.",
  );
export type ModelCallOptions = z.infer<typeof ModelCallOptions>;

export const ModelCallRequest = z
  .object({
    source: Id,
    model: NonBlankString,
    account: ModelAccountChoice,
    messages: z.array(ModelMessage).min(1),
    tools: z.array(ModelTool).default([]),
    toolChoice: ModelToolChoice.default("auto"),
    options: ModelCallOptions.default({}),
  })
  .strict()
  .describe(
    "One model generation request, stored only in a model-purpose payload outside the command journal.",
  );
export type ModelCallRequest = z.infer<typeof ModelCallRequest>;

export const ModelUsage = TokenUsage.extend({
  cache_write_tokens: z.number().int().nonnegative().nullable().default(null),
  reasoning_tokens: z.number().int().nonnegative().nullable().default(null),
}).describe("Provider-reported counters for one generation; missing counters remain null.");
export type ModelUsage = z.infer<typeof ModelUsage>;

export const ModelCostEvidence = CostEvidence.extend({
  cashUsd: z.number().nonnegative().nullable().default(null),
  valuationUsd: z.number().nonnegative().nullable().default(null),
  valuationKnowledge: CostKnowledge.default("unknown"),
}).describe(
  "Incremental cash and token valuation are independent; subscription credentials alone never invent a cash receipt.",
);
export type ModelCostEvidence = z.infer<typeof ModelCostEvidence>;

export const ModelCallResult = z
  .object({
    outcome: z.enum(["completed", "incomplete", "failed", "unknown"]),
    message: ModelMessage.nullable(),
    route: ModelRoute,
    usage: ModelUsage,
    cost: ModelCostEvidence,
    appliedOptions: ModelCallOptions,
    problem: ControlProblem.nullable(),
  })
  .strict()
  .describe(
    "One provider outcome; completed means a terminal response, never an EOF or a partial tool argument.",
  );
export type ModelCallResult = z.infer<typeof ModelCallResult>;

export const ModelCatalogEntry = z
  .object({
    id: NonBlankString,
    label: z.string().nullable(),
    isDefault: z.boolean(),
    contextWindow: z.number().int().positive().nullable(),
    maxContextWindow: z.number().int().positive().nullable(),
    maxOutputTokens: z.number().int().positive().nullable(),
    inputModalities: z.array(z.string()),
    reasoningEfforts: z.array(z.string()),
    defaultReasoningEffort: z.string().nullable(),
    supportedOptions: z.array(z.string()),
  })
  .strict()
  .describe(
    "Model metadata from the selected raw transport; CLI compaction and usable-window policies are not capacity.",
  );
export type ModelCatalogEntry = z.infer<typeof ModelCatalogEntry>;

export const ControlModelSourcesResponse = z
  .object({
    sources: z.array(
      z
        .object({
          id: Id,
          label: NonBlankString,
          credentialHarness: Id,
        })
        .strict(),
    ),
  })
  .strict()
  .describe("Available raw model transports, distinct from agent harness inventory.");
export type ControlModelSourcesResponse = z.infer<typeof ControlModelSourcesResponse>;

export const ControlModelCatalogResponse = z
  .object({
    source: Id,
    credentialProfileId: Id,
    accountFingerprint: z.string().nullable(),
    observedAt: IsoTimestamp.describe(
      "Original catalog observation time; cached reuse never advances it.",
    ),
    provenance: NonBlankString.describe(
      "provider_http means the catalog body was read and validated from a successful upstream HTTP response at observedAt. Other values do not certify provider contact.",
    ),
    models: z.array(ModelCatalogEntry),
  })
  .strict()
  .describe(
    "Exact-profile model discovery, not a global CLI alias list or an inference entitlement guarantee.",
  );
export type ControlModelCatalogResponse = z.infer<typeof ControlModelCatalogResponse>;

export const ModelDispatch = z
  .object({
    state: z.enum(["not_started", "started", "response_received", "unknown"]),
    startedAt: IsoTimestamp.nullable(),
    route: ModelRoute.nullable(),
  })
  .strict()
  .describe("Started means the physical send may have begun, not proof the upstream accepted it.");
export type ModelDispatch = z.infer<typeof ModelDispatch>;

export const ModelResponseCustody = z
  .discriminatedUnion("state", [
    z.object({ state: z.literal("absent") }).strict(),
    z
      .object({
        state: z.literal("ready"),
        ref: ModelPayloadRef,
        readyAt: IsoTimestamp,
        expiresAt: IsoTimestamp,
      })
      .strict(),
    z
      .object({ state: z.literal("acknowledged"), ref: ModelPayloadRef, releasedAt: IsoTimestamp })
      .strict(),
    z
      .object({ state: z.literal("expired"), ref: ModelPayloadRef, releasedAt: IsoTimestamp })
      .strict(),
  ])
  .describe(
    "Result GET does not acknowledge delivery. Acknowledged/expired bytes never cause another generation.",
  );
export type ModelResponseCustody = z.infer<typeof ModelResponseCustody>;

export const ModelOperationParams = z
  .object({ kind: z.literal("model"), request: ModelPayloadRef })
  .strict();
export type ModelOperationParams = z.infer<typeof ModelOperationParams>;

/** Command-kind discrimination only; execution validates the complete params.
 * History scans need the kind, not a new Zod parse of every retained receipt. */
export function isModelOperation(params: unknown): boolean {
  return (
    typeof params === "object" && params !== null && "kind" in params && params.kind === "model"
  );
}

export const ModelOperationReceipt = z
  .object({
    lifecycle: RunLifecycle.exclude(["queued", "running"]),
    dispatch: ModelDispatch,
    response: ModelResponseCustody,
    usage: ModelUsage,
    cost: ModelCostEvidence.nullable(),
    problem: ControlProblem.nullable(),
  })
  .strict()
  .describe(
    "Compact command-owned terminal receipt; request/response bodies never ride journal updates.",
  );
export type ModelOperationReceipt = z.infer<typeof ModelOperationReceipt>;

export const ControlModelOperationCreateRequest = z.object({ request: ModelPayloadRef }).strict();
export type ControlModelOperationCreateRequest = z.infer<typeof ControlModelOperationCreateRequest>;
export const ControlModelOperationAckRequest = z
  .object({ sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/) })
  .strict();
export type ControlModelOperationAckRequest = z.infer<typeof ControlModelOperationAckRequest>;
export const ControlModelOperationControlRequest = z
  .object({
    action: z.literal("cancel"),
    reasonCode: z.enum(CANCEL_REASON_CODES).optional(),
  })
  .strict();
export type ControlModelOperationControlRequest = z.infer<
  typeof ControlModelOperationControlRequest
>;
export const ControlModelOperationDetail = z
  .object({
    id: Id,
    state: RunLifecycle,
    createdAt: IsoTimestamp,
    startedAt: IsoTimestamp.nullable(),
    finishedAt: IsoTimestamp.nullable(),
    dispatch: ModelDispatch,
    response: ModelResponseCustody,
    usage: ModelUsage,
    cost: ModelCostEvidence.nullable(),
    problem: ControlProblem.nullable(),
  })
  .strict();
export type ControlModelOperationDetail = z.infer<typeof ControlModelOperationDetail>;

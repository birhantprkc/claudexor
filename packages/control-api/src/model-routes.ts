import type { IncomingMessage, ServerResponse } from "node:http";
import {
  ControlModelSourcesResponse,
  ControlModelCatalogResponse,
  ModelCallRequest,
  ControlModelOperationCreateRequest,
  ControlModelOperationDetail,
  ControlModelOperationAckRequest,
  ControlModelOperationControlRequest,
  Id,
  type ModelPayloadRef,
  type CancelReasonCode,
} from "@claudexor/schema";
import type { OperationDraft } from "./operation-draft.js";
import { queryParam } from "./operation-parameters.js";
import { assertOnlyQueryParams, singleQuery } from "./query.js";
import { requiredIdempotencyKey } from "./run-start.js";
import { routeValue, serviceResponse } from "./route-stages.js";
import { writeBinaryResponse } from "./binary-response.js";
import type { ResourceRouteContext } from "./resource-routes.js";

/** Model operations are commands, not Agent Runs. No tool execution or conversation state. */
export interface ModelRouteServices {
  modelSources(): Promise<unknown>;
  modelCatalog(
    source: string,
    credentialProfileId?: string,
    requestedModel?: string,
  ): Promise<unknown>;
  createModelOperation(request: ModelPayloadRef, idempotencyKey: string): Promise<unknown>;
  getModelOperation(id: string): Promise<unknown>;
  readModelResult(id: string): Promise<{ bytes: Buffer; sha256: string }>;
  acknowledgeModelResult(id: string, sha256: string): Promise<unknown>;
  cancelModelOperation(id: string, reason?: CancelReasonCode): Promise<unknown>;
}

type Context = Omit<ResourceRouteContext, "services"> & { services?: Partial<ModelRouteServices> };

export async function handleModelRoute(
  ctx: Context,
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const services = ctx.services;
  if (method === "GET" && path === "/model-sources") {
    if (!services?.modelSources) return false;
    const value = await routeValue(ctx, res, 500, () => services.modelSources!());
    if (!value.ok) return true;
    return serviceResponse(ctx, res, "modelSources", () =>
      ctx.json(res, 200, ControlModelSourcesResponse.parse(value.value)),
    );
  }
  const catalogMatch = /^\/model-sources\/([^/]+)\/models$/.exec(path);
  if (method === "GET" && catalogMatch) {
    if (!services?.modelCatalog) return false;
    const input = await routeValue(ctx, res, 400, () => {
      const query = new URL(req.url ?? "/", "http://localhost");
      assertOnlyQueryParams(query, ["credentialProfileId", "requestedModel"]);
      const profile = singleQuery(query, "credentialProfileId");
      const model = singleQuery(query, "requestedModel");
      return {
        source: Id.parse(decodeURIComponent(catalogMatch[1]!)),
        profile: profile === undefined ? undefined : Id.parse(profile),
        model: model === undefined ? undefined : ModelCallRequest.shape.model.parse(model),
      };
    });
    if (!input.ok) return true;
    const value = await routeValue(ctx, res, 500, () =>
      services.modelCatalog!(input.value.source, input.value.profile, input.value.model),
    );
    if (!value.ok) return true;
    return serviceResponse(ctx, res, "modelCatalog", () =>
      ctx.json(res, 200, ControlModelCatalogResponse.parse(value.value)),
    );
  }
  if (method === "POST" && path === "/model-operations") {
    if (!services?.createModelOperation) return false;
    const input = await routeValue(ctx, res, 400, async () => ({
      key: requiredIdempotencyKey(req),
      body: ControlModelOperationCreateRequest.parse(await ctx.readBody(req)),
    }));
    if (!input.ok) return true;
    const value = await routeValue(ctx, res, 500, () =>
      services.createModelOperation!(input.value.body.request, input.value.key),
    );
    if (!value.ok) return true;
    return serviceResponse(ctx, res, "createModelOperation", () =>
      ctx.json(res, 202, ControlModelOperationDetail.parse(value.value)),
    );
  }
  const detailMatch = /^\/model-operations\/([^/]+)$/.exec(path);
  const resultMatch = /^\/model-operations\/([^/]+)\/result$/.exec(path);
  const ackMatch = /^\/model-operations\/([^/]+)\/ack$/.exec(path);
  const controlMatch = /^\/model-operations\/([^/]+)\/control$/.exec(path);
  let action: "get" | "result" | "ack" | "control";
  let encodedId: string;
  if (method === "GET" && detailMatch) {
    if (!services?.getModelOperation) return false;
    action = "get";
    encodedId = detailMatch[1]!;
  } else if (method === "GET" && resultMatch) {
    if (!services?.readModelResult) return false;
    action = "result";
    encodedId = resultMatch[1]!;
  } else if (method === "POST" && ackMatch) {
    if (!services?.acknowledgeModelResult) return false;
    action = "ack";
    encodedId = ackMatch[1]!;
  } else if (method === "POST" && controlMatch) {
    if (!services?.cancelModelOperation) return false;
    action = "control";
    encodedId = controlMatch[1]!;
  } else return false;
  const id = await routeValue(ctx, res, 400, () => Id.parse(decodeURIComponent(encodedId)));
  if (!id.ok) return true;
  if (action === "result") {
    const value = await routeValue(ctx, res, 500, () => services!.readModelResult!(id.value));
    if (!value.ok) return true;
    // Exact model bytes, not the redacted/bounded Agent artifact projection.
    // Reading never acknowledges delivery: only the caller can accept custody.
    return serviceResponse(ctx, res, "readModelResult", () => {
      const digest = ControlModelOperationAckRequest.parse({ sha256: value.value.sha256 }).sha256;
      res.setHeader("ETag", `"${digest}"`);
      writeBinaryResponse(
        res,
        200,
        value.value.bytes,
        "application/json; charset=utf-8",
        "model-result.json",
      );
    });
  }
  const input = await routeValue(ctx, res, 400, async () =>
    action === "ack"
      ? ControlModelOperationAckRequest.parse(await ctx.readBody(req))
      : action === "control"
        ? ControlModelOperationControlRequest.parse(await ctx.readBody(req))
        : null,
  );
  if (!input.ok) return true;
  const value = await routeValue(ctx, res, 500, () => {
    if (input.value && "sha256" in input.value)
      return services!.acknowledgeModelResult!(id.value, input.value.sha256);
    if (input.value && "action" in input.value)
      return services!.cancelModelOperation!(id.value, input.value.reasonCode);
    return services!.getModelOperation!(id.value);
  });
  if (!value.ok) return true;
  return serviceResponse(ctx, res, "modelOperation", () =>
    ctx.json(res, 200, ControlModelOperationDetail.parse(value.value)),
  );
}

/** Kept alongside the actual route contract; the common catalog projects IDs and auth. */
export const MODEL_OPERATION_DRAFTS: OperationDraft[] = [
  {
    method: "GET",
    path: "/v2/model-sources",
    mutability: "read_only",
    requestSchema: null,
    responseSchema: "ControlModelSourcesResponse",
    responseKind: "json",
    summary: "List raw model transports, independent of agent harnesses.",
  },
  {
    method: "GET",
    path: "/v2/model-sources/:id/models",
    mutability: "read_only",
    requestSchema: null,
    responseSchema: "ControlModelCatalogResponse",
    responseKind: "json",
    summary: "Read a selected account's raw model catalog and context evidence.",
    parameters: [
      queryParam({
        name: "credentialProfileId",
        description: "Pin a managed profile; omitted selects the engine's Auto account.",
      }),
      queryParam({
        name: "requestedModel",
        schemaRef: "ModelCallRequest#/properties/model",
        description:
          "Select one account able to serve this model using the inference pool criteria; omitted discovers one account without a model constraint.",
      }),
    ],
  },
  {
    method: "POST",
    path: "/v2/model-operations",
    mutability: "mutating",
    requestSchema: "ControlModelOperationCreateRequest",
    responseSchema: "ControlModelOperationDetail",
    responseKind: "json",
    summary: "Accept one idempotent model generation without an agent run.",
    idempotency: "key_required",
    completion: "durable_handle",
  },
  {
    method: "GET",
    path: "/v2/model-operations/:id",
    mutability: "read_only",
    requestSchema: null,
    responseSchema: "ControlModelOperationDetail",
    responseKind: "json",
    summary: "Inspect dispatch, outcome and response custody for the same operation.",
  },
  {
    method: "GET",
    path: "/v2/model-operations/:id/result",
    mutability: "read_only",
    requestSchema: null,
    responseSchema: null,
    responseKind: "binary",
    summary: "Read exact model response bytes without acknowledging delivery.",
  },
  {
    method: "POST",
    path: "/v2/model-operations/:id/ack",
    mutability: "mutating",
    requestSchema: "ControlModelOperationAckRequest",
    responseSchema: "ControlModelOperationDetail",
    responseKind: "json",
    summary: "Acknowledge the exact result digest and release temporary model bytes.",
    idempotency: "natural",
  },
  {
    method: "POST",
    path: "/v2/model-operations/:id/control",
    mutability: "mutating",
    requestSchema: "ControlModelOperationControlRequest",
    responseSchema: "ControlModelOperationDetail",
    responseKind: "json",
    summary: "Cancel an existing model operation; settled results remain settled.",
    idempotency: "natural",
  },
];

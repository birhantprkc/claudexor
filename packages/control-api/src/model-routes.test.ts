import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlModelOperationDetail, ModelUsage } from "@claudexor/schema";
import { DaemonControlApiServer, type DaemonControlApiOptions } from "./daemon-server.js";
import { OPERATION_CATALOG } from "./operation-catalog.js";

const servers: DaemonControlApiServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
});
const ref = { resourceId: "resource-test", sha256: `sha256:${"a".repeat(64)}`, sizeBytes: 42 };
const detail = () =>
  ControlModelOperationDetail.parse({
    id: "job-model",
    state: "queued",
    createdAt: "2026-09-06T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    dispatch: { state: "not_started", startedAt: null, route: null },
    response: { state: "absent" },
    usage: ModelUsage.parse({}),
    cost: null,
    problem: null,
  });
async function fixture(services: DaemonControlApiOptions["services"], recovery = false) {
  const daemon = {
    enqueue: vi.fn(),
    status: vi.fn(),
    list: vi.fn(async () => []),
    cancel: vi.fn(),
  };
  const server = new DaemonControlApiServer({
    token: "model-test-control",
    daemon,
    services,
    ...(recovery ? { servingMode: () => "recovery_only" as const } : {}),
  });
  servers.push(server);
  const address = await server.start();
  const request = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`http://${address.host}:${address.port}/v2${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: "Bearer model-test-control",
        "X-Claudexor-Protocol-Major": "3",
        "Content-Type": "application/json",
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { request, daemon };
}

describe("raw model operation HTTP surface", () => {
  it("requires idempotency before accepting refs and never enqueues an Agent Run", async () => {
    const createModelOperation = vi.fn(async () => detail());
    const f = await fixture({ createModelOperation });
    expect((await f.request("/model-operations", { request: ref })).status).toBe(400);
    expect(createModelOperation).not.toHaveBeenCalled();
    const accepted = await f.request(
      "/model-operations",
      { request: ref },
      { "Idempotency-Key": "stable-operation" },
    );
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual(detail());
    expect(createModelOperation).toHaveBeenCalledWith(ref, "stable-operation");
    expect(f.daemon.enqueue).not.toHaveBeenCalled();
    expect(
      (
        await f.request(
          "/model-operations",
          { request: { ...ref, prompt: "no inline body" } },
          { "Idempotency-Key": "bad" },
        )
      ).status,
    ).toBe(400);
    expect(createModelOperation).toHaveBeenCalledTimes(1);
  });

  it("returns >4MiB exact bytes with no content redaction and no implicit ACK", async () => {
    const bytes = Buffer.from(
      JSON.stringify({ content: "sk-" + "z".repeat(80) + "🦉" + "q".repeat(5 * 1024 * 1024) }),
    );
    const sha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const readModelResult = vi.fn(async () => ({ bytes, sha256 }));
    const acknowledgeModelResult = vi.fn(async () => detail());
    const f = await fixture({ readModelResult, acknowledgeModelResult });
    for (let index = 0; index < 2; index++) {
      const response = await f.request("/model-operations/job-model/result");
      expect(response.status).toBe(200);
      expect(response.headers.get("etag")).toBe(`"${sha256}"`);
      expect(response.headers.get("content-length")).toBe(String(bytes.length));
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(Buffer.from(await response.arrayBuffer()).equals(bytes)).toBe(true);
    }
    expect(acknowledgeModelResult).not.toHaveBeenCalled();
    expect((await f.request("/model-operations/job-model/ack", { sha256 })).status).toBe(200);
    expect(acknowledgeModelResult).toHaveBeenCalledWith("job-model", sha256);
  });

  it("retains typed released-result and cancellation responses without regeneration", async () => {
    const getModelOperation = vi.fn(async () => detail());
    const cancelModelOperation = vi.fn(async () => ({ ...detail(), state: "cancelled" }));
    const readModelResult = vi.fn(async () => {
      throw Object.assign(new Error("already released"), {
        code: "model_result_released",
        status: 410,
      });
    });
    const f = await fixture({ getModelOperation, cancelModelOperation, readModelResult });
    expect((await f.request("/model-operations/job-model")).status).toBe(200);
    const gone = await f.request("/model-operations/job-model/result");
    expect(gone.status).toBe(410);
    expect(await gone.json()).toMatchObject({ code: "model_result_released" });
    const cancelled = await f.request("/model-operations/job-model/control", {
      action: "cancel",
      reasonCode: "user_cancelled",
    });
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({ state: "cancelled" });
    expect(cancelModelOperation).toHaveBeenCalledWith("job-model", "user_cancelled");
    expect(f.daemon.enqueue).not.toHaveBeenCalled();
  });

  it("keeps raw catalogs account-scoped and leaves omitted profile selection to the engine", async () => {
    const modelSources = vi.fn(async () => ({
      sources: [{ id: "codex", label: "Codex", credentialHarness: "codex" }],
    }));
    const modelCatalog = vi.fn(async (source, profile) => ({
      source,
      credentialProfileId: profile ?? "chosen",
      accountFingerprint: null,
      observedAt: "2026-09-06T00:00:00.000Z",
      provenance: "fixture",
      models: [],
    }));
    const f = await fixture({ modelSources, modelCatalog });
    expect((await f.request("/model-sources")).status).toBe(200);
    expect((await f.request("/model-sources/codex/models")).status).toBe(200);
    expect(modelCatalog).toHaveBeenLastCalledWith("codex", undefined, undefined);
    expect((await f.request("/model-sources/codex/models?credentialProfileId=chosen")).status).toBe(
      200,
    );
    expect(modelCatalog).toHaveBeenLastCalledWith("codex", "chosen", undefined);
    expect(
      (await f.request("/model-sources/codex/models?requestedModel=exact%2Fmodel%2B1")).status,
    ).toBe(200);
    expect(modelCatalog).toHaveBeenLastCalledWith("codex", undefined, "exact/model+1");
    expect(
      (
        await f.request(
          "/model-sources/codex/models?credentialProfileId=chosen&requestedModel=exact-model",
        )
      ).status,
    ).toBe(200);
    expect(modelCatalog).toHaveBeenLastCalledWith("codex", "chosen", "exact-model");
    for (const query of [
      "credentialProfileId=a&credentialProfileId=b",
      "account=b",
      "credentialProfileId=",
      "requestedModel=",
      "requestedModel=%20%20",
      "requestedModel=a&requestedModel=b",
    ]) {
      expect((await f.request(`/model-sources/codex/models?${query}`)).status).toBe(400);
    }
    expect(modelCatalog).toHaveBeenCalledTimes(4);
  });

  it("refuses malformed service output and protects all model routes in recovery mode", async () => {
    const invalid = await fixture({ getModelOperation: async () => ({ id: "lying" }) });
    const response = await invalid.request("/model-operations/job-model");
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: "invalid_service_response" });
    const createModelOperation = vi.fn(async () => detail());
    const recovery = await fixture({ createModelOperation }, true);
    expect(
      (
        await recovery.request(
          "/model-operations",
          { request: ref },
          { "Idempotency-Key": "recovery" },
        )
      ).status,
    ).toBe(503);
    expect((await recovery.request("/model-sources")).status).toBe(503);
    expect(createModelOperation).not.toHaveBeenCalled();
    const advertised = OPERATION_CATALOG.operations.filter((op) =>
      op.path.startsWith("/v2/model-"),
    );
    expect(advertised).toHaveLength(7);
    expect(
      advertised.find((op) => op.path === "/v2/model-operations" && op.method === "POST"),
    ).toMatchObject({ idempotency: "key_required", completion: "durable_handle" });
  });
});

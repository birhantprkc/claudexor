import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DurableJournal } from "@claudexor/journal";
import type { ModelAdapter } from "@claudexor/core";
import {
  ControlModelOperationDetail,
  CredentialProfile,
  ModelCallRequest,
  ModelCallResult,
  ModelOperationParams,
  type ModelPayloadRef,
} from "@claudexor/schema";
import { CommandStore } from "./command-store.js";
import { DaemonClient } from "./client.js";
import { DaemonServer } from "./server.js";
import { ResourceStore } from "./resource-store.js";
import { ModelOperations } from "./model-operations.js";
import { DaemonControlApiServer } from "../../control-api/src/daemon-server.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

const request = (content = "own conversation") =>
  ModelCallRequest.parse({
    source: "codex",
    model: "test-model",
    account: { mode: "pin", profileId: "fixture" },
    messages: [{ role: "system", content }],
  });
const route = {
  source: "codex",
  credentialProfileId: "fixture",
  accountFingerprint: "account-A",
  model: "test-model",
};
const result = () =>
  ModelCallResult.parse({
    outcome: "completed",
    message: { role: "assistant", content: "exact result 🦉" },
    route,
    usage: { input_tokens: 3, output_tokens: 2 },
    cost: { knowledge: "unknown", billing: "unknown", source: "fixture", provenance: ["test"] },
    appliedOptions: {},
    problem: null,
  });

async function fixture(
  invoke?: ModelAdapter["invoke"],
  history: { maxHistory?: number; idempotencyRetentionMs?: number } = {},
) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "cx-mo-")));
  let clock = new Date();
  const journal = new DurableJournal({ rootDir: join(root, "journal"), partition: "global" });
  const store = new CommandStore(journal, () => clock);
  const commands = { current: () => store };
  const resources = new ResourceStore(join(root, "resources"));
  const socket =
    process.platform === "win32" ? `\\\\.\\pipe\\cx-mo-${randomUUID()}` : join(root, "daemon.sock");
  const client = new DaemonClient(socket, "fixture-control");
  const sends = vi.fn();
  const adapter: ModelAdapter = {
    id: "codex",
    catalog: vi.fn(),
    invoke:
      invoke ??
      (async (_input, context) => {
        await context.onDispatch(route);
        sends();
        return result();
      }),
  };
  const profile = CredentialProfile.parse({
    profile_id: "fixture",
    harness_id: "codex",
    display_name: "Fixture",
    credential_kind: "config_dir_login",
    isolation_locator: join(root, "profile"),
  });
  const operations = new ModelOperations({
    commands,
    resources: () => resources,
    now: () => clock,
    enqueue: (envelope) => client.call("claudexor.enqueue", envelope),
    cancel: (id, reason) => client.cancel(id, reason),
    resolve: async () => ({ adapter, profile }),
  });
  const server = new DaemonServer({
    ...history,
    socketPath: socket,
    token: "fixture-control",
    commands,
    maxConcurrent: 1,
    runner: (input, context) => operations.execute(input, context),
    onCommandTerminal: (record) => operations.onCommandTerminal(record),
  });
  await server.start();
  cleanup.push(async () => {
    await server.stop();
    operations.close();
    journal.close();
    rmSync(root, { recursive: true, force: true });
  });
  const upload = (body = request()): ModelPayloadRef =>
    resources.publishModel(Buffer.from(JSON.stringify(body)));
  const terminal = async (id: string) => {
    await vi.waitFor(
      () => expect(["queued", "running"]).not.toContain(operations.inspect(id).state),
      { timeout: 10_000, interval: 5 },
    );
    return operations.inspect(id);
  };
  return {
    root,
    store,
    resources,
    operations,
    server,
    client,
    sends,
    upload,
    terminal,
    setNow: (time: Date) => {
      clock = time;
    },
  };
}

describe("model operations over the existing daemon command substrate", () => {
  it("keeps turn state in result custody across rejoin and ACK, outside public receipts", async () => {
    const nativeContinuation = {
      route,
      format: "codex.turn.v1",
      payload: { turnState: "private-turn-token" },
    };
    const invoke = vi.fn<ModelAdapter["invoke"]>(async (input, context) => {
      expect(input.nativeContinuation).toBeNull();
      await context.onDispatch(route);
      return { ...result(), outcome: "unknown", message: null, nativeContinuation };
    });
    const f = await fixture(invoke);
    const ref = f.upload({ ...request(), nativeContinuation: null });
    const created = await f.operations.create(ref, "turn-state-rejoin");
    const done = await f.terminal(created.id);
    expect(JSON.stringify(done)).not.toContain("private-turn-token");
    expect(JSON.stringify(f.store.records())).not.toContain("private-turn-token");
    const first = f.operations.readResult(created.id);
    expect(JSON.parse(first.bytes.toString()).nativeContinuation).toEqual(nativeContinuation);
    expect((await f.operations.create(ref, "turn-state-rejoin")).id).toBe(created.id);
    expect(f.operations.readResult(created.id).bytes.equals(first.bytes)).toBe(true);
    f.operations.acknowledge(created.id, first.sha256);
    expect((await f.operations.create(ref, "turn-state-rejoin")).response.state).toBe(
      "acknowledged",
    );
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it.each([{ stop_reason: "end_turn" }, { refusal: "The prior provider refused." }])(
    "reports invalid uploaded model bytes through HTTP as pre-admission 400: %j",
    async (extra) => {
      const f = await fixture();
      const api = new DaemonControlApiServer({
        token: "fixture-control",
        daemon: f.client,
        services: {
          createModelOperation: f.operations.create.bind(f.operations),
          getModelOperation: async (id) => f.operations.inspect(id),
        },
      });
      const address = await api.start();
      cleanup.push(() => api.stop());
      const ref = f.resources.publishModel(
        Buffer.from(
          JSON.stringify({
            ...request(),
            messages: [{ role: "assistant", content: "private caller content", ...extra }],
          }),
        ),
      );
      const headers = {
        Authorization: "Bearer fixture-control",
        "X-Claudexor-Protocol-Major": "3",
        "Content-Type": "application/json",
        "Idempotency-Key": "invalid-model-body",
      };
      const endpoint = `http://${address.host}:${address.port}/v2/model-operations`;
      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ request: ref }),
      });
      expect(response.status).toBe(400);
      const problem = await response.json();
      expect(problem).toMatchObject({ code: "model_request_invalid", retryable: false });
      expect(JSON.stringify(problem)).not.toContain("private caller content");
      expect(f.store.records()).toEqual([]);
      expect(f.sends).not.toHaveBeenCalled();
      const absent = await fetch(`${endpoint}/not-created`, { headers });
      expect(absent.status).toBe(404);
      expect(await absent.json()).toMatchObject({ code: "model_operation_not_found" });
      // The invalid body never claimed the key. A corrected request can use it,
      // and an accepted replay must not validate a since-released upload copy.
      const accepted = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ request: f.upload() }),
      });
      expect(accepted.status).toBe(202);
      const created = ControlModelOperationDetail.parse(await accepted.json());
      await f.terminal(created.id);
      f.operations.acknowledge(created.id, f.operations.readResult(created.id).sha256);
      const replacement = f.upload();
      f.resources.releaseModel(replacement);
      const replay = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ request: replacement }),
      });
      expect(replay.status).toBe(202);
      expect(await replay.json()).toMatchObject({
        id: created.id,
        response: { state: "acknowledged" },
      });
      expect(f.store.records()).toHaveLength(1);
      expect(f.sends).toHaveBeenCalledTimes(1);
    },
  );
  it("keeps >10 MiB bodies out of the journal and preserves a result until explicit ACK", async () => {
    const f = await fixture();
    const ref = f.upload(request("private-model-marker" + "x".repeat(11 * 1024 * 1024)));
    const created = await f.operations.create(ref, "large");
    const done = await f.terminal(created.id);
    expect(done.state).toBe("succeeded");
    expect(done.dispatch.state).toBe("response_received");
    expect(f.sends).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.store.records())).not.toContain("private-model-marker");
    expect(JSON.stringify(f.store.records()).length).toBeLessThan(5000);
    expect(() => f.resources.readModel(ref)).toThrowError(
      expect.objectContaining({ code: "resource_not_found" }),
    );
    const first = f.operations.readResult(created.id);
    const second = f.operations.readResult(created.id);
    expect(first.bytes.equals(second.bytes)).toBe(true);
    expect(JSON.parse(first.bytes.toString()).message.content).toBe("exact result 🦉");
    expect(f.operations.inspect(created.id).response.state).toBe("ready");
    expect(f.operations.acknowledge(created.id, first.sha256).response.state).toBe("acknowledged");
    expect(f.operations.acknowledge(created.id, first.sha256).response.state).toBe("acknowledged");
    expect(() => f.operations.readResult(created.id)).toThrowError(
      expect.objectContaining({ status: 410 }),
    );
    expect(f.resources.listModelResources()).toEqual([]);
    expect((await f.operations.create(ref, "large")).id).toBe(created.id);
    expect(f.sends).toHaveBeenCalledTimes(1);
  });

  it("concurrent create and re-uploaded identical bytes retain one accepted invocation", async () => {
    const f = await fixture();
    const first = f.upload();
    const second = f.upload();
    const [a, b] = await Promise.all([
      f.operations.create(first, "same"),
      f.operations.create(second, "same"),
    ]);
    expect(a.id).toBe(b.id);
    await f.terminal(a.id);
    expect(f.sends).toHaveBeenCalledTimes(1);
    expect(f.store.records()).toHaveLength(1);
    expect(() => f.resources.readModel(first)).toThrow();
    expect(() => f.resources.readModel(second)).toThrow();
    const replayRef = f.upload();
    expect((await f.operations.create(replayRef, "same")).id).toBe(a.id);
    expect(() => f.resources.readModel(replayRef)).toThrow();
    await expect(f.operations.create(f.upload(request("different")), "same")).rejects.toMatchObject(
      { code: "idempotency_conflict" },
    );
  });

  it("does not report model jobs as Agent Runs while normal capacity sees them", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await fixture(async (_input, ctx) => {
      await ctx.onDispatch(route);
      await gate;
      return result();
    });
    const first = await f.operations.create(f.upload(), "first");
    const secondRef = f.upload(request("second"));
    const second = await f.operations.create(secondRef, "second");
    expect(await f.client.list()).toEqual([]);
    expect(f.operations.inspect(first.id).state).toBe("running");
    expect(f.operations.inspect(second.id).state).toBe("queued");
    const cancelled = await f.operations.cancel(second.id, "user_cancelled");
    expect(cancelled.state).toBe("cancelled");
    expect(cancelled.dispatch.state).toBe("not_started");
    expect(() => f.resources.readModel(secondRef)).toThrow();
    release();
    await f.terminal(first.id);
    expect((await f.operations.cancel(first.id)).state).toBe("succeeded");
  });

  it("keeps model idempotency after history cap/age and result acknowledgement", async () => {
    const f = await fixture(undefined, { maxHistory: 1, idempotencyRetentionMs: 0 });
    const first = await f.operations.create(f.upload(), "retained-first");
    await f.terminal(first.id);
    f.operations.acknowledge(first.id, f.operations.readResult(first.id).sha256);
    const second = await f.operations.create(f.upload(request("other")), "retained-second");
    await f.terminal(second.id);
    expect(f.store.records()).toHaveLength(2);
    expect((await f.operations.create(f.upload(), "retained-first")).id).toBe(first.id);
    expect(f.operations.inspect(first.id).response.state).toBe("acknowledged");
    expect(f.sends).toHaveBeenCalledTimes(2);
  });

  it("does not report a provider response when the durable dispatch write fails", async () => {
    const sends = vi.fn();
    const f = await fixture(async (_request, ctx) => {
      try {
        await ctx.onDispatch(route);
        sends();
        return result();
      } catch {
        return { ...result(), outcome: "failed", message: null };
      }
    });
    const update = f.store.update.bind(f.store);
    vi.spyOn(f.store, "update").mockImplementation((id, patch) => {
      if ((patch.result as { dispatch?: { state?: string } })?.dispatch?.state === "started")
        throw new Error("fixture journal write failed");
      return update(id, patch);
    });
    const created = await f.operations.create(f.upload(), "dispatch-write-failed");
    const done = await f.terminal(created.id);
    expect(done.state).toBe("failed");
    expect(done.dispatch.state).toBe("not_started");
    expect(sends).not.toHaveBeenCalled();
  });

  it("marks an interrupted physical send unknown rather than never-sent or free", async () => {
    const f = await fixture(async (_input, context) => {
      await context.onDispatch(route);
      throw new Error("upstream disappeared");
    });
    const created = await f.operations.create(f.upload(), "torn");
    const done = await f.terminal(created.id);
    expect(done.state).toBe("interrupted");
    expect(done.dispatch.state).toBe("unknown");
    expect(done.cost).toBeNull();
    expect(done.usage.input_tokens).toBeNull();
    expect(
      (
        await f.operations.create(
          ModelOperationParams.parse(f.store.get(created.id)!.params).request,
          "torn",
        )
      ).id,
    ).toBe(created.id);
  });

  it("refuses malformed UTF-8 and ordinary attachment refs before admission", async () => {
    const f = await fixture();
    const bytes = Buffer.concat([
      Buffer.from('{"source":"'),
      Buffer.from([255]),
      Buffer.from('"}'),
    ]);
    await expect(
      f.operations.create(f.resources.publishModel(bytes), "utf8"),
    ).rejects.toMatchObject({
      code: "model_request_invalid",
      status: 400,
      retryable: false,
    });
    const upload = f.resources.create(
      { kind: "file", mime: "application/json", sizeBytes: 2 },
      "ordinary",
    );
    await f.resources.write(
      upload.uploadId,
      (async function* () {
        yield Buffer.from("{}");
      })(),
    );
    const ordinary = f.resources.finalize(upload.uploadId, undefined, "ordinary-final");
    await expect(
      f.operations.create(
        { resourceId: ordinary.resourceId, sha256: ordinary.sha256, sizeBytes: ordinary.sizeBytes },
        "ordinary-op",
      ),
    ).rejects.toMatchObject({ code: "resource_purpose_mismatch" });
    expect(f.store.records()).toEqual([]);
    expect(f.sends).not.toHaveBeenCalled();
  });

  it.each([
    "{broken",
    JSON.stringify({
      ...request(),
      messages: [{ role: "assistant", content: "private", stop_reason: "end_turn" }],
    }),
  ])("rejects invalid request bytes before command acceptance", async (body) => {
    const f = await fixture();
    const ref = f.resources.publishModel(Buffer.from(body));
    for (let repeat = 0; repeat < 2; repeat++) {
      await expect(f.operations.create(ref, "invalid-request")).rejects.toMatchObject({
        code: "model_request_invalid",
        status: 400,
        retryable: false,
      });
    }
    expect(f.store.records()).toEqual([]);
    expect(f.sends).not.toHaveBeenCalled();
  });

  it("preserves resource I/O failure instead of granting invalid-request authority", async () => {
    const f = await fixture();
    const ref = f.upload();
    const failure = Object.assign(new Error("resource unavailable"), { code: "EIO" });
    vi.spyOn(f.resources, "readModel").mockImplementation(() => {
      throw failure;
    });
    await expect(f.operations.create(ref, "io-error")).rejects.toBe(failure);
    expect(f.store.records()).toEqual([]);
    expect(f.sends).not.toHaveBeenCalled();
  });

  it("replays accepted authority before validating an already released replacement upload", async () => {
    const f = await fixture();
    const created = await f.operations.create(f.upload(), "accepted-before-validation");
    await f.terminal(created.id);
    f.operations.acknowledge(created.id, f.operations.readResult(created.id).sha256);
    const replacement = f.upload();
    f.resources.releaseModel(replacement);
    const read = vi.spyOn(f.resources, "readModel");
    const replay = await f.operations.create(replacement, "accepted-before-validation");
    expect(replay.id).toBe(created.id);
    expect(replay.response.state).toBe("acknowledged");
    expect(read).not.toHaveBeenCalled();
    expect(f.store.records()).toHaveLength(1);
    expect(f.sends).toHaveBeenCalledTimes(1);
  });

  it("a malformed raw model command cannot poison another operation's cleanup", async () => {
    const f = await fixture();
    f.store.accept({
      id: "malformed",
      params: { kind: "model" },
      idempotencyKey: "malformed",
      clientId: "fixture",
    });
    const created = await f.operations.create(f.upload(), "valid-after-malformed");
    await f.terminal(created.id);
    f.store.update("malformed", { state: "failed" });
    expect(f.operations.reconcileResources().errors).toEqual([]);
  });

  it("a wrong ACK cannot release content; expiry is 30 days from ready, with dry-run cleanup", async () => {
    const f = await fixture();
    const created = await f.operations.create(f.upload(), "expiry");
    const done = await f.terminal(created.id);
    if (done.response.state !== "ready") throw new Error("expected ready result");
    const ready = done.response;
    expect(Date.parse(ready.expiresAt) - Date.parse(ready.readyAt)).toBe(30 * 24 * 60 * 60 * 1000);
    expect(() => f.operations.acknowledge(created.id, `sha256:${"0".repeat(64)}`)).toThrowError(
      expect.objectContaining({ code: "model_result_digest_mismatch" }),
    );
    f.setNow(new Date(Date.parse(ready.expiresAt) - 1));
    expect(f.operations.readResult(created.id).sha256).toBe(ready.ref.sha256);
    f.setNow(new Date(ready.expiresAt));
    expect(f.operations.inspect(created.id).response.state).toBe("expired");
    expect(() => f.operations.readResult(created.id)).toThrowError(
      expect.objectContaining({ status: 410 }),
    );
    expect(f.operations.reconcileResources(true).released).toContain(ready.ref.resourceId);
    expect(f.resources.readModel(ready.ref).length).toBeGreaterThan(0);
    expect(f.operations.reconcileResources().errors).toEqual([]);
    expect(() => f.resources.readModel(ready.ref)).toThrow();
    expect(f.operations.inspect(created.id).response.state).toBe("expired");
  });

  it("retains an input shared with another live command until both settle", async () => {
    let release!: () => void;
    let count = 0;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await fixture(async (_input, context) => {
      await context.onDispatch(route);
      if (++count === 1) await gate;
      return result();
    });
    const ref = f.upload();
    const first = await f.operations.create(ref, "shared-first");
    const second = await f.operations.create(ref, "shared-second");
    release();
    await f.terminal(first.id);
    await f.terminal(second.id);
    expect(count).toBe(2);
    expect(() => f.resources.readModel(ref)).toThrow();
  });

  it("a redundant replay preserves a different command's live input resource", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await fixture(async (_input, context) => {
      await context.onDispatch(route);
      await gate;
      return result();
    });
    const first = await f.operations.create(f.upload(), "shared-copy-first");
    const secondRef = f.upload();
    const second = await f.operations.create(secondRef, "shared-copy-second");
    expect((await f.operations.create(secondRef, "shared-copy-first")).id).toBe(first.id);
    expect(f.resources.readModel(secondRef).length).toBeGreaterThan(0);
    release();
    await f.terminal(first.id);
    await f.terminal(second.id);
    expect(() => f.resources.readModel(secondRef)).toThrow();
  });
});

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DurableJournal } from "@claudexor/journal";
import {
  CommandStore,
  CredentialUnusableLedger,
  DaemonClient,
  DaemonServer,
  QuotaRegistry,
  ResourceStore,
} from "@claudexor/daemon";
import { createCodexAdapter } from "@claudexor/harness-codex";
import {
  ControlGcReceipt,
  ControlProblem,
  CredentialProfile,
  GlobalConfig,
  ModelCallRequest,
  ModelCallResult,
  QuotaAbsence,
  isModelOperation,
  type CredentialProfileStatus,
  type ModelCatalogEntry,
} from "@claudexor/schema";
import type { ModelAdapter } from "@claudexor/core";
import { createModelServices } from "./model-services.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanups.splice(0).reverse()) await dispose();
});

function model(id = "test-model"): ModelCatalogEntry {
  return {
    id,
    label: null,
    isDefault: true,
    contextWindow: 272000,
    maxContextWindow: 872000,
    maxOutputTokens: null,
    inputModalities: ["text"],
    reasoningEfforts: ["medium"],
    defaultReasoningEffort: "medium",
    supportedOptions: [],
  };
}

async function fixture(options: { lazy?: boolean } = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "cx-ms-")));
  const journal = new DurableJournal({ rootDir: join(root, "journal"), partition: "global" });
  const store = new CommandStore(journal);
  const commands = { current: () => store };
  const quota = new QuotaRegistry(journal);
  const unusable = new CredentialUnusableLedger();
  let resourceStore: ResourceStore | undefined;
  const resources = vi.fn(() => (resourceStore ??= new ResourceStore(join(root, "resources"))));
  const profiles = ["a", "b"].map((id) =>
    CredentialProfile.parse({
      profile_id: id,
      harness_id: "codex",
      display_name: id,
      credential_kind: "config_dir_login",
      isolation_locator: join(root, id),
    }),
  );
  const cfg = GlobalConfig.parse({ credential_profiles: profiles });
  const catalogModels: Record<string, ModelCatalogEntry[]> = { a: [model()], b: [model()] };
  const failures: Record<string, string> = {};
  const probe = vi.fn<(profile: CredentialProfile) => Promise<CredentialProfileStatus>>(
    async (profile) => ({
      profile_id: profile.profile_id,
      harness_id: profile.harness_id,
      availability: "available" as const,
      verification: "passed" as const,
      verification_source: "local_store" as const,
      detail: "test profile ready",
      last_verified_at: null,
    }),
  );
  const catalog = vi.fn<ModelAdapter["catalog"]>(async ({ profile }) => ({
    source: "codex",
    credentialProfileId: profile.profile_id,
    accountFingerprint: profile.profile_id,
    observedAt: new Date().toISOString(),
    provenance: "fixture exact catalog",
    models: catalogModels[profile.profile_id]!,
  }));
  const invoke = vi.fn<ModelAdapter["invoke"]>(async (request, context) => {
    expect(context.catalog).toMatchObject({
      source: "codex",
      credentialProfileId: context.profile.profile_id,
      accountFingerprint: context.profile.profile_id,
    });
    const route = {
      source: "codex",
      credentialProfileId: context.profile.profile_id,
      accountFingerprint: context.profile.profile_id,
      model: request.model,
    };
    await context.onDispatch(route);
    const code = failures[context.profile.profile_id];
    return ModelCallResult.parse({
      outcome: code ? "failed" : "completed",
      message: code ? null : { role: "assistant", content: "own model reply" },
      route,
      usage: code ? {} : { input_tokens: 5, output_tokens: 3 },
      cost: {
        knowledge: "unknown",
        billing: "unknown",
        source: "fixture",
        provenance: ["fixture"],
      },
      appliedOptions: {},
      problem: code
        ? {
            code,
            message: "fixture refusal",
            retryable: false,
            context: { resetsAt: new Date(Date.now() + 60000).toISOString() },
          }
        : null,
    });
  });
  const socket =
    process.platform === "win32" ? `\\\\.\\pipe\\cx-ms-${randomUUID()}` : join(root, "daemon.sock");
  const client = new DaemonClient(socket, "fixture-control");
  const services = createModelServices({
    commands,
    resources,
    client,
    quota: () => quota,
    config: () => cfg,
    unusable,
    migrationGate: () => null,
    registry: new Map([["codex", { ...createCodexAdapter(), probeCredentialProfile: probe }]]),
    sources: [
      { adapter: { id: "codex", catalog, invoke }, label: "Codex", credentialHarness: "codex" },
    ],
  });
  const agentRunner = vi.fn(async () => ({ lifecycle: "succeeded" }));
  const server = new DaemonServer({
    socketPath: socket,
    token: "fixture-control",
    commands,
    runner: (params, context) =>
      isModelOperation(params) ? services.operations.execute(params, context) : agentRunner(),
    onCommandTerminal: (record) => services.operations.onCommandTerminal(record),
  });
  if (!options.lazy) await server.start();
  cleanups.push(async () => {
    services.close();
    await server.stop();
    journal.close();
    rmSync(root, { recursive: true, force: true });
  });
  const run = async (account: ModelCallRequest["account"] = { mode: "auto" }) => {
    const ref = resources().publishModel(
      Buffer.from(
        JSON.stringify(
          ModelCallRequest.parse({
            source: "codex",
            model: "test-model",
            account,
            messages: [{ role: "system", content: "own prompt" }],
          }),
        ),
      ),
    );
    const started = await services.routes.createModelOperation(ref, randomUUID());
    await vi.waitFor(async () =>
      expect(["queued", "running"]).not.toContain(
        (await services.routes.getModelOperation(started.id)).state,
      ),
    );
    return services.routes.getModelOperation(started.id);
  };
  return {
    root,
    services,
    resources,
    profiles,
    cfg,
    catalogModels,
    failures,
    catalog,
    invoke,
    probe,
    quota,
    unusable,
    client,
    agentRunner,
    run,
  };
}

describe("production model service composition", () => {
  it("constructs without creating the ResourceStore or probing accounts in recovery", async () => {
    const f = await fixture({ lazy: true });
    expect(f.resources).not.toHaveBeenCalled();
    expect(f.probe).not.toHaveBeenCalled();
    expect(await f.services.routes.modelSources()).toEqual({
      sources: [{ id: "codex", label: "Codex", credentialHarness: "codex" }],
    });
    expect(f.resources).not.toHaveBeenCalled();
    await expect(f.services.routes.modelCatalog("claude")).rejects.toMatchObject({
      code: "model_source_unavailable",
    });
  });

  it("catalog omission uses Auto and pin reads only its exact account, without a union", async () => {
    const f = await fixture();
    f.catalogModels.a = [model("only-a")];
    f.catalogModels.b = [model("only-b")];
    expect((await f.services.routes.modelCatalog("codex")).credentialProfileId).toBe("a");
    const catalog = await f.services.routes.modelCatalog("codex", "b");
    expect(catalog.models.map((entry) => entry.id)).toEqual(["only-b"]);
    expect(catalog.models[0]?.maxContextWindow).toBe(872000);
    await expect(f.services.routes.modelCatalog("codex", "absent")).rejects.toMatchObject({
      code: "model_account_unavailable",
    });
    f.profiles[1]!.enabled = false;
    f.cfg.credential_profiles[1]!.enabled = false;
    await expect(f.services.routes.modelCatalog("codex", "b")).rejects.toMatchObject({
      code: "model_account_unavailable",
    });
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it("model-aware Auto discovery finds a recovered compatible account without borrowing capacity", async () => {
    const f = await fixture();
    f.catalogModels.a = [model("only-a")];
    f.catalogModels.b = [{ ...model("test-model"), maxContextWindow: 500000 }];
    expect((await f.services.routes.modelCatalog("codex")).credentialProfileId).toBe("a");
    f.catalog.mockClear();
    const catalog = await f.services.routes.modelCatalog("codex", undefined, "test-model");
    expect(f.catalog.mock.calls.map(([input]) => input.profile.profile_id)).toEqual(["a", "b"]);
    expect(catalog.credentialProfileId).toBe("b");
    expect(catalog.accountFingerprint).toBe("b");
    expect(catalog.models).toEqual(f.catalogModels.b);
    await expect(f.services.routes.modelCatalog("codex", "a", "test-model")).rejects.toMatchObject({
      code: "model_unavailable",
    });
    expect(f.invoke).not.toHaveBeenCalled();
    expect(f.resources).not.toHaveBeenCalled();
  });

  it("keeps a usable preferred account and dispatches model commands before Agent normalization", async () => {
    const f = await fixture();
    const done = await f.run({ mode: "auto", preferredProfileId: "b" });
    expect(done.state).toBe("succeeded");
    expect(done.dispatch.route?.credentialProfileId).toBe("b");
    expect(f.agentRunner).not.toHaveBeenCalled();
    expect(await f.client.list()).toEqual([]);
    expect(f.invoke).toHaveBeenCalledTimes(1);
    const read = await f.services.routes.readModelResult(done.id);
    expect(JSON.parse(read.bytes.toString()).message.content).toBe("own model reply");
    expect((await f.services.routes.getModelOperation(done.id)).response.state).toBe("ready");
    await f.services.routes.acknowledgeModelResult(done.id, read.sha256);
    expect(f.resources().listModelResources()).toEqual([]);
  });

  it("uses the same resolver to skip a preferred account lacking this model before any inference", async () => {
    const f = await fixture();
    f.catalogModels.b = [model("different")];
    const done = await f.run({ mode: "auto", preferredProfileId: "b" });
    expect(done.dispatch.route?.credentialProfileId).toBe("a");
    expect(f.catalog.mock.calls.map(([context]) => context.profile.profile_id)).toEqual(["b", "a"]);
    expect(f.invoke).toHaveBeenCalledTimes(1);
    const pinned = await f.run({ mode: "pin", profileId: "b" });
    expect(pinned.problem?.code).toBe("model_unavailable");
    expect(pinned.dispatch.state).toBe("not_started");
    f.catalogModels.a = [];
    const unsupported = await f.run();
    expect(unsupported.problem?.code).toBe("model_unavailable");
    expect(f.invoke).toHaveBeenCalledTimes(1);
  });

  it("records confirmed quota in the shared registry; the next Auto operation rotates but pin refuses", async () => {
    const f = await fixture();
    f.failures.a = "subscription_window_exhausted";
    const first = await f.run({ mode: "auto", preferredProfileId: "a" });
    expect(first.problem?.code).toBe("subscription_window_exhausted");
    expect(f.quota.read().snapshots[0]?.subject.subject_id).toBe("a");
    const next = await f.run({ mode: "auto", preferredProfileId: "a" });
    expect(next.dispatch.route?.credentialProfileId).toBe("b");
    const pinned = await f.run({ mode: "pin", profileId: "a" });
    expect(pinned.problem?.code).toBe("subscription_window_exhausted");
    expect(pinned.dispatch.state).toBe("not_started");
    expect(f.invoke).toHaveBeenCalledTimes(2);
  });

  it("types an all-quota pool before catalog polling or another generation", async () => {
    const f = await fixture();
    f.failures.a = f.failures.b = "subscription_window_exhausted";
    await f.run({ mode: "pin", profileId: "a" });
    await f.run({ mode: "pin", profileId: "b" });
    const done = await f.run();
    expect(done.problem).toMatchObject({
      code: "subscription_window_exhausted",
      context: { poolCause: "quota", resetsAt: expect.any(String) },
    });
    expect(done.dispatch.state).toBe("not_started");
    await expect(f.services.routes.modelCatalog("codex")).rejects.toMatchObject({
      problem: { code: "subscription_window_exhausted", context: { poolCause: "quota" } },
    });
    expect(f.invoke).toHaveBeenCalledTimes(2);
    expect(f.catalog).toHaveBeenCalledTimes(2);
  });

  it.each(["empty", "disabled"])(
    "keeps an %s pool unavailable instead of inventing quota or logout",
    async (kind) => {
      const f = await fixture();
      if (kind === "empty") f.cfg.credential_profiles = [];
      else
        f.cfg.credential_profiles.forEach((profile) => {
          profile.enabled = false;
        });
      const done = await f.run();
      expect(done.problem).toMatchObject({
        code: "credential_pool_exhausted",
        context: { poolCause: "unavailable", resetsAt: null },
      });
      expect(f.invoke).not.toHaveBeenCalled();
      expect(f.catalog).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["auth_required", "auth_required", "auth_required", "auth"],
    ["auth_required", "subscription_window_exhausted", "credential_pool_exhausted", "mixed"],
  ])("preserves the proved pool causes %s + %s", async (a, b, expectedCode, poolCause) => {
    const f = await fixture();
    f.failures.a = a;
    f.failures.b = b;
    await f.run({ mode: "pin", profileId: "a" });
    await f.run({ mode: "pin", profileId: "b" });
    const done = await f.run();
    expect(done.problem).toMatchObject({ code: expectedCode, context: { poolCause } });
    expect(done.dispatch.state).toBe("not_started");
    expect(f.invoke).toHaveBeenCalledTimes(2);
  });

  it("does not let a final catalog refusal relabel a mixed pool as all-auth or all-quota", async () => {
    const f = await fixture();
    f.catalog.mockImplementation(async (context) => {
      throw Object.assign(new Error("catalog refusal"), {
        problem: ControlProblem.parse({
          code:
            context.profile.profile_id === "a" ? "auth_required" : "subscription_window_exhausted",
          message: "catalog refusal",
          retryable: false,
        }),
      });
    });
    const done = await f.run();
    expect(done.problem).toMatchObject({
      code: "credential_pool_exhausted",
      context: { poolCause: "mixed" },
    });
    expect(f.catalog).toHaveBeenCalledTimes(2);
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it("preserves existing vendor-poller auth proof for Auto and pin without another probe generation", async () => {
    const f = await fixture();
    const read = f.quota.read.bind(f.quota);
    vi.spyOn(f.quota, "read").mockImplementation(() => ({
      ...read(),
      absences: f.profiles.map((profile) =>
        QuotaAbsence.parse({
          subject: {
            harness: "codex",
            subject_id: profile.profile_id,
            credential_route: "vendor_native",
          },
          reason: "auth_revoked",
          observed_at: new Date().toISOString(),
          detail: "fixture vendor refusal",
        }),
      ),
    }));
    expect((await f.run()).problem).toMatchObject({
      code: "auth_required",
      context: { poolCause: "auth" },
    });
    expect((await f.run({ mode: "pin", profileId: "a" })).problem?.code).toBe("auth_required");
    expect(f.catalog).not.toHaveBeenCalled();
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it("keeps unproven profile failure distinct from a sibling's confirmed auth failure", async () => {
    const f = await fixture();
    f.failures.a = "auth_required";
    await f.run({ mode: "pin", profileId: "a" });
    const original = f.probe.getMockImplementation()!;
    f.probe.mockImplementation(async (profile) =>
      profile.profile_id === "b"
        ? { ...(await original(profile)), availability: "unknown", verification: "not_run" }
        : original(profile),
    );
    const done = await f.run();
    expect(done.problem).toMatchObject({
      code: "credential_pool_exhausted",
      context: { poolCause: "unavailable" },
    });
    expect(f.invoke).toHaveBeenCalledTimes(1);
  });

  it.each(["rate_limited", "auth_refresh_failed"])(
    "does not reinterpret %s as quota exhaustion or logout",
    async (code) => {
      const f = await fixture();
      f.failures.a = code;
      const done = await f.run({ mode: "pin", profileId: "a" });
      expect(done.problem?.code).toBe(code);
      expect(f.quota.read().snapshots).toEqual([]);
      expect(f.unusable.live()).toEqual([]);
    },
  );

  it("shares confirmed auth loss with existing Agent account readiness", async () => {
    const f = await fixture();
    f.failures.a = "auth_required";
    await f.run({ mode: "auto", preferredProfileId: "a" });
    expect(f.unusable.live()[0]).toMatchObject({
      harness_id: "codex",
      profile_id: "a",
      code: "auth_revoked",
    });
    const pinned = await f.run({ mode: "pin", profileId: "a" });
    expect(pinned.problem).toMatchObject({
      code: "auth_required",
      context: { credentialProfileId: "a" },
    });
    expect(pinned.dispatch.state).toBe("not_started");
    expect(f.invoke).toHaveBeenCalledTimes(1);
    expect(
      (await f.run({ mode: "auto", preferredProfileId: "a" })).dispatch.route?.credentialProfileId,
    ).toBe("b");
  });

  it.each(["auth_required", "subscription_window_exhausted"])(
    "rotates a confirmed catalog %s before inference, while preserving strict pin",
    async (code) => {
      const f = await fixture();
      const original = f.catalog.getMockImplementation()!;
      f.catalog.mockImplementation(async (context) => {
        if (context.profile.profile_id === "a")
          throw Object.assign(new Error("catalog refused"), {
            problem: ControlProblem.parse({
              code,
              message: "catalog refused",
              retryable: false,
              context: { resetsAt: new Date(Date.now() + 60000).toISOString() },
            }),
          });
        return original(context);
      });
      const done = await f.run({ mode: "auto", preferredProfileId: "a" });
      expect(done.state).toBe("succeeded");
      expect(done.dispatch.route?.credentialProfileId).toBe("b");
      expect(f.invoke).toHaveBeenCalledTimes(1);
      const g = await fixture();
      g.catalog.mockRejectedValueOnce(
        Object.assign(new Error("catalog refused"), {
          problem: ControlProblem.parse({ code, message: "catalog refused", retryable: false }),
        }),
      );
      const pinned = await g.run({ mode: "pin", profileId: "a" });
      expect(pinned.problem).toMatchObject({
        code,
        context: { source: "codex", credentialProfileId: "a" },
      });
      expect(pinned.dispatch.state).toBe("not_started");
      expect(g.catalog).toHaveBeenCalledTimes(1);
      expect(g.invoke).not.toHaveBeenCalled();
    },
  );

  it("advances to a healthy sibling on a catalog refusal outside the rotation codes", async () => {
    const f = await fixture();
    const original = f.catalog.getMockImplementation()!;
    f.catalog.mockImplementation(async (context) => {
      if (context.profile.profile_id === "a")
        throw Object.assign(new Error("catalog unavailable"), {
          problem: ControlProblem.parse({
            code: "catalog_unavailable",
            message: "catalog unavailable",
            retryable: false,
          }),
        });
      return original(context);
    });
    const done = await f.run({ mode: "auto", preferredProfileId: "a" });
    expect(done.state).toBe("succeeded");
    expect(done.dispatch.route?.credentialProfileId).toBe("b");
    expect(f.catalog).toHaveBeenCalledTimes(2);
    expect(f.invoke).toHaveBeenCalledTimes(1);
  });

  it("keeps an explicit pin strict on a catalog refusal outside the rotation codes", async () => {
    const f = await fixture();
    f.catalog.mockRejectedValueOnce(
      Object.assign(new Error("catalog unavailable"), {
        problem: ControlProblem.parse({
          code: "catalog_unavailable",
          message: "catalog unavailable",
          retryable: false,
        }),
      }),
    );
    const pinned = await f.run({ mode: "pin", profileId: "a" });
    expect(pinned.problem).toMatchObject({
      code: "catalog_unavailable",
      context: { source: "codex", credentialProfileId: "a" },
    });
    expect(pinned.dispatch.state).toBe("not_started");
    expect(f.catalog).toHaveBeenCalledTimes(1);
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it("does not turn local verification failure into a confirmed sign-in requirement", async () => {
    const f = await fixture();
    f.unusable.record({
      harness_id: "codex",
      profile_id: "a",
      code: "verification_failed",
      source: "local_probe",
      model: null,
      detail: "probe failed",
      observed_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60000).toISOString(),
    });
    const result = await f.run({ mode: "pin", profileId: "a" });
    expect(result.state).toBe("failed");
    expect(result.problem?.code).not.toBe("auth_required");
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it("preserves a catalog authentication refusal when every Auto account needs sign-in", async () => {
    const f = await fixture();
    f.catalog.mockRejectedValue(
      Object.assign(new Error("login required"), {
        problem: ControlProblem.parse({
          code: "auth_required",
          message: "login required",
          retryable: false,
        }),
      }),
    );
    const done = await f.run();
    expect(done.problem?.code).toBe("auth_required");
    expect(f.catalog).toHaveBeenCalledTimes(2);
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "bounds catalog quota rejection without reset, even if evidence recording fails (%s)",
    async (brokenEvidence) => {
      const f = await fixture();
      f.catalog.mockRejectedValue(
        Object.assign(new Error("quota refused"), {
          problem: ControlProblem.parse({
            code: "subscription_window_exhausted",
            message: "quota refused",
            retryable: true,
          }),
        }),
      );
      if (brokenEvidence)
        vi.spyOn(f.quota, "ingest").mockImplementation(() => {
          throw new Error("journal unavailable");
        });
      const done = await f.run({ mode: "auto", preferredProfileId: "a" });
      expect(done.problem?.code).toBe("subscription_window_exhausted");
      expect(f.catalog.mock.calls.map(([context]) => context.profile.profile_id)).toEqual([
        "a",
        "b",
      ]);
      expect(f.invoke).not.toHaveBeenCalled();
    },
  );

  it("refuses a catalog for another account and never borrows an API-key row", async () => {
    const f = await fixture();
    const catalog = await f.services.routes.modelCatalog("codex", "b");
    f.catalog.mockResolvedValueOnce(catalog);
    expect((await f.run({ mode: "pin", profileId: "a" })).problem?.code).toBe(
      "model_catalog_identity_mismatch",
    );
    f.cfg.credential_profiles.push(
      CredentialProfile.parse({
        profile_id: "paid",
        harness_id: "codex",
        display_name: "Paid",
        credential_kind: "api_key",
        secret_ref: "openai:paid",
      }),
    );
    expect((await f.run({ mode: "pin", profileId: "paid" })).problem?.code).toBe(
      "model_account_unavailable",
    );
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it("keeps legacy GC receipt shape and exposes model cleanup only on request", async () => {
    const f = await fixture();
    const gc = f.services.withRetention(async (request) =>
      ControlGcReceipt.parse({
        dry_run: request.dry_run,
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        policy: { runs_max_age_days: 30, reviews_max_age_days: 14, keep_last_runs_per_project: 1 },
        examined_runs: 0,
        kept: {},
        freed_bytes: 0,
      }),
    );
    const reconcile = vi
      .spyOn(f.services.operations, "reconcileResources")
      .mockReturnValue({ released: ["model-ref"], errors: ["cleanup pending"] });
    const legacy = await gc({ dry_run: true });
    expect(legacy).not.toHaveProperty("model_payloads");
    expect(legacy.errors).toEqual(["cleanup pending"]);
    const detailed = await gc({ dry_run: false, model_payload_report: true });
    expect(detailed.model_payloads).toEqual({
      released: ["model-ref"],
      errors: ["cleanup pending"],
    });
    expect(reconcile.mock.calls).toEqual([[true], [false]]);
  });

  it("aborts in-flight catalog work when the daemon starts its graceful close", async () => {
    const f = await fixture();
    f.catalog.mockImplementationOnce(
      async ({ signal }) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("catalog cancelled")), {
            once: true,
          });
        }),
    );
    const catalog = f.services.routes.modelCatalog("codex").catch((error: unknown) => error);
    await vi.waitFor(() => expect(f.catalog).toHaveBeenCalled());
    f.services.close();
    expect(await catalog).toMatchObject({ message: "catalog cancelled" });
    expect(f.invoke).not.toHaveBeenCalled();
  });
});

import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CredentialProfile, ModelCallRequest, ModelCallResult } from "@claudexor/schema";
import { createCodexModelAdapter, parseCodexModelCatalog } from "./model.js";

const catalog = {
  models: [
    {
      slug: "model-one",
      display_name: "Model One",
      priority: 1,
      visibility: "list",
      context_window: 272000,
      max_context_window: 872000,
      auto_compact_token_limit: 240000,
      effective_context_window_percent: 95,
      supported_reasoning_levels: [{ effort: "medium" }, { effort: "ultra" }],
      default_reasoning_level: "medium",
      input_modalities: ["text", "image"],
      supports_parallel_tool_calls: true,
    },
  ],
};
const native = {
  type: "function_call",
  id: "fc_one",
  call_id: "call_one",
  name: "probe",
  arguments: '{"ok":true}',
};
function terminal(output: unknown[] = [native]) {
  return new Response(
    `data: ${JSON.stringify({
      type: "response.completed",
      response: {
        model: "model-one",
        output,
        reasoning: { effort: "medium" },
        service_tier: "standard",
        usage: { input_tokens: 10, output_tokens: 4 },
      },
    })}\n\n`,
  );
}

function withHeader(response: Response, turnState: string): Response {
  response.headers.set("x-codex-turn-state", turnState);
  return response;
}
function setup(
  respond: (init: RequestInit | undefined) => Response | Promise<Response> = () => terminal(),
  now: () => number = () => 1900000000000,
) {
  const profile = CredentialProfile.parse({
    profile_id: "work",
    harness_id: "codex",
    display_name: "Work",
    credential_kind: "config_dir_login",
    isolation_locator: join(process.env.CLAUDEXOR_CONFIG_DIR!, "profiles", "work"),
  });
  const onDispatch = vi.fn(async () => {});
  const token = `fixture.${Buffer.from(JSON.stringify({ exp: 2100000000 })).toString("base64url")}.signature`;
  const readAuthFile = vi.fn(async () =>
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        account_id: "account-one",
        access_token: token,
        refresh_token: "do-not-export",
        id_token: `fixture.${Buffer.from('{"sub":"user-one"}').toString("base64url")}.signature`,
      },
    }),
  );
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    if (init?.method === "POST") {
      expect(onDispatch).toHaveBeenCalledTimes(1);
      return respond(init);
    }
    return Response.json(catalog);
  });
  return {
    profile,
    onDispatch,
    readAuthFile,
    fetcher,
    token,
    adapter: createCodexModelAdapter({ fetch: fetcher, readAuthFile, now }),
    context: { profile, onDispatch, signal: new AbortController().signal },
    request: ModelCallRequest.parse({
      source: "codex",
      model: "model-one",
      account: { mode: "pin", profileId: "work" },
      messages: [
        { role: "system", content: "Own SYSTEM and BIBLE" },
        { role: "user", content: "call the harmless probe" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "probe",
            parameters: { type: "object", properties: { ok: { type: "boolean" } } },
          },
        },
      ],
      toolChoice: "required",
      options: { reasoningEffort: "medium" },
    }),
  };
}

describe("exact-profile Codex model catalog", () => {
  it("does not borrow CLI compaction, effective percentages, aliases, or hardcoded defaults", async () => {
    const fixture = setup();
    const result = await fixture.adapter.catalog(fixture.context);
    expect(result).toMatchObject({
      source: "codex",
      credentialProfileId: "work",
      models: [
        {
          id: "model-one",
          isDefault: true,
          contextWindow: 272000,
          maxContextWindow: 872000,
          maxOutputTokens: null,
          reasoningEfforts: ["medium", "ultra"],
          defaultReasoningEffort: "medium",
          inputModalities: ["text", "image"],
        },
      ],
    });
    expect(result.provenance).toBe("provider_http");
    expect(fixture.fetcher.mock.calls[0]?.[0]).toContain("/models?client_version=0.153.3");
    expect(result.accountFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain(fixture.token);
    expect(fixture.onDispatch).not.toHaveBeenCalled();
  });
  it("timestamps completed upstream bodies and performs a new GET for each catalog read", async () => {
    let now = 1900000000000;
    const fixture = setup(undefined, () => now);
    const response = Response.json(catalog);
    vi.spyOn(response, "json").mockImplementation(async () => {
      now += 1000;
      return catalog;
    });
    fixture.fetcher.mockResolvedValueOnce(response);
    const first = await fixture.adapter.catalog(fixture.context);
    expect(first).toMatchObject({
      provenance: "provider_http",
      observedAt: new Date(now).toISOString(),
    });
    expect(now).toBe(1900000001000);
    now += 1000;
    const second = await fixture.adapter.catalog(fixture.context);
    expect(second.provenance).toBe("provider_http");
    expect(Date.parse(second.observedAt)).toBeGreaterThan(Date.parse(first.observedAt));
    expect(fixture.fetcher).toHaveBeenCalledTimes(2);
    expect(fixture.fetcher.mock.calls.every(([, init]) => init?.method !== "POST")).toBe(true);
    expect(fixture.onDispatch).not.toHaveBeenCalled();
  });
  it("derives the default from vendor priority and picker visibility, not the first row", () => {
    const result = parseCodexModelCatalog({
      models: [
        { slug: "late", priority: 2, visibility: "list" },
        { slug: "hidden", priority: 0, visibility: "hide" },
        { slug: "recommended", priority: 1, visibility: "list" },
      ],
    });
    expect(result.map((entry) => [entry.id, entry.isDefault])).toEqual([
      ["hidden", false],
      ["recommended", true],
      ["late", false],
    ]);
    expect(
      parseCodexModelCatalog({ models: [{ slug: "unknown", context_window: null }] })[0],
    ).toMatchObject({ isDefault: false, contextWindow: null, maxContextWindow: null });
  });
  it("uses the vendor fallback when all entries are hidden, but not if metadata is incomplete", () => {
    expect(
      parseCodexModelCatalog({
        models: [
          { slug: "two", priority: 2, visibility: "hide" },
          { slug: "one", priority: 1, visibility: "none" },
        ],
      })
        .filter((entry) => entry.isDefault)
        .map((entry) => entry.id),
    ).toEqual(["one"]);
    expect(
      parseCodexModelCatalog({
        models: [{ slug: "one", priority: 1, visibility: "list" }, { slug: "unknown" }],
      }).some((entry) => entry.isDefault),
    ).toBe(false);
  });
  it.each(["network", "http", "json", "catalog"])(
    "does not reuse earlier HTTP proof after a %s failure",
    async (failure) => {
      const fixture = setup();
      expect((await fixture.adapter.catalog(fixture.context)).provenance).toBe("provider_http");
      if (failure === "network") fixture.fetcher.mockRejectedValueOnce(new Error("offline"));
      else
        fixture.fetcher.mockResolvedValueOnce(
          failure === "http"
            ? new Response("broken", { status: 502 })
            : failure === "json"
              ? new Response("unreadable catalog")
              : Response.json({ models: [{ missingSlug: true }] }),
        );
      await expect(fixture.adapter.catalog(fixture.context)).rejects.toMatchObject({
        problem: { code: "catalog_unavailable" },
      });
      expect(fixture.fetcher).toHaveBeenCalledTimes(2);
      expect(fixture.onDispatch).not.toHaveBeenCalled();
    },
  );
  it("applies the same freshness rule to catalog 401 as to inference 401", async () => {
    const fixture = setup();
    fixture.readAuthFile.mockResolvedValue(
      JSON.stringify({ tokens: { access_token: "opaque-token", account_id: "account-one" } }),
    );
    fixture.fetcher.mockResolvedValue(Response.json({}, { status: 401 }));
    await expect(fixture.adapter.catalog(fixture.context)).rejects.toMatchObject({
      problem: { code: "auth_refresh_failed" },
    });
    expect(fixture.onDispatch).not.toHaveBeenCalled();
  });
});

describe("single-generation Codex adapter", () => {
  it("omits transport state for legacy clients even when the server reports it", async () => {
    const fixture = setup(() => withHeader(terminal(), "first-token"));
    const result = await fixture.adapter.invoke(fixture.request, fixture.context);
    expect(result).not.toHaveProperty("nativeContinuation");
    expect(result.message?.nativeContinuation?.format).toBe("codex.responses.v1");
    expect(ModelCallResult.parse(result)).not.toHaveProperty("nativeContinuation");
  });
  it("captures the first header, replays it across explicit tool/steering calls, and resets on a new caller turn", async () => {
    const fixture = setup(() => withHeader(terminal(), "first-token"));
    const request = {
      ...fixture.request,
      nativeContinuation: null,
      options: { cacheKey: "one-owner" },
    };
    const first = await fixture.adapter.invoke(request, fixture.context);
    expect(first.nativeContinuation).toEqual({
      route: first.route,
      format: "codex.turn.v1",
      payload: { turnState: "first-token" },
    });
    const next = {
      ...request,
      nativeContinuation: first.nativeContinuation,
      messages: [
        ...request.messages,
        first.message!,
        {
          role: "tool" as const,
          tool_call_id: "call_one",
          content: [
            { type: "text", text: "tool evidence" },
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,aGVsbG8=", detail: "original" },
            },
          ],
        },
        { role: "user" as const, content: "steering inside this turn" },
      ],
    };
    const before = structuredClone(next);
    fixture.onDispatch.mockClear();
    fixture.fetcher.mockImplementation(async (_url, init) =>
      init?.method === "POST" ? withHeader(terminal(), "later-token") : Response.json(catalog),
    );
    const second = await fixture.adapter.invoke(next, fixture.context);
    expect(second.nativeContinuation).toEqual(first.nativeContinuation);
    expect(next).toEqual(before);
    const sends = fixture.fetcher.mock.calls.filter(([, init]) => init?.method === "POST");
    const sent = sends[1][1]!;
    expect(new Headers(sent.headers).get("x-codex-turn-state")).toBe("first-token");
    expect(new Headers(sent.headers).get("session_id")).toBe("one-owner");
    expect(JSON.parse(sent.body as string)).toMatchObject({
      prompt_cache_key: "one-owner",
      input: expect.arrayContaining([
        native,
        {
          type: "function_call_output",
          call_id: "call_one",
          output: [
            { type: "input_text", text: "tool evidence" },
            {
              type: "input_image",
              image_url: "data:image/png;base64,aGVsbG8=",
              detail: "original",
            },
          ],
        },
      ]),
    });
    expect(sent.body).not.toContain("first-token");
    fixture.onDispatch.mockClear();
    const fresh = await fixture.adapter.invoke(
      { ...next, nativeContinuation: null },
      fixture.context,
    );
    expect(fresh.nativeContinuation?.payload).toEqual({ turnState: "later-token" });
    const last = fixture.fetcher.mock.calls
      .filter(([, init]) => init?.method === "POST")
      .at(-1)![1]!;
    expect(new Headers(last.headers).has("x-codex-turn-state")).toBe(false);
  });
  it.each(["source", "credentialProfileId", "accountFingerprint", "model"] as const)(
    "starts empty when the supplied transport route changes %s without refusing generation",
    async (field) => {
      const fixture = setup(() => withHeader(terminal(), "new-token"));
      const first = await fixture.adapter.invoke(
        { ...fixture.request, nativeContinuation: null },
        fixture.context,
      );
      fixture.onDispatch.mockClear();
      const old = first.nativeContinuation!;
      const result = await fixture.adapter.invoke(
        {
          ...fixture.request,
          nativeContinuation: { ...old, route: { ...old.route, [field]: "other" } },
        },
        fixture.context,
      );
      expect(result.outcome).toBe("completed");
      const last = fixture.fetcher.mock.calls.at(-1)![1]!;
      expect(new Headers(last.headers).has("x-codex-turn-state")).toBe(false);
      expect(result.nativeContinuation?.route).toEqual(result.route);
    },
  );
  it("cannot replay uncertain account identity", async () => {
    const fixture = setup(() => withHeader(terminal(), "token"));
    fixture.readAuthFile.mockResolvedValue(
      JSON.stringify({ tokens: { access_token: "opaque", account_id: "account-one" } }),
    );
    const first = await fixture.adapter.invoke(
      { ...fixture.request, nativeContinuation: null },
      fixture.context,
    );
    expect(first.nativeContinuation?.route.accountFingerprint).toBeNull();
    fixture.onDispatch.mockClear();
    const second = await fixture.adapter.invoke(
      { ...fixture.request, nativeContinuation: first.nativeContinuation },
      fixture.context,
    );
    expect(second.outcome).toBe("completed");
    expect(
      new Headers(fixture.fetcher.mock.calls.at(-1)![1]!.headers).has("x-codex-turn-state"),
    ).toBe(false);
  });
  it.each(["\nforeign", "\rforeign", "ключ", " token ", ""])(
    "refuses invalid explicit turn state before dispatch: %j",
    async (turnState) => {
      const fixture = setup();
      const discovered = await fixture.adapter.catalog(fixture.context);
      const result = await fixture.adapter.invoke(
        {
          ...fixture.request,
          nativeContinuation: {
            route: { ...discovered, model: "model-one" },
            format: "codex.turn.v1",
            payload: { turnState },
          },
        },
        fixture.context,
      );
      expect(result.problem?.code).toBe("invalid_continuation");
      expect(fixture.onDispatch).not.toHaveBeenCalled();
      expect(fixture.fetcher.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    },
  );
  it.each([{}, { turnState: 2 }, ["token"]])(
    "refuses malformed turn payload %j",
    async (payload) => {
      const fixture = setup();
      const result = await fixture.adapter.invoke(
        {
          ...fixture.request,
          nativeContinuation: {
            route: {
              source: "codex",
              credentialProfileId: "work",
              accountFingerprint: null,
              model: "model-one",
            },
            format: "codex.turn.v1",
            payload,
          },
        },
        fixture.context,
      );
      expect(result.problem?.code).toBe("invalid_continuation");
      expect(fixture.onDispatch).not.toHaveBeenCalled();
    },
  );
  it.each([new Response("data: {broken}\n\n"), new Response(null)])(
    "preserves a successful header through an unknown body without a second generation",
    async (response) => {
      const fixture = setup(() => withHeader(response, "captured-before-body"));
      const result = await fixture.adapter.invoke(
        { ...fixture.request, nativeContinuation: null },
        fixture.context,
      );
      expect(result.outcome).toBe("unknown");
      expect(result.nativeContinuation?.payload).toEqual({ turnState: "captured-before-body" });
      expect(fixture.fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(
        1,
      );
      expect(ModelCallResult.safeParse(result).success).toBe(true);
    },
  );
  it("leaves an opted-in turn empty when the provider sends no header", async () => {
    const fixture = setup();
    const result = await fixture.adapter.invoke(
      { ...fixture.request, nativeContinuation: null },
      fixture.context,
    );
    expect(result.nativeContinuation).toBeNull();
  });
  it("reuses this operation's exact catalog after a fresh auth read, without another GET", async () => {
    let now = 1900000000000;
    const fixture = setup(undefined, () => now);
    const catalog = await fixture.adapter.catalog(fixture.context);
    const original = structuredClone(catalog);
    now += 1000;
    const result = await fixture.adapter.invoke(fixture.request, { ...fixture.context, catalog });
    expect(result.outcome).toBe("completed");
    expect(fixture.readAuthFile).toHaveBeenCalledTimes(2);
    expect(fixture.fetcher).toHaveBeenCalledTimes(2);
    expect(fixture.fetcher.mock.calls.filter(([, init]) => init?.method !== "POST")).toHaveLength(
      1,
    );
    expect(catalog).toEqual(original);
    expect(Date.parse(catalog.observedAt)).toBeLessThan(now);
  });
  it.each(["accountFingerprint", "credentialProfileId", "source"] as const)(
    "refuses an operation-local catalog with changed %s before generation",
    async (field) => {
      const fixture = setup();
      const catalog = await fixture.adapter.catalog(fixture.context);
      const result = await fixture.adapter.invoke(fixture.request, {
        ...fixture.context,
        catalog: { ...catalog, [field]: "another" },
      });
      expect(result.problem?.code).toBe("auth_changed");
      expect(fixture.onDispatch).not.toHaveBeenCalled();
      expect(fixture.fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it("unknown fingerprints preserve first-call capability without reusing uncertain catalog identity", async () => {
    const fixture = setup();
    fixture.readAuthFile.mockResolvedValue(
      JSON.stringify({
        tokens: {
          access_token: "opaque-token",
          account_id: "account-one",
        },
      }),
    );
    const catalog = await fixture.adapter.catalog(fixture.context);
    expect(catalog.accountFingerprint).toBeNull();
    expect(
      (await fixture.adapter.invoke(fixture.request, { ...fixture.context, catalog })).outcome,
    ).toBe("completed");
    expect(fixture.fetcher).toHaveBeenCalledTimes(3);
  });
  it("dispatches exactly one POST with honest identity and returns native tools", async () => {
    const fixture = setup();
    const originalRequest = structuredClone(fixture.request);
    const result = await fixture.adapter.invoke(fixture.request, fixture.context);
    expect(ModelCallResult.safeParse(result).success).toBe(true);
    expect(fixture.request).toEqual(originalRequest);
    expect(result).toMatchObject({
      outcome: "completed",
      route: { source: "codex", credentialProfileId: "work", model: "model-one" },
      message: {
        tool_calls: [{ id: "call_one", function: { name: "probe", arguments: '{"ok":true}' } }],
      },
      cost: { cashUsd: null, knowledge: "unknown" },
    });
    expect(fixture.fetcher).toHaveBeenCalledTimes(2);
    const [, init] = fixture.fetcher.mock.calls[1];
    expect(init).toMatchObject({
      method: "POST",
      redirect: "error",
    });
    const sentHeaders = new Headers(init!.headers);
    expect(sentHeaders.get("originator")).toBe("claudexor");
    expect(sentHeaders.get("ChatGPT-Account-ID")).toBe("account-one");
    expect(JSON.parse(init!.body as string)).toMatchObject({
      instructions: "",
      input: expect.arrayContaining([
        {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "Own SYSTEM and BIBLE" }],
        },
      ]),
      model: "model-one",
      tool_choice: "required",
    });
    expect(JSON.stringify(result)).not.toContain(fixture.token);
    expect(JSON.stringify(init!.body)).not.toContain("do-not-export");
  });
  it.each(["thread:one", "café"])(
    "preserves a supported cacheKey %s in header and body",
    async (cacheKey) => {
      const fixture = setup();
      const request = { ...fixture.request, options: { ...fixture.request.options, cacheKey } };
      const result = await fixture.adapter.invoke(request, fixture.context);
      expect(result.outcome).toBe("completed");
      const sends = fixture.fetcher.mock.calls.filter(([, init]) => init?.method === "POST");
      expect(sends).toHaveLength(1);
      expect(new Headers(sends[0][1]!.headers).get("session_id")).toBe(cacheKey);
      expect(JSON.parse(sends[0][1]!.body as string).prompt_cache_key).toBe(cacheKey);
      expect(request.options.cacheKey).toBe(cacheKey);
    },
  );
  it.each(["key\nheader", "key\rheader", "\u043a\u043b\u044e\u0447"])(
    "refuses an unrepresentable cacheKey before dispatch: %j",
    async (cacheKey) => {
      const fixture = setup();
      const request = ModelCallRequest.parse({ ...fixture.request, options: { cacheKey } });
      const result = await fixture.adapter.invoke(request, fixture.context);
      expect(result.outcome).toBe("failed");
      expect(result.problem).toMatchObject({
        code: "unsupported_parameter",
        context: { parameter: "cacheKey" },
      });
      expect(fixture.onDispatch).not.toHaveBeenCalled();
      expect(fixture.fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toEqual([]);
      expect(JSON.stringify(result)).not.toContain(cacheKey);
      expect(request.options.cacheKey).toBe(cacheKey);
    },
  );
  it("continues with exact native items and tool result in a second explicit operation", async () => {
    const fixture = setup();
    const first = await fixture.adapter.invoke(fixture.request, fixture.context);
    fixture.onDispatch.mockClear();
    const next = {
      ...fixture.request,
      messages: [
        ...fixture.request.messages,
        first.message!,
        { role: "tool" as const, content: "proof", tool_call_id: "call_one" },
      ],
      toolChoice: "none" as const,
    };
    const second = await fixture.adapter.invoke(next, fixture.context);
    expect(second.outcome).toBe("completed");
    const input = JSON.parse(fixture.fetcher.mock.calls[3][1]!.body as string).input;
    expect(input).toContainEqual(native);
    expect(input).toContainEqual({
      type: "function_call_output",
      call_id: "call_one",
      output: "proof",
    });
    expect(input.filter((item: { type: string }) => item.type === "function_call")).toHaveLength(1);
  });
  it.each([{ maxOutputTokens: 32 }, { temperature: 0 }])(
    "refuses explicit unsupported %j before all I/O",
    async (options) => {
      const fixture = setup();
      const result = await fixture.adapter.invoke({ ...fixture.request, options }, fixture.context);
      expect(result.problem?.code).toBe("unsupported_parameter");
      expect(result.outcome).toBe("failed");
      expect(fixture.onDispatch).not.toHaveBeenCalled();
      expect(fixture.fetcher).not.toHaveBeenCalled();
      expect(fixture.readAuthFile).not.toHaveBeenCalled();
    },
  );
  it.each(["not-in-this-account", " model-one "])(
    "does not accept unknown or normalized-away model %s",
    async (model) => {
      const fixture = setup();
      const result = await fixture.adapter.invoke({ ...fixture.request, model }, fixture.context);
      expect(result.problem?.code).toBe("model_unavailable");
      expect(fixture.onDispatch).not.toHaveBeenCalled();
      expect(fixture.fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it("refuses unadvertised effort and does not clamp or silently retry", async () => {
    const fixture = setup();
    const result = await fixture.adapter.invoke(
      { ...fixture.request, options: { reasoningEffort: "unknown" } },
      fixture.context,
    );
    expect(result.problem?.code).toBe("unsupported_parameter");
    expect(fixture.onDispatch).not.toHaveBeenCalled();
  });
  it.each([401, 403, 429, 500])("never retries a provider HTTP %s", async (status) => {
    const fixture = setup(() =>
      Response.json({ error: { type: "server_error", message: "DO_NOT_EXPOSE_BODY" } }, { status }),
    );
    const result = await fixture.adapter.invoke(fixture.request, fixture.context);
    expect(result.outcome).toBe("failed");
    expect(fixture.onDispatch).toHaveBeenCalledTimes(1);
    expect(fixture.fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(
      1,
    );
    expect(JSON.stringify(result)).not.toContain("DO_NOT_EXPOSE_BODY");
  });
  it("keeps network loss after dispatch unknown and never sends another POST", async () => {
    const fixture = setup(() => {
      throw new Error("network loss");
    });
    const result = await fixture.adapter.invoke(fixture.request, fixture.context);
    expect(result.outcome).toBe("unknown");
    expect(result.problem?.code).toBe("transport_unknown");
    expect(fixture.fetcher).toHaveBeenCalledTimes(2);
    expect(result.cost.cashUsd).toBeNull();
  });
  it("a failed dispatch callback does not send a generation", async () => {
    const fixture = setup();
    fixture.onDispatch.mockRejectedValue(new Error("journal failed"));
    const result = await fixture.adapter.invoke(fixture.request, fixture.context);
    expect(result.outcome).toBe("failed");
    expect(fixture.fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not replace requested options with inferred actual values", async () => {
    const fixture = setup();
    const result = await fixture.adapter.invoke(
      { ...fixture.request, options: { reasoningEffort: "ultra", serviceTier: "priority" } },
      fixture.context,
    );
    expect(JSON.parse(fixture.fetcher.mock.calls[1][1]!.body as string)).toMatchObject({
      reasoning: { effort: "ultra" },
      service_tier: "priority",
    });
    expect(result.appliedOptions).toEqual({ reasoningEffort: "medium", serviceTier: "standard" });
  });
  it("cancellation before preparation makes no network call", async () => {
    const fixture = setup(),
      controller = new AbortController();
    controller.abort();
    const result = await fixture.adapter.invoke(fixture.request, {
      ...fixture.context,
      signal: controller.signal,
    });
    expect(result.problem?.code).toBe("cancelled");
    expect(fixture.onDispatch).not.toHaveBeenCalled();
    expect(fixture.fetcher).not.toHaveBeenCalled();
  });
  it("401 with unknown credential freshness does not demand a new login", async () => {
    const fixture = setup(() => Response.json({}, { status: 401 }));
    fixture.readAuthFile.mockResolvedValue(
      JSON.stringify({ tokens: { access_token: "opaque-token", account_id: "account-one" } }),
    );
    const result = await fixture.adapter.invoke(fixture.request, fixture.context);
    expect(result.problem?.code).toBe("auth_refresh_failed");
    expect(fixture.fetcher).toHaveBeenCalledTimes(2);
  });
});

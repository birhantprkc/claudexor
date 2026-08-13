import { describe, expect, it } from "vitest";
import { parseChatCompletion, parseModelsList } from "./parse.js";

describe("parseChatCompletion", () => {
  it("extracts text, model, and usage from an OpenAI-compatible response", () => {
    const r = parseChatCompletion({
      model: "gpt-4o-mini",
      choices: [{ message: { role: "assistant", content: "Here is the plan." } }],
      usage: { prompt_tokens: 12, completion_tokens: 34 },
    });
    expect(r.text).toBe("Here is the plan.");
    expect(r.model).toBe("gpt-4o-mini");
    expect(r.usage.input_tokens).toBe(12);
    expect(r.usage.output_tokens).toBe(34);
  });

  it("handles empty/malformed responses gracefully", () => {
    expect(parseChatCompletion({}).text).toBe("");
    expect(parseChatCompletion({ choices: [] }).model).toBeNull();
  });

  it("retains allowlisted terminal provider-error facts and string diagnostics", () => {
    const result = parseChatCompletion({
      model: "openrouter/model",
      choices: [
        {
          message: { role: "assistant", content: "partial output" },
          finish_reason: "error",
          error: {
            code: 502,
            message: "Provider disconnected",
            metadata: {
              error_type: "provider_unavailable",
              provider_code: "upstream_502",
              flagged_input: "must not survive",
            },
            unknown: "must not survive either",
          },
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 3 },
    });

    expect(result.finish_reason).toBe("error");
    expect(result.diagnostic_text).toBe("partial output");
    expect(result.provider_error).toEqual({
      code: 502,
      message: "Provider disconnected",
      error_type: "provider_unavailable",
      provider_code: "upstream_502",
    });
    expect(JSON.stringify(result.provider_error)).not.toContain("flagged_input");
    expect(JSON.stringify(result.provider_error)).not.toContain("unknown");
  });

  it("keeps either terminal signal independently and rejects malformed choice errors", () => {
    expect(
      parseChatCompletion({
        choices: [{ message: { content: "partial" }, finish_reason: "error" }],
      }),
    ).toMatchObject({ finish_reason: "error", provider_error: null });

    expect(
      parseChatCompletion({
        choices: [
          {
            message: { content: "partial" },
            error: {
              code: 429,
              message: "limited",
              metadata: { error_type: "rate_limit_exceeded" },
            },
          },
        ],
      }),
    ).toMatchObject({
      finish_reason: null,
      provider_error: {
        code: 429,
        message: "limited",
        error_type: "rate_limit_exceeded",
        provider_code: null,
      },
    });

    for (const error of [null, "failed", [], { code: "502", message: "failed" }, { code: 502 }]) {
      expect(parseChatCompletion({ choices: [{ error }] }).provider_error).toBeNull();
    }

    expect(
      parseChatCompletion({
        choices: [
          {
            error: {
              code: 502,
              message: "failed",
              metadata: { error_type: 42, provider_code: { raw: true } },
            },
          },
        ],
      }).provider_error,
    ).toMatchObject({ error_type: null, provider_code: null });
  });

  it("retains stop/length as ordinary finish reasons and never stringifies rich content for diagnostics", () => {
    expect(
      parseChatCompletion({
        choices: [
          { message: { content: [{ type: "text", text: "rich" }] }, finish_reason: "length" },
        ],
      }),
    ).toMatchObject({ finish_reason: "length", diagnostic_text: null });
    expect(
      parseChatCompletion({ choices: [{ message: { content: "done" }, finish_reason: "stop" }] }),
    ).toMatchObject({ finish_reason: "stop", diagnostic_text: "done" });
  });

  it.each([
    ["-Number.MAX_VALUE", -Number.MAX_VALUE],
    ["-1", -1],
    ["-0", -0],
    ["0", 0],
    ["Number.MIN_VALUE", Number.MIN_VALUE],
    ["0.5", 0.5],
    ["Number.MAX_VALUE", Number.MAX_VALUE],
  ] as const)("accepts finite provider error code %s with an empty message", (_label, code) => {
    const providerError = parseChatCompletion({
      choices: [{ error: { code, message: "" } }],
    }).provider_error;

    expect(providerError?.code).toBe(code);
    expect(providerError).toMatchObject({
      message: "",
      error_type: null,
      provider_code: null,
    });
  });

  it.each([
    ["Number.NEGATIVE_INFINITY", Number.NEGATIVE_INFINITY],
    ["Number.NaN", Number.NaN],
    ["Number.POSITIVE_INFINITY", Number.POSITIVE_INFINITY],
  ] as const)("rejects non-finite provider error code %s", (_label, code) => {
    expect(
      parseChatCompletion({ choices: [{ error: { code, message: "" } }] }).provider_error,
    ).toBeNull();
  });
});

describe("parseModelsList", () => {
  it("parses the OpenAI GET /v1/models shape", () => {
    const models = parseModelsList({
      object: "list",
      data: [
        { id: "gpt-4o-mini", object: "model", created: 1, owned_by: "openai" },
        { id: "gpt-4o", object: "model", created: 2, owned_by: "openai" },
      ],
    });
    expect(models.map((m) => m.id)).toEqual(["gpt-4o-mini", "gpt-4o"]);
    // The bare OpenAI list carries no label/context_window -> honest nulls.
    expect(models[0]).toEqual({ id: "gpt-4o-mini", label: null, context_window: null });
  });

  it("populates label/context_window when a compatible provider supplies them", () => {
    const models = parseModelsList({
      data: [{ id: "openai/gpt-4o", name: "GPT-4o", context_length: 128000 }],
    });
    expect(models[0]).toEqual({ id: "openai/gpt-4o", label: "GPT-4o", context_window: 128000 });
  });

  it("drops entries without a string id and tolerates a missing/empty data array", () => {
    expect(
      parseModelsList({ data: [{ object: "model" }, { id: 42 }, { id: "ok" }] }).map((m) => m.id),
    ).toEqual(["ok"]);
    expect(parseModelsList({})).toEqual([]);
    expect(parseModelsList(null)).toEqual([]);
  });
});

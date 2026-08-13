import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@claudexor/secrets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@claudexor/secrets")>()),
  resolveSecret: () => null,
}));

import { HarnessEvent, HarnessRunSpec } from "@claudexor/schema";
import { buildRegistry } from "./registry.js";

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) out.push(item);
  return out;
}

describe("built-in OpenRouter registry wiring", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = "sk-test";
    process.env.CLAUDEXOR_OPENROUTER_BASE_URL = "https://unit.test/openrouter/v1";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...ORIGINAL_ENV };
  });

  it("declares the provider's account-charge receipt as exact USD", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            model: "openrouter/model",
            choices: [{ message: { content: "done" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 2, completion_tokens: 3, cost: 0.125 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = buildRegistry({ includeFakes: false }).get("openrouter");
    expect(adapter).toBeDefined();

    const events = await collect(
      adapter!.run(
        HarnessRunSpec.parse({
          session_id: "registry-openrouter-cost",
          intent: "review",
          prompt: "x",
          cwd: process.cwd(),
          access: "readonly",
          external_context_policy: "auto",
          tool_permission_policy: { web: "auto", allow: [], deny: [] },
        }),
      ),
    );
    const usageEvent = HarnessEvent.parse(events.find((event) => event.type === "usage"));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://unit.test/openrouter/v1/chat/completions");
    expect(usageEvent).toMatchObject({
      usage: { input_tokens: 2, output_tokens: 3, cost_usd: 0.125 },
      observed_model: "openrouter/model",
    });
    expect(usageEvent?.usage).not.toHaveProperty("estimated");
  });
});

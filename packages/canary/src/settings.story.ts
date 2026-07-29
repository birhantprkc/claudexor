/** Golden Settings contracts kept separate from the general CLI story so the
 * public validation matrix stays readable and below the complexity ratchet. */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Sandbox, cli, makeSandbox } from "./support.js";

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox();
});
afterEach(() => {
  sb.dispose();
});

describe("settings canary golden stories", () => {
  it("[INV-104:settings-write-strict] refuses settings outside truth and persists nothing", () => {
    // codex's manifest known_models is the offline truth source here.
    const bad = cli(sb, [
      "settings",
      "set",
      "harness.codex.default_model",
      "ghost-model-9000",
      "--json",
    ]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toBe("");
    expect(JSON.parse(bad.stdout)).toMatchObject({
      ok: false,
      exitCode: 2,
      code: "invalid_request",
      retryable: false,
    });
    expect(bad.stdout + bad.stderr).toMatch(/refused|not in the harness/i);

    const invalidGoal = cli(sb, ["settings", "set", "routing_goal", "quality", "--json"]);
    expect(invalidGoal.code).toBe(2);
    expect(invalidGoal.stderr).toBe("");
    expect(JSON.parse(invalidGoal.stdout)).toMatchObject({
      ok: false,
      exitCode: 2,
      code: "config_error",
      retryable: false,
    });

    const show = cli(sb, ["settings", "show", "--json"]);
    expect(show.stdout).not.toContain("ghost-model-9000");
    expect(show.json()).toMatchObject({ routing: { goal: "auto" } });
    const good = cli(sb, ["settings", "set", "harness.codex.default_model", "gpt-5.5"]);
    expect(good.code).toBe(0);
    const show2 = cli(sb, ["settings", "show", "--json"]);
    expect(show2.stdout).toContain("gpt-5.5");

    // Fakes are test fixtures, never persistable routing targets.
    const fake = cli(sb, ["settings", "set", "harness.fake-success.default_model", "fake-model"]);
    expect(fake.code).toBe(2);
    expect(fake.stdout + fake.stderr).toMatch(/fake-success.*(?:not persistable|not a real)/i);
  });

  it("[INV-103:no-global-model] validates retired local input before daemon bootstrap", () => {
    const r = cli(sb, ["settings", "set", "default_model", "gpt-5.5"]);
    expect(r.code).toBe(2);
    expect(r.stdout + r.stderr).toMatch(/harness-scoped|harness\.<id>\.default_model/);
    expect(existsSync(join(sb.configDir, "daemon", "control-api.json"))).toBe(false);

    const invalidBoolean = cli(sb, [
      "settings",
      "set",
      "harness.claude.enabled",
      "maybe",
      "--json",
    ]);
    expect(invalidBoolean.code).toBe(2);
    expect(() => JSON.parse(invalidBoolean.stdout)).not.toThrow();
    expect(existsSync(join(sb.configDir, "daemon", "control-api.json"))).toBe(false);
  });
});

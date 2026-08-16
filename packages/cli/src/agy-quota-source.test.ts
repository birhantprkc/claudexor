import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { QuotaConstraint, harnessHasDefaultCredentialStore } from "@claudexor/schema";
import { parseAgyQuotaEnvelope, refreshAgyQuota } from "./agy-quota-source.js";

const FIXTURES = fileURLToPath(new URL("./__fixtures__", import.meta.url));
const read = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

describe("parseAgyQuotaEnvelope", () => {
  it("maps tier-1 (4 windows) to model-scoped constraints, both groups tagged", () => {
    const out = parseAgyQuotaEnvelope(read("agy-quota-tier1.json"));
    expect(out.kind).toBe("constraints");
    if (out.kind !== "constraints") return;
    // Every constraint validates against the schema.
    for (const c of out.constraints) expect(() => QuotaConstraint.parse(c)).not.toThrow();
    const byId = Object.fromEntries(out.constraints.map((c) => [c.id, c]));
    // remaining_fraction 1.0 -> used_ratio 0; a partial remaining inverts.
    expect(byId["gemini-weekly"].used_ratio).toBe(0);
    // Gemini windows tag only gemini slugs; the 3p group tags claude/gpt slugs.
    expect(byId["gemini-weekly"].applies_to_models).toContain("gemini-3.1-pro-high");
    expect(byId["gemini-weekly"].applies_to_models).not.toContain("claude-opus-4-6-thinking");
    expect(byId["3p-weekly"].applies_to_models).toContain("claude-opus-4-6-thinking");
    // 5h window carries its second budget.
    expect(byId["gemini-5h"].window_seconds).toBe(5 * 60 * 60);
    expect(byId["gemini-weekly"].window_seconds).toBe(7 * 24 * 60 * 60);
    expect(byId["gemini-weekly"].resets_at).toBeTruthy();
    // Which window governs a run that names NO model is not the parser's
    // call: it belongs to the profile's selected model and is stamped by the
    // refresher (see the bare-route suite below), so the envelope carries no
    // guess of its own.
    expect(byId["gemini-weekly"].applies_to_unspecified_model).toBeUndefined();
    expect(byId["3p-weekly"].applies_to_unspecified_model).toBeUndefined();
  });

  it("tolerates a lower tier with NO 5-hour windows (missing window is normal)", () => {
    const out = parseAgyQuotaEnvelope(read("agy-quota-tier2.json"));
    expect(out.kind).toBe("constraints");
    if (out.kind !== "constraints") return;
    const windows = out.constraints.map((c) => c.id);
    expect(windows).toContain("gemini-weekly");
    expect(windows).not.toContain("gemini-5h"); // tier-2 has no 5h window at all
  });

  it("classifies an auth error envelope as auth_revoked, not a snapshot", () => {
    const out = parseAgyQuotaEnvelope(
      JSON.stringify({ status: "ERROR", error: "authentication required. Run agy to log in" }),
    );
    expect(out).toMatchObject({ kind: "auth_revoked" });
  });

  it("classifies a non-auth error as failed", () => {
    const out = parseAgyQuotaEnvelope(JSON.stringify({ status: "ERROR", error: "network down" }));
    expect(out).toMatchObject({ kind: "failed" });
  });

  it("never throws on garbage input", () => {
    expect(parseAgyQuotaEnvelope("not json").kind).toBe("failed");
    expect(parseAgyQuotaEnvelope("{}").kind).toBe("failed");
    expect(parseAgyQuotaEnvelope('{"command":{"data":{"groups":[]}}}').kind).toBe("failed");
  });
});

/**
 * The REFRESHER — the half the first review found untested, which is exactly
 * why a missing PATH (every spawn ENOENT) and a `close`-instead-of-`exit` wait
 * (a wedged descendant hanging the daemon's whole quota cycle) both shipped
 * unnoticed. Every case here drives the real function against a FAKE `agy`
 * script: no vendor binary is ever spawned, so no test can trigger a login.
 */
describe("refreshAgyQuota", () => {
  const roots: string[] = [];
  const originalConfig = process.env.CLAUDEXOR_CONFIG_DIR;

  afterEach(() => {
    if (originalConfig === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
    else process.env.CLAUDEXOR_CONFIG_DIR = originalConfig;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  /** A config dir with one enabled agy profile, plus a fake `agy` on disk. */
  function scaffold(options: { token: boolean; script: string }): { bin: string } {
    const root = mkdtempSync(join(tmpdir(), "claudexor-agy-quota-"));
    roots.push(root);
    process.env.CLAUDEXOR_CONFIG_DIR = root;
    const home = join(root, "profiles", "agy-prof-a");
    mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
    if (options.token)
      writeFileSync(join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token"), "t", {
        mode: 0o600,
      });
    writeFileSync(
      join(root, "config.yaml"),
      [
        "version: 1",
        "credential_profiles:",
        "  - profile_id: prof-a",
        "    harness_id: agy",
        "    display_name: A",
        "    credential_kind: config_dir_login",
        `    isolation_locator: ${home}`,
        "    enabled: true",
        "",
      ].join("\n"),
    );
    const bin = join(root, "fake-agy");
    writeFileSync(bin, options.script);
    chmodSync(bin, 0o755);
    return { bin };
  }

  const MODEL_ENVELOPE = (id: string) =>
    JSON.stringify({ status: "SUCCESS", command: { name: "model", data: { id } } });

  const ENVELOPE = JSON.stringify({
    status: "SUCCESS",
    command: {
      data: {
        groups: [
          {
            name: "Gemini Models",
            buckets: [
              { id: "gemini-weekly", name: "Weekly", window: "weekly", remaining_fraction: 0.25 },
            ],
          },
        ],
      },
    },
  });

  it("spawns the vendor with a usable PATH and maps its envelope to a snapshot", async () => {
    // The fake resolves `node` itself: proof the child inherited a real PATH.
    const { bin } = scaffold({
      token: true,
      script: `#!/bin/sh\ncommand -v node >/dev/null || { echo '{"status":"ERROR","error":"no PATH"}'; exit 0; }\ncase "$2" in\n"/model") cat <<'JSON'\n${MODEL_ENVELOPE("gemini-3.7-flash-high")}\nJSON\n;;\n*) cat <<'JSON'\n${ENVELOPE}\nJSON\n;;\nesac\n`,
    });
    const out = await refreshAgyQuota({ bin });
    expect(out.absences ?? []).toEqual([]);
    expect(out.snapshots).toHaveLength(1);
    expect(out.snapshots[0]).toMatchObject({
      subject: { harness: "agy", credential_route: "vendor_native", subject_id: "prof-a" },
      source: "agy_command_usage",
    });
    expect(out.snapshots[0].constraints[0]).toMatchObject({
      id: "gemini-weekly",
      used_ratio: 0.75,
    });
  });

  it("never spawns the vendor for a profile with no token (no login can be triggered)", async () => {
    const { bin } = scaffold({ token: false, script: '#!/bin/sh\ntouch "$0.spawned"\n' });
    const out = await refreshAgyQuota({ bin });
    expect(out.snapshots).toEqual([]);
    expect(out.absences?.[0]).toMatchObject({ reason: "not_logged_in" });
    expect(() => readFileSync(`${bin}.spawned`)).toThrow();
  });

  it("reports an unspawnable binary as a typed absence instead of throwing", async () => {
    const { bin } = scaffold({ token: true, script: "#!/bin/sh\n" });
    const out = await refreshAgyQuota({ bin: `${bin}-does-not-exist` });
    expect(out.snapshots).toEqual([]);
    expect(out.absences?.[0]).toMatchObject({ reason: "refresh_failed" });
  });

  it("resolves even when a surviving descendant holds the stdout pipe open", async () => {
    // The exact wedge the review reproduced: the child exits, a grandchild
    // keeps the pipe. Waiting on `close` would hang here forever and stall the
    // daemon's whole quota cycle; waiting on `exit` returns.
    const { bin } = scaffold({
      token: true,
      script: `#!/bin/sh\nsleep 30 &\ncat <<'JSON'\n${ENVELOPE}\nJSON\nexit 0\n`,
    });
    const out = await Promise.race([
      refreshAgyQuota({ bin }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("wedged")), 10_000)),
    ]);
    expect((out as { snapshots: unknown[] }).snapshots).toHaveLength(1);
  }, 15_000);

  it("classifies the vendor's auth envelope as auth_revoked, not a failure", async () => {
    const { bin } = scaffold({
      token: true,
      script: `#!/bin/sh\necho '{"status":"ERROR","error":"authentication required. Run agy to log in"}'\n`,
    });
    const out = await refreshAgyQuota({ bin });
    expect(out.absences?.[0]).toMatchObject({ reason: "auth_revoked" });
  });
});

describe("harnessHasDefaultCredentialStore (Л-4: agy has no default store)", () => {
  it("keeps a default subject for the harnesses that have one and denies agy", () => {
    expect(harnessHasDefaultCredentialStore("claude")).toBe(true);
    expect(harnessHasDefaultCredentialStore("codex")).toBe(true);
    expect(harnessHasDefaultCredentialStore("agy")).toBe(false);
  });
});

describe("parseAgyQuotaEnvelope hostile shapes (review Ф2 #3)", () => {
  const envelope = (bucket: unknown) =>
    JSON.stringify({
      status: "SUCCESS",
      command: { data: { groups: [{ name: "Gemini Models", buckets: [bucket] }] } },
    });

  it("drops only the unparseable window, never the whole account batch", () => {
    // A blank id/label and a garbage reset stamp all used to produce a
    // constraint the daemon rejected — taking every other window with it.
    for (const bucket of [
      { id: "", name: "", window: "weekly", remaining_fraction: 0.5 },
      { id: "x", name: "y", window: "weekly", reset_time: "not-a-date" },
      { id: "x", name: "y", window: "__proto__" },
      {},
      null,
    ]) {
      const out = parseAgyQuotaEnvelope(envelope(bucket));
      if (out.kind !== "constraints") continue;
      for (const c of out.constraints) expect(() => QuotaConstraint.parse(c)).not.toThrow();
    }
  });

  it("never resolves a window length from Object.prototype", () => {
    const out = parseAgyQuotaEnvelope(envelope({ id: "x", name: "y", window: "toString" }));
    expect(out.kind).toBe("constraints");
    if (out.kind !== "constraints") return;
    expect(out.constraints[0].window_seconds).toBeNull();
  });

  it("leaves the object prototype untouched for a __proto__ bucket key", () => {
    parseAgyQuotaEnvelope(
      JSON.stringify({
        status: "SUCCESS",
        command: {
          data: {
            groups: [
              { name: "Gemini Models", buckets: [JSON.parse('{"__proto__":{"polluted":1}}')] },
            ],
          },
        },
      }),
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

/**
 * Which window governs a run that NAMES NO MODEL. Every agy window is
 * model-scoped, so without this stamp an exhausted account can never refuse a
 * bare run and Л-2 rotation never fires; stamping the wrong group is just as
 * wrong in the other direction, so the source follows the profile's SELECTED
 * model rather than an assumption about it.
 */
describe("refreshAgyQuota bare-route scoping", () => {
  const roots: string[] = [];
  const originalConfig = process.env.CLAUDEXOR_CONFIG_DIR;
  afterEach(() => {
    if (originalConfig === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
    else process.env.CLAUDEXOR_CONFIG_DIR = originalConfig;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function scaffoldWithModel(selected: string | null): { bin: string } {
    const root = mkdtempSync(join(tmpdir(), "claudexor-agy-scope-"));
    roots.push(root);
    process.env.CLAUDEXOR_CONFIG_DIR = root;
    const home = join(root, "profiles", "agy-prof-a");
    mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
    writeFileSync(join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token"), "t", {
      mode: 0o600,
    });
    writeFileSync(
      join(root, "config.yaml"),
      [
        "version: 1",
        "credential_profiles:",
        "  - profile_id: prof-a",
        "    harness_id: agy",
        "    display_name: A",
        "    credential_kind: config_dir_login",
        `    isolation_locator: ${home}`,
        "    enabled: true",
        "",
      ].join("\n"),
    );
    const quota = JSON.stringify({
      status: "SUCCESS",
      command: {
        data: {
          groups: [
            {
              name: "Gemini Models",
              buckets: [
                { id: "gemini-weekly", name: "W", window: "weekly", remaining_fraction: 0 },
              ],
            },
            {
              name: "Claude and GPT models",
              buckets: [{ id: "3p-weekly", name: "W", window: "weekly", remaining_fraction: 1 }],
            },
          ],
        },
      },
    });
    const model =
      selected === null
        ? '{"status":"ERROR","error":"no model"}'
        : JSON.stringify({ status: "SUCCESS", command: { name: "model", data: { id: selected } } });
    const bin = join(root, "fake-agy");
    writeFileSync(
      bin,
      `#!/bin/sh\ncase "$2" in\n"/model") echo '${model}' ;;\n*) cat <<'JSON'\n${quota}\nJSON\n;;\nesac\n`,
    );
    chmodSync(bin, 0o755);
    return { bin };
  }

  const flags = async (selected: string | null): Promise<Record<string, boolean | undefined>> => {
    const out = await refreshAgyQuota({ bin: scaffoldWithModel(selected).bin });
    return Object.fromEntries(
      out.snapshots[0]!.constraints.map((c) => [c.id, c.applies_to_unspecified_model]),
    );
  };

  it("follows the profile's selected model, in both directions", async () => {
    expect(await flags("gemini-3.7-flash-high")).toEqual({
      "gemini-weekly": true,
      "3p-weekly": false,
    });
    // A user who selected a third-party slug must be refused on THAT budget,
    // and must not rotate accounts because the Gemini budget ran out.
    expect(await flags("claude-opus-4-6-thinking")).toEqual({
      "gemini-weekly": false,
      "3p-weekly": true,
    });
  });

  it("falls back to the Gemini group when the vendor will not say", async () => {
    expect(await flags(null)).toEqual({ "gemini-weekly": true, "3p-weekly": false });
  });

  it("falls back rather than leaving EVERY window ungoverned for an unknown slug", async () => {
    // The vendor ships new slugs between our releases and the user picks them
    // in its own TUI. Matching none must not read as a healthy account: that
    // would make an exhausted subscription unrefusable and rotation dead.
    expect(await flags("gemini-4.0-flash-high")).toEqual({
      "gemini-weekly": true,
      "3p-weekly": false,
    });
    expect(await flags("some-future-vendor-model")).toEqual({
      "gemini-weekly": true,
      "3p-weekly": false,
    });
  });
});

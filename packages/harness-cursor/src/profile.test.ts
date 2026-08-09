import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HarnessRunSpec, type CredentialProfile, type HarnessEvent } from "@claudexor/schema";
import type { CliRunLoopOptions } from "@claudexor/core";
import { createCursorAdapter } from "./index.js";
import {
  canonicalCursorProfileHome,
  cursorProfilePathEnv,
  cursorProfileRunEnv,
  probeCursorCredentialAccount,
  probeCursorCredentialProfile,
  resolveCursorProfileRoute,
} from "./profile.js";

describe("Cursor config-dir credential profiles (INV-135)", () => {
  let root: string;
  let priorRoot: string | undefined;
  let home: string;

  const profile = (over: Partial<CredentialProfile> = {}): CredentialProfile => ({
    profile_id: "valentine",
    harness_id: "cursor",
    display_name: "Valentine",
    credential_kind: "config_dir_login",
    isolation_locator: home,
    secret_ref: null,
    enabled: true,
    created_at: null,
    ...over,
  });

  beforeEach(() => {
    // realpath: macOS tmpdir is a /var → /private/var symlink, and the locator
    // canonicalizer resolves it — the expected home must use the same spelling.
    root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-cursor-profile-")));
    priorRoot = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = root;
    home = join(root, "profiles", "cursor-valentine");
  });

  afterEach(() => {
    if (priorRoot === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
    else process.env.CLAUDEXOR_CONFIG_DIR = priorRoot;
    rmSync(root, { recursive: true, force: true });
  });

  it("canonicalizes only Claudexor-owned homes", () => {
    expect(canonicalCursorProfileHome(home)).toBe(home);
    expect(() => canonicalCursorProfileHome("relative/home")).toThrow(/absolute/);
    expect(() => canonicalCursorProfileHome(join(tmpdir(), "outside"))).toThrow(/must live under/);
  });

  it("separates profile auth paths from lane config/session paths", () => {
    const paths = cursorProfilePathEnv(home, "/tmp/cursor-lane");
    expect(paths).toMatchObject({
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, "AppData", "Roaming"),
      XDG_CONFIG_HOME: join(home, ".config"),
      CURSOR_CONFIG_DIR: "/tmp/cursor-lane/.cursor",
      CURSOR_DATA_DIR: "/tmp/cursor-lane/.cursor",
      AGENT_CLI_CREDENTIAL_STORE: "file",
    });
    const env = cursorProfileRunEnv(home, {
      HOME: "/tmp/cursor-lane",
      CURSOR_API_KEY: "must-be-scrubbed",
    });
    expect(env["HOME"]).toBe(home);
    expect(env["CURSOR_API_KEY"]).toBeNull();
    expect(env["CURSOR_CONFIG_DIR"]).toBe("/tmp/cursor-lane/.cursor");
  });

  it("routes only a login proven in the exact profile file-store env", async () => {
    let observed: Record<string, string | null | undefined> | undefined;
    const runtime = {
      nativeAuthOk: async (env: typeof observed) => {
        observed = env;
        return { kind: "authenticated" } as const;
      },
      resolveProfileSecret: () => null,
    };
    const route = await resolveCursorProfileRoute(profile(), { HOME: "/tmp/thread-lane" }, runtime);
    expect(route).toMatchObject({ kind: "native" });
    expect(observed).toMatchObject({
      HOME: home,
      CURSOR_CONFIG_DIR: "/tmp/thread-lane/.cursor",
      AGENT_CLI_CREDENTIAL_STORE: "file",
      CURSOR_API_KEY: null,
    });
  });

  it("refuses a logged-out named profile instead of falling back to default auth", async () => {
    let secretReads = 0;
    const route = await resolveCursorProfileRoute(
      profile(),
      {},
      {
        nativeAuthOk: async () => ({ kind: "loggedOut" }),
        resolveProfileSecret: () => {
          secretReads += 1;
          return "default-must-not-be-used";
        },
      },
    );
    expect(route).toMatchObject({ refusal: expect.stringContaining("profile login") });
    expect(secretReads).toBe(0);
  });

  it("refuses when the status probe cannot decide instead of guessing readiness", async () => {
    const route = await resolveCursorProfileRoute(
      profile(),
      {},
      {
        nativeAuthOk: async () => ({ kind: "unknown", error: "status transport failed" }),
        resolveProfileSecret: () => null,
      },
    );
    expect(route).toMatchObject({
      refusal: expect.stringContaining("status probe failed"),
    });
  });

  it("turns an out-of-tree isolation locator into a typed refusal, never a probe", async () => {
    const route = await resolveCursorProfileRoute(
      profile({ isolation_locator: join(tmpdir(), "outside-claudexor") }),
      {},
      {
        nativeAuthOk: async () => {
          throw new Error("must not probe an unconfined home");
        },
        resolveProfileSecret: () => null,
      },
    );
    expect(route).toMatchObject({ refusal: expect.stringContaining("must live under") });
  });

  it("preserves namespaced Cursor API-key profiles", async () => {
    const route = await resolveCursorProfileRoute(
      profile({
        credential_kind: "api_key",
        isolation_locator: null,
        secret_ref: "cursor:valentine",
      }),
      {},
      {
        nativeAuthOk: async () => ({ kind: "loggedOut" }),
        resolveProfileSecret: (ref) => (ref === "cursor:valentine" ? "cursor-key" : null),
      },
    );
    expect(route).toEqual({ kind: "api_key", key: "cursor-key" });
  });

  it.each([
    {
      probe: { kind: "authenticated" as const },
      availability: "available",
      verification: "passed",
    },
    {
      probe: { kind: "loggedOut" as const },
      availability: "unavailable",
      verification: "not_run",
    },
    {
      probe: { kind: "unknown" as const, error: "status transport failed" },
      availability: "unknown",
      verification: "not_run",
    },
    {
      probe: { kind: "unknown" as const },
      availability: "unknown",
      verification: "not_run",
    },
  ])("maps profile status evidence without reading default credentials", async (expected) => {
    const status = await probeCursorCredentialProfile(profile(), {
      nativeAuthOk: async () => expected.probe,
      resolveProfileSecret: () => {
        throw new Error("must not read a default secret");
      },
    });
    expect(status).toMatchObject({
      profile_id: "valentine",
      harness_id: "cursor",
      availability: expected.availability,
      verification: expected.verification,
    });
  });

  it("returns a named profile email and readiness from one status observation", async () => {
    let calls = 0;
    const receipt = await probeCursorCredentialAccount(profile(), {
      nativeAuthOk: async () => {
        calls += 1;
        return { kind: "authenticated", email: "valentine@example.test" };
      },
      resolveProfileSecret: () => {
        throw new Error("must not read a default secret");
      },
    });
    expect(calls).toBe(1);
    expect(receipt).toMatchObject({
      status: {
        profile_id: "valentine",
        harness_id: "cursor",
        availability: "available",
        verification: "passed",
      },
      identity: { email: "valentine@example.test" },
    });
    expect(receipt.identity).not.toHaveProperty("plan");
  });

  it("keeps API-key profiles identity-free and does not run a native status probe", async () => {
    let nativeCalls = 0;
    const receipt = await probeCursorCredentialAccount(
      profile({
        credential_kind: "api_key",
        isolation_locator: null,
        secret_ref: "cursor:valentine",
      }),
      {
        nativeAuthOk: async () => {
          nativeCalls += 1;
          return { kind: "authenticated", email: "must-not-appear@example.test" };
        },
        resolveProfileSecret: () => "cursor-key",
      },
    );
    expect(nativeCalls).toBe(0);
    expect(receipt.identity).toBeNull();
    expect(receipt.status).toMatchObject({
      availability: "available",
      verification: "not_run",
    });
  });

  // Cursor strict profile routing at RUN level (INV-135), mirroring the codex
  // suite: the named identity is exactly its file-store HOME or a typed error
  // event — never the default Keychain session, key ladder, or a host bridge.
  describe("run routing", () => {
    const spec = (over: Partial<HarnessRunSpec> = {}): HarnessRunSpec =>
      HarnessRunSpec.parse({
        session_id: "s-cursor-profile",
        intent: "implement",
        prompt: "do it",
        cwd: "/repo",
        ...over,
      });

    it("pins the file-store env into BOTH the probe and the child and stamps events", async () => {
      let probedEnv: Record<string, string | null | undefined> | undefined;
      let cliOpts: CliRunLoopOptions | undefined;
      let stamped: HarnessEvent | undefined;
      const adapter = createCursorAdapter({
        detectVersion: async () => "cursor-test",
        nativeAuthOk: async (env) => {
          probedEnv = env;
          return { kind: "authenticated" };
        },
        cursorApiKey: () => {
          throw new Error("default key ladder must not run under a profile");
        },
        resolveProfileSecret: () => {
          throw new Error("secret store must not be read for a native profile");
        },
        runCliHarness: async function* (opts: CliRunLoopOptions): AsyncGenerator<HarnessEvent> {
          cliOpts = opts;
          const out = opts.parseEvent?.({ type: "system", subtype: "init" }, "s1");
          for (const ev of out ?? []) {
            stamped = ev;
            yield ev;
          }
          yield { type: "completed", session_id: "s1", ts: new Date().toISOString() };
        },
      });
      const events: HarnessEvent[] = [];
      for await (const ev of adapter.run(
        spec({
          credential_profile: profile(),
          env: { HOME: "/tmp/thread-lane", CURSOR_API_KEY: "must-be-scrubbed" },
        }),
      ))
        events.push(ev);
      expect(events.some((e) => e.type === "error")).toBe(false);
      for (const env of [probedEnv, cliOpts?.env]) {
        expect(env).toMatchObject({
          HOME: home,
          CURSOR_CONFIG_DIR: "/tmp/thread-lane/.cursor",
          CURSOR_DATA_DIR: "/tmp/thread-lane/.cursor",
          AGENT_CLI_CREDENTIAL_STORE: "file",
          CURSOR_API_KEY: null,
        });
      }
      // A named profile must never receive the host login-Keychain bridge.
      expect(existsSync(join(home, "Library", "Keychains"))).toBe(false);
      expect(stamped?.credential_profile_id).toBe("valentine");
      expect(stamped?.credential_route).toBe("vendor_native");
    });

    it("a logged-out named profile refuses typed without launching or falling back", async () => {
      let launches = 0;
      const adapter = createCursorAdapter({
        detectVersion: async () => "cursor-test",
        nativeAuthOk: async () => ({ kind: "loggedOut" }),
        cursorApiKey: () => {
          throw new Error("default key ladder must not run under a profile");
        },
        resolveProfileSecret: () => {
          throw new Error("secret store must not be read for a native profile");
        },
        runCliHarness: async function* (): AsyncGenerator<HarnessEvent> {
          launches += 1;
        },
      });
      const events: HarnessEvent[] = [];
      for await (const ev of adapter.run(spec({ credential_profile: profile() }))) events.push(ev);
      expect(events.map((e) => e.type)).toEqual(["error", "completed"]);
      expect((events[0] as { error?: string }).error).toContain("profile login");
      expect(launches).toBe(0);
    });
  });
});

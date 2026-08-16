import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { userConfigDir } from "@claudexor/util";
import { nativeLoginDisplayCommand, nativeLoginEnv, nativeLoginSpec } from "./native-login.js";
import { defaultNativeClaudeConfigDir } from "@claudexor/harness-claude";
import { CODEX_FILE_AUTH_OVERRIDE, defaultNativeCodexHome } from "@claudexor/harness-codex";

describe("native login specs", () => {
  const resolver = (binary: string): string => `/normalized/bin/${binary}`;
  let previousNativeHome: string | undefined;
  let nativeHome: string;

  beforeEach(() => {
    previousNativeHome = process.env.CLAUDEXOR_CODEX_NATIVE_HOME;
    // The override must stay inside the Claudexor config root (A4 containment),
    // so seed the disposable native home under the (hermetic) config dir.
    mkdirSync(join(userConfigDir(), "native"), { recursive: true });
    nativeHome = mkdtempSync(join(userConfigDir(), "native", "codex-login-"));
    process.env.CLAUDEXOR_CODEX_NATIVE_HOME = nativeHome;
  });

  afterEach(() => {
    if (previousNativeHome === undefined) delete process.env.CLAUDEXOR_CODEX_NATIVE_HOME;
    else process.env.CLAUDEXOR_CODEX_NATIVE_HOME = previousNativeHome;
    rmSync(nativeHome, { recursive: true, force: true });
  });

  it("uses the exact allowlisted vendor commands and absolute resolved binaries", () => {
    const names = [
      "CLAUDEXOR_CODEX_BIN",
      "CLAUDEXOR_CLAUDE_BIN",
      "CLAUDEXOR_CURSOR_BIN",
      "CLAUDEXOR_AGY_BIN",
    ] as const;
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    for (const name of names) delete process.env[name];
    try {
      // D-17 default: codex logs in over the app-server device-code flow (no
      // Terminal), NOT the legacy `codex login --device-auth`.
      expect(nativeLoginSpec("codex", resolver)).toEqual({
        binary: "/normalized/bin/codex",
        args: ["-c", CODEX_FILE_AUTH_OVERRIDE, "app-server", "--stdio"],
        displayCommand: "codex app-server device-code login (isolated Claudexor profile)",
        loginMode: "device_code",
        appServerFlow: "chatgptDeviceCode",
      });
      // Secondary app-server browser-callback flow (codex only).
      expect(nativeLoginSpec("codex", resolver, "browser_callback")).toEqual({
        binary: "/normalized/bin/codex",
        args: ["-c", CODEX_FILE_AUTH_OVERRIDE, "app-server", "--stdio"],
        displayCommand: "codex app-server browser-callback login (isolated Claudexor profile)",
        loginMode: "device_code",
        appServerFlow: "chatgpt",
      });
      // Explicit opt-in legacy Terminal localhost-redirect flow (codex only).
      expect(nativeLoginSpec("codex", resolver, "browser_redirect")).toEqual({
        binary: "/normalized/bin/codex",
        args: ["-c", CODEX_FILE_AUTH_OVERRIDE, "login"],
        displayCommand: "codex login (browser redirect, isolated Claudexor profile)",
        loginMode: "terminal",
      });
      // A flow hint never changes non-codex harnesses.
      expect(nativeLoginSpec("claude", resolver, "browser_redirect")?.args).toEqual([
        "auth",
        "login",
      ]);
      // Owner directive 2026-08-04: claude and cursor never open Terminal —
      // claude's manual OAuth completion takes the one-shot input sidecar,
      // cursor's login self-completes by server-side polling.
      expect(nativeLoginSpec("claude", resolver)).toEqual({
        binary: "/normalized/bin/claude",
        args: ["auth", "login"],
        displayCommand: "claude auth login",
        loginMode: "url_disclosure_with_input",
      });
      expect(nativeLoginSpec("cursor", resolver)).toEqual({
        binary: "/normalized/bin/cursor-agent",
        args: ["login"],
        displayCommand: "cursor-agent login",
        loginMode: "url_disclosure",
      });
      // agy has no login subcommand at all: the bare interactive CLI prints the
      // sign-in URL and takes the pasted code — the same shape as claude, with
      // one difference the runner has to honor, that the vendor reads its code
      // only from a real terminal.
      expect(nativeLoginSpec("agy", resolver)).toEqual({
        binary: "/normalized/bin/agy",
        args: [],
        displayCommand: "agy (interactive login)",
        loginMode: "url_disclosure_with_input",
        ptyStdin: true,
        // The vendor's OWN paste window, sealed so the card counts down
        // against the process rather than against the engine's 15 minutes.
        loginWindowMs: 60_000,
      });
      // No other harness claims a tty: a needless wrapper process around a
      // login that never reads stdin.
      for (const harness of ["codex", "claude", "cursor"]) {
        expect(nativeLoginSpec(harness, resolver)?.ptyStdin).toBeUndefined();
        // No other vendor caps its own window, so the engine's governs.
        expect(nativeLoginSpec(harness, resolver)?.loginWindowMs).toBeUndefined();
      }
      for (const harness of ["codex", "claude", "cursor", "agy"]) {
        expect(isAbsolute(nativeLoginSpec(harness, resolver)?.binary ?? "")).toBe(true);
      }
    } finally {
      for (const name of names) {
        const value = previous[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("refuses unresolved or non-absolute binaries and leaves OpenCode out", () => {
    expect(nativeLoginSpec("codex", () => null)).toBeNull();
    expect(nativeLoginSpec("codex", () => "codex")).toBeNull();
    expect(nativeLoginSpec("opencode", resolver)).toBeNull();
    expect(nativeLoginDisplayCommand("codex")).toBe(
      "codex app-server device-code login (isolated Claudexor profile)",
    );
  });

  it("resolves the same explicit binary override used by the adapter", () => {
    const previous = process.env.CLAUDEXOR_CODEX_BIN;
    process.env.CLAUDEXOR_CODEX_BIN = "/custom/codex";
    try {
      const requested: string[] = [];
      const spec = nativeLoginSpec("codex", (binary) => {
        requested.push(binary);
        return binary;
      });
      expect(requested).toEqual(["/custom/codex"]);
      expect(spec?.binary).toBe("/custom/codex");
    } finally {
      if (previous === undefined) delete process.env.CLAUDEXOR_CODEX_BIN;
      else process.env.CLAUDEXOR_CODEX_BIN = previous;
    }
  });

  it("scrubs all provider credentials and redirects while retaining runtime network context", () => {
    const env = nativeLoginEnv("codex", {
      HOME: "/home/user",
      PATH: "/custom/bin",
      HTTPS_PROXY: "http://proxy.example",
      NODE_EXTRA_CA_CERTS: "/ca.pem",
      OPENAI_API_KEY: "secret-openai",
      CODEX_ACCESS_TOKEN: "secret-codex-token",
      ANTHROPIC_API_KEY: "secret-anthropic",
      CLAUDE_CODE_USE_FOUNDRY: "1",
      ANTHROPIC_FOUNDRY_API_KEY: "secret-foundry",
      ANTHROPIC_FOUNDRY_AUTH_TOKEN: "secret-foundry-token",
      ANTHROPIC_FOUNDRY_RESOURCE: "resource-name",
      ANTHROPIC_FOUNDRY_BASE_URL: "https://foundry.invalid",
      AZURE_CLIENT_SECRET: "secret-azure",
      AZURE_FEDERATED_TOKEN_FILE: "/tmp/token",
      CURSOR_API_KEY: "secret-cursor",
      OPENAI_BASE_URL: "https://redirect.invalid",
    });
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.CODEX_ACCESS_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_USE_FOUNDRY).toBeUndefined();
    expect(env.ANTHROPIC_FOUNDRY_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_FOUNDRY_AUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_FOUNDRY_RESOURCE).toBeUndefined();
    expect(env.ANTHROPIC_FOUNDRY_BASE_URL).toBeUndefined();
    expect(env.AZURE_CLIENT_SECRET).toBeUndefined();
    expect(env.AZURE_FEDERATED_TOKEN_FILE).toBeUndefined();
    expect(env.CURSOR_API_KEY).toBeUndefined();
    expect(env.OPENAI_BASE_URL).toBeUndefined();
    expect(env.HTTPS_PROXY).toBe("http://proxy.example");
    expect(env.NODE_EXTRA_CA_CERTS).toBe("/ca.pem");
    expect(env.PATH).toContain("/custom/bin");
    expect(env.CODEX_HOME).toBe(defaultNativeCodexHome());
  });

  it("pins each vendor login to the same native store its verifier probes", () => {
    const source = {
      HOME: "/daemon/home",
      CODEX_HOME: "/stale/scoped/codex",
      CLAUDE_CONFIG_DIR: "/stale/scoped/claude",
      CURSOR_API_KEY: "must-be-scrubbed",
    };
    expect(nativeLoginEnv("codex", source).CODEX_HOME).toBe(defaultNativeCodexHome());
    expect(nativeLoginEnv("claude", source).CLAUDE_CONFIG_DIR).toBe(defaultNativeClaudeConfigDir());
    expect(nativeLoginEnv("cursor", source).HOME).toBe("/daemon/home");
    expect(nativeLoginEnv("cursor", source).CURSOR_API_KEY).toBeUndefined();
  });

  it("pins a named Cursor login to its own file store without changing the default route", () => {
    const profiles = join(userConfigDir(), "profiles");
    mkdirSync(profiles, { recursive: true });
    // realpath: the canonicalizer resolves the macOS /var → /private/var
    // symlink, so the expected paths must use the resolved spelling.
    const profileHome = realpathSync(mkdtempSync(join(profiles, "cursor-login-")));
    try {
      const env = nativeLoginEnv(
        "cursor",
        { HOME: "/daemon/home", PATH: "/custom/bin", CURSOR_API_KEY: "must-scrub" },
        profileHome,
      );
      expect(env).toMatchObject({
        HOME: profileHome,
        USERPROFILE: profileHome,
        APPDATA: join(profileHome, "AppData", "Roaming"),
        XDG_CONFIG_HOME: join(profileHome, ".config"),
        CURSOR_CONFIG_DIR: join(profileHome, ".cursor"),
        CURSOR_DATA_DIR: join(profileHome, ".cursor"),
        AGENT_CLI_CREDENTIAL_STORE: "file",
        NO_OPEN_BROWSER: "1",
      });
      expect(env.CURSOR_API_KEY).toBeUndefined();
      expect(nativeLoginEnv("cursor", { HOME: "/daemon/home" }).HOME).toBe("/daemon/home");
      expect(
        nativeLoginEnv("cursor", { HOME: "/daemon/home" }).AGENT_CLI_CREDENTIAL_STORE,
      ).toBeUndefined();
    } finally {
      rmSync(profileHome, { recursive: true, force: true });
    }
  });

  it("points a named agy login at the profile HOME and scrubs every Google API route", () => {
    const profiles = join(userConfigDir(), "profiles");
    mkdirSync(profiles, { recursive: true });
    const profileHome = realpathSync(mkdtempSync(join(profiles, "agy-login-")));
    try {
      // agy takes its whole config root from $HOME (no config-dir env var), so
      // HOME/USERPROFILE ARE the isolation. A poisoned parent env must not put
      // a metered API route or a sibling harness's store into the login.
      const env = nativeLoginEnv(
        "agy",
        {
          HOME: "/daemon/home",
          PATH: "/custom/bin",
          GEMINI_API_KEY: "must-scrub",
          GOOGLE_API_KEY: "must-scrub",
          GOOGLE_APPLICATION_CREDENTIALS: "/must/scrub.json",
          AGY_ADC_AUTH: "must-scrub",
          ANTHROPIC_API_KEY: "must-scrub",
          CURSOR_API_KEY: "must-scrub",
          CLAUDE_CONFIG_DIR: "/stale/scoped/claude",
          CODEX_HOME: "/stale/scoped/codex",
        },
        profileHome,
      );
      expect(env).toMatchObject({
        HOME: profileHome,
        USERPROFILE: profileHome,
        AGY_CLI_DISABLE_AUTO_UPDATE: "true",
      });
      for (const key of [
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
        "GOOGLE_APPLICATION_CREDENTIALS",
        "AGY_ADC_AUTH",
        "ANTHROPIC_API_KEY",
        "CURSOR_API_KEY",
        "CLAUDE_CONFIG_DIR",
        "CODEX_HOME",
      ]) {
        expect(env[key]).toBeUndefined();
      }
      expect(env.PATH).toContain("/custom/bin");
    } finally {
      rmSync(profileHome, { recursive: true, force: true });
    }
  });

  it("refuses an agy login with no profile HOME instead of writing into the operator's home", () => {
    // Owner decision Л-4: agy has NO default credential store. Falling through
    // would leave the daemon's own HOME in place and land a vendor token in the
    // operator's real home (INV-135).
    expect(() => nativeLoginEnv("agy", { HOME: "/daemon/home" })).toThrow(
      /no default credential store/,
    );
    // The harnesses that DO have a default store keep working unchanged.
    expect(nativeLoginEnv("codex", { HOME: "/daemon/home" }).CODEX_HOME).toBe(
      defaultNativeCodexHome(),
    );
  });
});

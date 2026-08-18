import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AuthPreference,
  ConformanceReport,
  HarnessCapabilityProfile,
  HarnessEvent,
  HarnessManifest,
  HarnessModel,
  HarnessRunSpec,
} from "@claudexor/schema";
import {
  HarnessCapabilityProfile as HarnessCapabilityProfileSchema,
  HarnessManifest as HarnessManifestSchema,
} from "@claudexor/schema";
import type { DoctorSpec, HarnessAdapter } from "@claudexor/core";
import {
  abortSignalFromSpec,
  HarnessUnavailableError,
  needsScopedHomeKeychainBridge,
  promptWithInstructions,
  providerScrubEnv,
  runCapture,
  runCliHarness as runCliHarnessDefault,
} from "@claudexor/core";
import { resolveSecret } from "@claudexor/secrets";
import { CLAUDEXOR_VERSION, nowIso, redactSecrets } from "@claudexor/util";
import { createCursorParser, parseCursorModelList, parseCursorStderrFailure } from "./parse.js";
export { parseCursorModelList } from "./parse.js";
import {
  cursorObservationAuthenticated,
  cursorObservationError,
  probeCursorNativeAuth,
  selectCursorAuthRoute,
  shouldDiscloseCursorAutoApiRoute,
  shouldSmokeCursorApiKey,
  type CursorAuthRoute,
  type CursorStatusObservation,
} from "./auth.js";
import { probeCursorDoctorForAccounts } from "./doctor.js";
import {
  probeCursorCredentialAccount,
  probeCursorCredentialProfile,
  resolveCursorRunRoute,
  stampCursorProfileEvents,
} from "./profile.js";
export { canonicalCursorProfileHome, cursorProfilePathEnv } from "./profile.js";
export {
  cursorStatusAuthenticated,
  cursorStatusLoggedOut,
  selectCursorAuthRoute,
  shouldDiscloseCursorAutoApiRoute,
} from "./auth.js";

const BIN = process.env.CLAUDEXOR_CURSOR_BIN || "cursor-agent";
// Long enough for one sequential reviewer panel pass; still bounded so revoked
// keys do not remain smoke-proven for a whole daemon lifetime.
const CURSOR_API_SMOKE_CACHE_TTL_MS = 60 * 60_000;
const CURSOR_API_SMOKE_FAILURE_CACHE_TTL_MS = 30_000;

const CURSOR_CAPABILITY_PROFILE: HarnessCapabilityProfile = HarnessCapabilityProfileSchema.parse({
  auth: {
    supported_sources: ["native_session", "api_key_env"],
    preferred_source: null,
    credential_transports: [
      // Default native auth uses the OS Keychain. Named profiles select
      // Cursor's vendor-supported file store, whose auth path is HOME/XDG/
      // APPDATA-relocatable while config/session state is relocated separately.
      { source: "native_session", kind: "os_keychain", relocatable_by: ["HOME"] },
      { source: "native_session", kind: "config_file", relocatable_by: ["HOME"] },
      { source: "api_key_env", kind: "env_var", relocatable_by: ["ENV"] },
    ],
  },
  // Ask mode is the mechanism: the CLI withholds the write/shell tools there
  // ("--mode ask ... (read-only)" per cursor-agent --help), which is a tool
  // allowlist, not a filesystem sandbox. `--sandbox enabled` alone was proven
  // NOT to enforce readonly: a print-mode agent run "has access to all tools,
  // including write and shell", and a live probe wrote a file through it.
  access_control: { readonly_mechanism: "tool_allowlist" },
  isolation: {
    supported_containment: ["scoped_home_keychain_bridge", "env_or_file_injection"],
  },
  attachment_inputs: [],
});

// Ask + sandbox bound readonly; force approves optional native web unless it is off.
function accessArgs(spec: HarnessRunSpec): string[] {
  if (spec.access === "readonly") {
    const force = spec.external_context_policy === "off" ? [] : ["--force"];
    return [...force, "--sandbox", "enabled", "--trust"];
  }
  if (spec.access === "workspace_write") return ["--force", "--sandbox", "enabled", "--trust"];
  if (spec.access === "inherit_native") return ["--trust"];
  return ["--force", "--sandbox", "disabled", "--trust"];
}

async function detectVersion(abortSignal?: AbortSignal): Promise<string | null> {
  try {
    const r = await runCapture(BIN, ["--version"], {
      timeoutMs: 10_000,
      abortSignal,
      cancelSignal: "SIGTERM",
      cancelKillDelayMs: 0,
    });
    return r.stdout.trim() || `${BIN} (version unknown)`;
  } catch {
    return null;
  }
}

function cursorApiKey(env?: Record<string, string | null | undefined>): string | null {
  if (env && Object.prototype.hasOwnProperty.call(env, "CLAUDEXOR_CURSOR_API_KEY"))
    return env["CLAUDEXOR_CURSOR_API_KEY"] || null;
  if (env && Object.prototype.hasOwnProperty.call(env, "CURSOR_API_KEY"))
    return env["CURSOR_API_KEY"] || null;
  return (
    process.env.CLAUDEXOR_CURSOR_API_KEY ||
    resolveSecret("cursor") ||
    process.env.CURSOR_API_KEY ||
    null
  );
}

type EnvMap = Record<string, string | null | undefined>;
type CursorApiSmokeResult = { ok: boolean; detail: string };
/** The route did not need (or could not run) the isolated key smoke. */
const unsmokedApiSmoke = (key: string | null): CursorApiSmokeResult => ({
  ok: false,
  detail: key ? "Cursor API-key smoke not required for selected route" : "no Cursor API key",
});
type CursorApiSmokeCacheEntry = { result: CursorApiSmokeResult; expiresAtMs: number };
type CursorApiSmokeOptions = {
  makeBaseDir?: () => string;
  runCapture?: typeof runCapture;
  cleanupBase?: typeof cleanupCursorSmokeBase;
};
type CursorRuntimeDeps = {
  detectVersion: typeof detectVersion;
  nativeAuthOk: typeof probeCursorNativeAuth;
  cursorApiKey: typeof cursorApiKey;
  listCursorModels: typeof listCursorModels;
  smokeIsolatedApiKey: typeof smokeIsolatedApiKey;
  apiSmokeCache: Map<string, CursorApiSmokeCacheEntry>;
  apiSmokeCacheTtlMs: number;
  apiSmokeFailureCacheTtlMs: number;
  nowMs: () => number;
  runCliHarness: typeof runCliHarnessDefault;
  /** INV-062: profile secrets are resolved transiently, never logged. */
  resolveProfileSecret: (ref: string) => string | null;
};

export function cursorApiSmokeFinalText(stdout: string): string | null {
  const replies: string[] = [];
  for (const rawLine of stdout.replaceAll("\r", "").split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object") continue;
    const record = obj as Record<string, unknown>;
    if (record["type"] === "assistant") {
      const message = record["message"];
      const content =
        message && typeof message === "object"
          ? (message as Record<string, unknown>)["content"]
          : undefined;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const text = (block as Record<string, unknown>)["text"];
        if (typeof text === "string" && text.trim()) replies.push(text);
      }
    } else if (record["type"] === "result") {
      const result = record["result"];
      if (typeof result === "string" && result.trim()) replies.push(result);
    }
  }
  return replies.at(-1)?.trim() ?? null;
}

export function cursorApiSmokeUsedEnvKey(stdout: string): boolean {
  for (const rawLine of stdout.replaceAll("\r", "").split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object") continue;
    const record = obj as Record<string, unknown>;
    if (record["type"] === "system" && record["apiKeySource"] === "env") return true;
  }
  return false;
}

export function cursorApiSmokePassed(code: number | null, stdout: string): boolean {
  return code === 0 && cursorApiSmokeUsedEnvKey(stdout) && cursorApiSmokeFinalText(stdout) === "OK";
}

export async function cleanupCursorSmokeBase(
  base: string,
  opts: {
    remove?: (path: string) => void;
    sleepMs?: (ms: number) => Promise<void>;
    retries?: number;
  } = {},
): Promise<void> {
  const remove = opts.remove ?? ((path: string) => rmSync(path, { recursive: true, force: true }));
  const sleepMs =
    opts.sleepMs ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const retries = opts.retries ?? 2;
  for (let attempt = 0; ; attempt += 1) {
    try {
      remove(base);
      return;
    } catch {
      if (attempt >= retries) return;
      await sleepMs(25 * (attempt + 1));
    }
  }
}

function bridgeMacLoginKeychain(home: string): void {
  if (process.platform !== "darwin") return;
  const realHome = process.env.HOME;
  if (!realHome || realHome === home) return;
  const source = join(realHome, "Library", "Keychains");
  if (!existsSync(source)) return;
  const targetParent = join(home, "Library");
  const target = join(targetParent, "Keychains");
  if (existsSync(target)) return;
  try {
    mkdirSync(targetParent, { recursive: true, mode: 0o700 });
    symlinkSync(source, target, "dir");
  } catch {
    // The smoke will fail honestly if the OS credential bridge cannot be created.
  }
}

export async function smokeIsolatedApiKey(
  key: string | null = cursorApiKey(),
  options: CursorApiSmokeOptions = {},
): Promise<CursorApiSmokeResult> {
  if (!key) return { ok: false, detail: "no Cursor API key" };
  const base = options.makeBaseDir?.() ?? mkdtempSync(join(tmpdir(), "claudexor-cursor-smoke-"));
  const home = join(base, "home");
  try {
    mkdirSync(join(home, ".config"), { recursive: true, mode: 0o700 });
    bridgeMacLoginKeychain(home);
    const env: Record<string, string | null> = {
      ...providerScrubEnv(),
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      CURSOR_API_KEY: key,
    };
    const r = await (options.runCapture ?? runCapture)(
      BIN,
      ["-p", "--output-format", "stream-json", "--mode", "plan", "--trust", "Reply exactly OK"],
      {
        env,
        timeoutMs: 45_000,
      },
    );
    const text = `${r.stdout}\n${r.stderr}`;
    if (cursorApiSmokePassed(r.code, r.stdout))
      return { ok: true, detail: "isolated cursor-agent API-key smoke passed" };
    return {
      ok: false,
      detail: `isolated cursor-agent API-key smoke failed (exit ${r.code ?? "signal"}): ${redactSecrets(text).trim().split("\n").slice(-3).join(" ").slice(0, 500)}`,
    };
  } catch (err) {
    return {
      ok: false,
      detail: `isolated cursor-agent API-key smoke failed (${err instanceof Error ? err.message.split("\n")[0] : String(err)})`,
    };
  } finally {
    await (options.cleanupBase ?? cleanupCursorSmokeBase)(base);
  }
}

function cursorApiSmokeCacheKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

async function smokeCursorApiKey(
  deps: CursorRuntimeDeps,
  key: string,
  fresh = false,
): Promise<CursorApiSmokeResult> {
  const cacheKey = cursorApiSmokeCacheKey(key);
  const now = deps.nowMs();
  const cached = fresh ? undefined : deps.apiSmokeCache.get(cacheKey);
  if (cached && cached.expiresAtMs > now) return cached.result;
  if (cached) deps.apiSmokeCache.delete(cacheKey);
  const result = await deps.smokeIsolatedApiKey(key);
  const ttlMs = result.ok ? deps.apiSmokeCacheTtlMs : deps.apiSmokeFailureCacheTtlMs;
  if (!fresh && ttlMs > 0) deps.apiSmokeCache.set(cacheKey, { result, expiresAtMs: now + ttlMs });
  return result;
}

async function listCursorModels(env: EnvMap = { ...providerScrubEnv() }): Promise<HarnessModel[]> {
  try {
    const r = await runCapture(BIN, ["--list-models"], { env, timeoutMs: 30_000 });
    if (r.code !== 0) return [];
    return parseCursorModelList(r.stdout);
  } catch {
    return [];
  }
}

function cursorBaseEnv(env?: EnvMap): EnvMap {
  return { ...(env ?? {}), ...providerScrubEnv() };
}

function cursorNativeEnv(env?: EnvMap): EnvMap {
  return { ...cursorBaseEnv(env), CURSOR_API_KEY: null };
}

function maybeBridgeScopedHome(env: EnvMap): void {
  const home = env["HOME"];
  if (home && needsScopedHomeKeychainBridge(CURSOR_CAPABILITY_PROFILE))
    bridgeMacLoginKeychain(home);
}

async function resolveCursorAuthRoute(
  deps: CursorRuntimeDeps,
  input: {
    env?: Record<string, string | null | undefined>;
    authPreference?: AuthPreference;
    fresh?: boolean;
    abortSignal?: AbortSignal;
    bridgeNativeSession?: boolean;
  },
): Promise<{
  route: CursorAuthRoute;
  env: EnvMap;
  key: string | null;
  nativeAuthed: boolean;
  scopedHome: boolean;
}> {
  const env = cursorBaseEnv(input.env);
  const scopedHome = Boolean(input.env?.["HOME"]);
  if (scopedHome && input.bridgeNativeSession !== false) maybeBridgeScopedHome(env);
  const authPreference = input.authPreference ?? "auto";
  const key = authPreference === "subscription" ? null : deps.cursorApiKey(input.env);
  const nativeProbe =
    authPreference === "api_key"
      ? ({ kind: "loggedOut" } satisfies CursorStatusObservation)
      : await deps.nativeAuthOk(env, input.abortSignal);
  const nativeAuthed = cursorObservationAuthenticated(nativeProbe);
  const nativeProbeError = cursorObservationError(nativeProbe);
  const shouldSmokeApiKey = shouldSmokeCursorApiKey({
    hasKey: Boolean(key),
    authPreference,
    nativeAuthed,
    nativeProbeError,
  });
  const apiSmoke =
    shouldSmokeApiKey && key
      ? await smokeCursorApiKey(deps, key, input.fresh === true)
      : unsmokedApiSmoke(key);
  const route = selectCursorAuthRoute({
    authPreference,
    hasKey: Boolean(key),
    apiKeyReady: apiSmoke.ok,
    nativeAuthed,
    scopedHome,
  });
  return { route, env, key, nativeAuthed, scopedHome };
}

async function listCursorModelsFromReadyRoute(
  deps: CursorRuntimeDeps,
  spec?: DoctorSpec,
): Promise<HarnessModel[]> {
  const catalogOnly = () => {
    const key = deps.cursorApiKey(spec?.env);
    return deps.listCursorModels({
      ...providerScrubEnv(),
      CURSOR_API_KEY: key ?? null,
    });
  };
  if (spec?.env || spec?.authPreference || spec?.fresh) {
    const authPreference = spec.authPreference ?? "auto";
    const resolved = await resolveCursorAuthRoute(deps, {
      env: spec.env,
      authPreference,
      fresh: spec?.fresh,
      abortSignal: spec?.abortSignal,
    });
    if (resolved.route === "local_session") {
      const models = await deps.listCursorModels({ ...resolved.env, CURSOR_API_KEY: null });
      if (models.length > 0) return models;
      if (authPreference === "subscription") return [];
    }
    if (resolved.route === "api_key" && resolved.key) {
      const models = await deps.listCursorModels({ ...resolved.env, CURSOR_API_KEY: resolved.key });
      if (models.length > 0) return models;
    }
    return [];
  }
  const nativeEnv = cursorNativeEnv();
  const nativeProbe = await deps.nativeAuthOk(nativeEnv, spec?.abortSignal);
  if (cursorObservationAuthenticated(nativeProbe)) {
    const nativeModels = await deps.listCursorModels(nativeEnv);
    if (nativeModels.length > 0) return nativeModels;
  }
  if (cursorObservationError(nativeProbe)) return [];
  const key = deps.cursorApiKey();
  if (!key) return catalogOnly();
  const apiSmoke = await smokeCursorApiKey(deps, key, spec?.fresh === true);
  if (apiSmoke.ok) {
    const models = await deps.listCursorModels({ ...providerScrubEnv(), CURSOR_API_KEY: key });
    if (models.length > 0) return models;
  }
  return catalogOnly();
}

export function createCursorAdapter(deps: Partial<CursorRuntimeDeps> = {}): HarnessAdapter {
  const runtime: CursorRuntimeDeps = {
    detectVersion,
    nativeAuthOk: probeCursorNativeAuth,
    cursorApiKey,
    listCursorModels,
    smokeIsolatedApiKey,
    apiSmokeCache: new Map(),
    apiSmokeCacheTtlMs: CURSOR_API_SMOKE_CACHE_TTL_MS,
    apiSmokeFailureCacheTtlMs: CURSOR_API_SMOKE_FAILURE_CACHE_TTL_MS,
    nowMs: () => Date.now(),
    runCliHarness: runCliHarnessDefault,
    resolveProfileSecret: (ref) => resolveSecret(ref),
    ...deps,
  };
  const doctorForAccounts = (spec: DoctorSpec) =>
    probeCursorDoctorForAccounts(spec, {
      detectVersion: runtime.detectVersion,
      nativeAuthOk: runtime.nativeAuthOk,
      cursorApiKey: runtime.cursorApiKey,
      smokeApiKey: (key, fresh) => smokeCursorApiKey(runtime, key, fresh),
      nativeEnv: cursorNativeEnv,
      bridgeScopedHome: maybeBridgeScopedHome,
    });
  return {
    id: "cursor",

    async discover(): Promise<HarnessManifest> {
      const version = await runtime.detectVersion();
      if (version === null) {
        throw new HarnessUnavailableError(
          "cursor-agent not found on PATH (set CLAUDEXOR_CURSOR_BIN)",
        );
      }
      const nativeProbe = await runtime.nativeAuthOk(cursorNativeEnv());
      const nativeAuthed = cursorObservationAuthenticated(nativeProbe);
      const apiKey = runtime.cursorApiKey() !== null;
      return HarnessManifestSchema.parse({
        id: "cursor",
        display_name: "Cursor CLI",
        kind: "local_cli",
        version,
        adapter_version: CLAUDEXOR_VERSION,
        provider_family: "cursor",
        capabilities: {
          plan: true,
          implement: true,
          create_from_scratch: true,
          review: true,
          verify: true,
          synthesize: true,
          read_files: true,
          // No browser-MCP injection path exists for cursor-agent yet —
          // honest false until that path exists + is verified.
          browser_tool: false,
          web_policy: "uncontrolled",
          // D-16: cursor has no native json_schema_output; the WorkReport rides
          // a terminal fenced metadata block validated off the final message,
          // while the preceding markdown remains the deliverable.
          work_report_transport: "validated",
          structured_output_channel: "final_message",
          // cursor-agent exposes no reasoning-effort flag -> effort is not tunable.
          effort_levels: [],
        },
        capability_profile: {
          ...CURSOR_CAPABILITY_PROFILE,
          auth: {
            ...CURSOR_CAPABILITY_PROFILE.auth,
            // Native-first is invariant across host and scoped environments;
            // a key becomes auto fallback only after native is unavailable.
            preferred_source: nativeAuthed ? "native_session" : apiKey ? "api_key_env" : null,
          },
        },
        // Source AVAILABILITY truth: each mode is listed only when its source
        // actually exists right now (a native session does not imply a key).
        auth_modes: [
          ...(nativeAuthed ? ["local_session" as const] : []),
          ...(apiKey ? ["api_key" as const] : []),
        ],
        // external_sandbox_full: cursor's own sandbox stands down (--force
        // --sandbox disabled), mirroring codex/claude; the engine applies its
        // own OS boundary only on delegated runs. Bare `full` stays
        // undeclared/refused (no boundary, not proven).
        access_profiles_supported: [
          "readonly",
          "workspace_write",
          "external_sandbox_full",
          "inherit_native",
        ],
      });
    },

    async doctor(spec: DoctorSpec): Promise<ConformanceReport> {
      return (await doctorForAccounts(spec)).report;
    },

    doctorForAccounts,

    run(spec: HarnessRunSpec): AsyncIterable<HarnessEvent> {
      return runCursor(spec, runtime);
    },

    review(spec: HarnessRunSpec): AsyncIterable<HarnessEvent> {
      return runCursor(spec, runtime);
    },

    async models(spec?: DoctorSpec): Promise<HarnessModel[]> {
      return listCursorModelsFromReadyRoute(runtime, spec);
    },

    async probeCredentialProfile(profile, abortSignal) {
      return probeCursorCredentialProfile(profile, runtime, abortSignal);
    },

    async probeCredentialAccount(profile, abortSignal) {
      return probeCursorCredentialAccount(profile, runtime, abortSignal);
    },
  };
}

async function* runCursor(
  spec: HarnessRunSpec,
  deps: CursorRuntimeDeps,
): AsyncIterable<HarnessEvent> {
  // Bare `full` claims NO boundary at all and stays refused (unproven).
  // `external_sandbox_full` stands cursor's weaker sandbox down (`--force
  // --sandbox disabled` via accessArgs) — the same mapping codex
  // (danger-full-access) and claude (bypassPermissions) implement. The engine
  // applies its OWN OS boundary only on delegated runs; requested directly,
  // this profile runs unrestricted (and is not behind the trust allow).
  if (spec.access === "full") {
    yield {
      type: "error",
      session_id: spec.session_id,
      ts: nowIso(),
      error:
        "cursor full access is not conformance-proven; use workspace_write, or external_sandbox_full (cursor's sandbox stands down; the engine applies its own boundary only on delegated runs — otherwise unrestricted)",
    };
    yield { type: "completed", session_id: spec.session_id, ts: nowIso() };
    return;
  }
  const args = ["-p", "--output-format", "stream-json", ...accessArgs(spec)];
  // Native Plan's createPlan schema cannot carry D-16 WorkReport; native read-only
  // Ask preserves prompt-owned plan intent and the model-authored final report.
  // `readonly` access rides the SAME mode: Ask is the only mechanism this CLI
  // has that actually withholds the write/shell tools. Without it a readonly
  // run is a full agent run — `--sandbox enabled` gates commands, not file
  // edits (proven by a live probe: the agent created a file under exactly the
  // previous readonly argv).
  if (spec.intent === "plan" || spec.access === "readonly") args.push("--mode", "ask");
  // W-C4 live deltas (engine-gated; the parser applies the documented taxonomy).
  if (spec.stream_deltas) args.push("--stream-partial-output");
  if (spec.model_hint) args.push("--model", spec.model_hint);
  // Resume the thread's native cursor chat as a follow-up turn.
  if (spec.resume_session_id) args.push("--resume", spec.resume_session_id);
  // Cursor has no native system-prompt flag; layer instructions as a delimited
  // prompt prefix (the engine already withheld them from synthesis/reviewers).
  args.push(promptWithInstructions(spec));
  // INV-135 strict profile routing lives in profile.ts; the callback resolves
  // the engine-default credential ladder for profile-less (or API-key) runs.
  const profile = spec.credential_profile;
  const resolved = await resolveCursorRunRoute(
    spec,
    deps,
    ({ cursorApiKey, ...input }) =>
      resolveCursorAuthRoute(cursorApiKey ? { ...deps, cursorApiKey } : deps, input),
    abortSignalFromSpec(spec),
  );
  if ("refusal" in resolved) {
    yield { type: "error", session_id: spec.session_id, ts: nowIso(), error: resolved.refusal };
    yield { type: "completed", session_id: spec.session_id, ts: nowIso() };
    return;
  }
  const { route, env, key, nativeAuthed, scopedHome } = resolved;
  if (route === "api_key" && key) {
    env.CURSOR_API_KEY = key;
    if (
      shouldDiscloseCursorAutoApiRoute({
        authPreference: spec.auth_preference,
        route,
        nativeAuthed,
      })
    ) {
      yield {
        type: "message",
        session_id: spec.session_id,
        ts: nowIso(),
        payload: {
          auth_switched: true,
          from_auth_mode: "local_session",
          to_auth_mode: "api_key",
          reason: "readiness_preferred",
        },
      };
    }
  } else if (route === "local_session") {
    env.CURSOR_API_KEY = null;
  } else {
    yield {
      type: "error",
      session_id: spec.session_id,
      ts: nowIso(),
      error: profile
        ? `credential profile "${profile.profile_id}": the Cursor API-key smoke did not pass for its stored key`
        : scopedHome
          ? "scoped Cursor HOME requires either a bridged native session or a smoke-proven Cursor API key fallback"
          : "Cursor requires either a native session or a smoke-proven Cursor API key fallback",
    };
    yield { type: "completed", session_id: spec.session_id, ts: nowIso() };
    return;
  }
  const cursorParser = createCursorParser(
    route === "local_session" ? "vendor_native" : "managed_api_key",
    route === "local_session" ? "native_session" : "api_key_env",
    spec.intent === "plan",
    false,
    spec.model_hint,
  );
  yield* deps.runCliHarness({
    bin: BIN,
    args,
    spec,
    env,
    label: "cursor-agent",
    redact: redactSecrets,
    parseEvent: stampCursorProfileEvents(profile, cursorParser),
    parseStderrFailure: (m, s) => parseCursorStderrFailure(m, s, spec.model_hint, profile),
  });
}

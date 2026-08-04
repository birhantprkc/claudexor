#!/usr/bin/env node
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ProcessGroupService, defaultProcessGroupService } from "@claudexor/core";
import { redactSecrets } from "@claudexor/util";
import {
  startCodexDeviceLogin,
  type CodexAppServerConnection,
  type JsonRpcFrame,
} from "./codex-device-login.js";
import { terminateAppServerChild } from "./setup-login-child-lifecycle.js";
export { terminateAppServerChild } from "./setup-login-child-lifecycle.js";
import { nativeLoginEnv } from "./native-login.js";
import { waitForSetupLoginPermit } from "./setup-login-permit.js";
import {
  SETUP_LOGIN_PROTOCOL_VERSION,
  atomicPrivateJson,
  readLoginManifest,
  verifyExecutableEvidence,
  type SetupLoginManifest,
  type SetupLoginPermit,
  type SetupLoginRunnerResult,
  type SetupLoginRunnerState,
} from "./setup-login-protocol.js";

export interface SetupLoginRunnerOptions {
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  spawnProcess?: typeof spawn;
  processGroupService?: ProcessGroupService;
  selfPid?: number;
  runnerPath?: string;
}

/**
 * Terminal-visible bootstrap. It creates a detached worker process group and
 * waits for that worker, but the worker cannot start the vendor command until
 * claudexord has durably recorded its exact group handle and issued a permit.
 */
export async function runSetupLogin(
  manifestPath: string,
  options: SetupLoginRunnerOptions = {},
): Promise<number> {
  const manifest = validateManifest(manifestPath);
  const spawnProcess = options.spawnProcess ?? spawn;
  const runnerPath = options.runnerPath ?? fileURLToPath(import.meta.url);
  const worker = spawnProcess(process.execPath, [runnerPath, "--worker", resolve(manifestPath)], {
    cwd: manifest.cwd,
    env: runnerBootstrapEnv(),
    detached: true,
    stdio: "inherit",
  });
  const result = await waitForExit(worker);
  return result.code === 0 && result.signal === null ? 0 : 1;
}

/** Worker entrypoint. Exported so the permit ordering can be fault-injected. */
export async function runSetupLoginWorker(
  manifestPath: string,
  options: SetupLoginRunnerOptions = {},
): Promise<number> {
  const manifest = validateManifest(manifestPath);
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? ((ms) => new Promise<void>((done) => setTimeout(done, ms)));
  const spawnProcess = options.spawnProcess ?? spawn;
  const processGroups = options.processGroupService ?? defaultProcessGroupService;
  const captured = processGroups.captureLeader(options.selfPid ?? process.pid);
  if (captured.status !== "known") {
    throw new Error(
      captured.status === "missing"
        ? "setup-login worker disappeared before its process group could be captured"
        : `setup-login worker process-group identity is unprovable: ${captured.reason}`,
    );
  }

  const observedAt = now().toISOString();
  const awaitingPermit: SetupLoginRunnerState = {
    version: SETUP_LOGIN_PROTOCOL_VERSION,
    jobId: manifest.jobId,
    executionId: manifest.executionId,
    processGroup: captured.handle,
    stage: "awaiting_permit",
    observedAt,
    commandDigest: manifest.commandDigest,
    manifestDigest: manifest.manifestDigest,
  };
  atomicPrivateJson(manifest.statePath, awaitingPermit);

  const permit = await waitForSetupLoginPermit(manifest, now, sleep, observedAt);
  if (!permit) {
    persistFailure(manifest, now, null, "permit_timeout");
    return 1;
  }

  if (!verifyExecutableEvidence(manifest.executable)) {
    persistFailure(manifest, now, permit.issuedAt, "spawn_failed");
    return 1;
  }

  atomicPrivateJson(manifest.statePath, { ...awaitingPermit, stage: "running" });

  // D-17 primary flow: host the codex app-server and drive typed device-code
  // auth (no Terminal). The app-server child shares this detached worker's
  // process group, so every restart/permit/termination evidence semantic is
  // unchanged from the Terminal path.
  if (manifest.loginMode === "device_code") {
    return runDeviceCodeLogin(manifest, permit, { now, spawnProcess });
  }

  // Device-auth capability gate (v3.0.3 S6): `--device-auth` exists only
  // since codex 0.46.0. Probe the vendor's own `login --help` BEFORE spawning
  // so an old CLI yields a typed unsupported outcome instead of an opaque
  // argv error. The probe fails OPEN — a broken probe falls through to the
  // real spawn, whose own failure carries the diagnostics.
  if (manifest.args.includes("--device-auth")) {
    const probe = await probeLoginHelp(
      manifest.binary,
      spawnProcess,
      nativeLoginEnv(manifest.harness, process.env, manifest.profileConfigDir),
    );
    if (probe.completed && !probe.output.includes("--device-auth")) {
      persistFailure(
        manifest,
        now,
        permit.issuedAt,
        "device_auth_unsupported",
        boundedTail(probe.output),
      );
      return 1;
    }
  }

  // Keep the group leader alive through TERM so the daemon can still prove
  // identity and escalate a stubborn descendant with KILL after the grace
  // period. The vendor child receives the same group signal directly.
  const holdLeaderForEscalation = () => undefined;
  process.on("SIGTERM", holdLeaderForEscalation);
  process.on("SIGINT", holdLeaderForEscalation);
  // Tee the codex login's output (v3.0.3 S6): the user still sees the URL +
  // one-time code in Terminal, while a bounded ANSI-stripped tail rides the
  // result so the daemon can classify failures (e.g. the ChatGPT
  // "Allow device code login" toggle being off) instead of a bare exit code.
  //
  // A manifest carrying deviceCodePath tees for a second reason: the runner
  // captures the vendor login's OAuth URL from that same output and writes it
  // as a STRUCTURED `oauth_url` disclosure sidecar — the codex device-code
  // card shape, URL-only — so a UI can render "open this link" without a
  // terminal. stdin stays inherited and every byte is still forwarded, so the
  // vendor CLI completes its flow exactly as before; the one honest residual
  // is that the CLI sees a pipe (not a TTY) on stdout, the same tradeoff the
  // codex tail tee already made.
  const teeOutput = manifest.harness === "codex" || manifest.deviceCodePath !== undefined;
  const tail = createTailBuffer();
  const urlDetector = createOAuthUrlDetector();
  const discloseOAuthUrl = (chunk: Buffer): void => {
    if (!manifest.deviceCodePath) return;
    const url = urlDetector.push(chunk);
    if (!url) return;
    try {
      // Same transient-sidecar discipline as the device-code flow: the URL
      // rides ONLY this read-time projection file, never the durable receipt.
      atomicPrivateJson(manifest.deviceCodePath, {
        version: SETUP_LOGIN_PROTOCOL_VERSION,
        jobId: manifest.jobId,
        executionId: manifest.executionId,
        flow: "oauth_url",
        verificationUrl: url,
        userCode: "",
        disclosedAt: now().toISOString(),
      });
    } catch {
      // The disclosure is best-effort context; it must never kill the login.
    }
  };
  // A spawn throw and a wait rejection already wrote the SAME receipt, so they
  // share one catch; de-registering the hold handlers is the one thing all
  // three exits do (both failures and success), so it is the finally.
  let result: { code: number | null; signal: NodeJS.Signals | null };
  try {
    const spawnOptions: SpawnOptions = {
      cwd: manifest.cwd,
      // A sealed profileConfigDir (INV-135) scopes the vendor login to the
      // profile's own store; absent = the default vendor store as before.
      env: nativeLoginEnv(manifest.harness, process.env, manifest.profileConfigDir),
      detached: false,
      stdio: teeOutput ? ["inherit", "pipe", "pipe"] : "inherit",
    };
    const child = spawnProcess(manifest.binary, manifest.args, spawnOptions);
    if (teeOutput) {
      const tee = (sink: NodeJS.WriteStream) => (chunk: Buffer) => {
        sink.write(chunk);
        tail.push(chunk);
        discloseOAuthUrl(chunk);
      };
      child.stdout?.on("data", tee(process.stdout));
      child.stderr?.on("data", tee(process.stderr));
    }
    result = await waitForExit(child);
  } catch {
    persistFailure(manifest, now, permit.issuedAt, "spawn_failed");
    return 1;
  } finally {
    process.off("SIGTERM", holdLeaderForEscalation);
    process.off("SIGINT", holdLeaderForEscalation);
  }
  const capturedTail = tail.text();
  persistResult(manifest, {
    permitIssuedAt: permit.issuedAt,
    commandStarted: true,
    exitCode: result.code,
    signal: result.signal,
    finishedAt: now().toISOString(),
    ...(capturedTail && (result.code !== 0 || result.signal !== null)
      ? { outputTail: capturedTail }
      : {}),
  });
  return result.code === 0 && result.signal === null ? 0 : 1;
}

/**
 * D-17 device-code login: host `codex app-server --stdio`, drive the typed
 * device-code handshake, and write the transient disclosure sidecar (the
 * one-time code lives ONLY there and is never persisted to the result receipt).
 * Completion → exit 0 (the daemon then runs the unchanged native verification);
 * a capability probe miss → `device_auth_unsupported` (the daemon demotes to
 * the typed Terminal fallback, no stdout regex).
 */
async function runDeviceCodeLogin(
  manifest: SetupLoginManifest,
  permit: SetupLoginPermit,
  deps: { now: () => Date; spawnProcess: typeof spawn },
): Promise<number> {
  const { now, spawnProcess } = deps;
  if (!manifest.deviceCodePath || !manifest.appServerFlow) {
    persistFailure(manifest, now, permit.issuedAt, "spawn_failed");
    return 1;
  }
  let child: ChildProcess;
  try {
    child = spawnProcess(manifest.binary, manifest.args, {
      cwd: manifest.cwd,
      env: nativeLoginEnv(manifest.harness, process.env, manifest.profileConfigDir),
      detached: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    persistFailure(manifest, now, permit.issuedAt, "spawn_failed");
    return 1;
  }
  child.stderr?.resume();
  const connection = appServerConnection(child);
  const abort = new AbortController();
  const onSignal = () => abort.abort();
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  try {
    const start = await startCodexDeviceLogin(connection, {
      flow: manifest.appServerFlow,
      signal: abort.signal,
    });
    if (start.kind === "not_supported") {
      await terminateAppServerChild(child, connection);
      // Typed capability-probe miss: reuse the existing not_supported outcome
      // so the daemon offers the legacy Terminal fallback (no stdout regex).
      persistFailure(manifest, now, permit.issuedAt, "device_auth_unsupported");
      return 1;
    }
    // Transient disclosure sidecar. The userCode rides ONLY this file (read-time
    // snapshot projection); it never enters the result receipt or the journal.
    atomicPrivateJson(manifest.deviceCodePath, {
      version: SETUP_LOGIN_PROTOCOL_VERSION,
      jobId: manifest.jobId,
      executionId: manifest.executionId,
      flow: manifest.appServerFlow,
      verificationUrl: start.disclosure.verificationUrl,
      userCode: start.disclosure.userCode,
      disclosedAt: now().toISOString(),
    });
    const outcome = await start.awaitCompletion();
    await terminateAppServerChild(child, connection);
    const exitCode = outcome.kind === "completed" ? 0 : 1;
    persistResult(manifest, {
      permitIssuedAt: permit.issuedAt,
      commandStarted: true,
      exitCode,
      signal: null,
      finishedAt: now().toISOString(),
      ...(outcome.kind === "failed" ? { outputTail: boundedTail(outcome.detail) } : {}),
    });
    return exitCode;
  } catch (error) {
    await terminateAppServerChild(child, connection);
    persistResult(manifest, {
      permitIssuedAt: permit.issuedAt,
      commandStarted: true,
      exitCode: 1,
      signal: null,
      finishedAt: now().toISOString(),
      outputTail: boundedTail(error instanceof Error ? error.message : String(error)),
    });
    return 1;
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  }
}

/** Adapt a `codex app-server --stdio` child to the device-login transport seam
 * (line-delimited JSON-RPC over the child's stdio). */
function appServerConnection(child: ChildProcess): CodexAppServerConnection {
  const lines = createInterface({ input: child.stdout! });
  let frameHandler: ((frame: JsonRpcFrame) => void) | null = null;
  const closeHandlers: Array<(error?: Error) => void> = [];
  lines.on("line", (line) => {
    let frame: JsonRpcFrame;
    try {
      frame = JSON.parse(line) as JsonRpcFrame;
    } catch {
      return; // Vendor diagnostics are not protocol authority.
    }
    frameHandler?.(frame);
  });
  const closeWith = (error: Error) => {
    for (const handler of closeHandlers) handler(error);
  };
  child.once("exit", (code, signal) =>
    closeWith(new Error(`codex app-server exited: code=${String(code)} signal=${String(signal)}`)),
  );
  child.once("error", (error) => closeWith(error));
  child.stdin?.on("error", () => undefined);
  return {
    send(frame) {
      child.stdin?.write(`${JSON.stringify(frame)}\n`);
    },
    onFrame(handler) {
      frameHandler = handler;
    },
    onClose(handler) {
      closeHandlers.push(handler);
    },
    close() {
      try {
        child.stdin?.end();
      } catch {
        /* best-effort */
      }
    },
  };
}

const OUTPUT_TAIL_BYTES = 4096;

/**
 * OAuth-URL capture for TERMINAL-mode logins (claude/cursor, and codex's
 * legacy fallback): the vendor CLI prints its sign-in URL to its own output;
 * detecting it lets the runner surface a STRUCTURED `oauth_url` disclosure on
 * the job — the same sidecar + card shape as codex's device-code flow — so a
 * UI can render "open this link" with no terminal. Bounded rolling window: a
 * URL split across chunks is still caught, memory stays capped.
 */
const OAUTH_URL_SCAN_WINDOW = 8_192;

// eslint-disable-next-line no-control-regex
const TERM_ESCAPE_RE = /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?)/g;
// eslint-disable-next-line no-control-regex
const C0_CONTROL_RE = /[\u0000-\u0009\u000b-\u001f\u007f]/g;

const OAUTH_URL_SIGNATURE_RE =
  /(oauth|authori[sz]e|login|sign[-_]?in|device|sso|verification|callback)/i;

/**
 * First OAuth/sign-in URL in a chunk of vendor CLI output, or null. Terminal
 * escapes are stripped FIRST so a color reset cannot glue itself onto the URL;
 * trailing prose punctuation is trimmed. Only URLs carrying a sign-in-shaped
 * signature qualify — a docs link in a banner must not become "the" login URL.
 */
export function extractOAuthUrl(text: string): string | null {
  const plain = text.replace(TERM_ESCAPE_RE, "").replace(C0_CONTROL_RE, "");
  for (const match of plain.matchAll(/https:\/\/[^\s"'<>()[\]]+/g)) {
    const url = match[0].replace(/[.,;:!?]+$/, "");
    if (OAUTH_URL_SIGNATURE_RE.test(url)) return url;
  }
  return null;
}

/**
 * Stateful per-login detector: feeds chunks into a bounded window and reports
 * the first qualifying URL exactly once (a login prints its URL once; re-prints
 * and later noise must not rewrite the disclosure).
 */
export function createOAuthUrlDetector(): { push(chunk: Buffer): string | null } {
  let window = "";
  let found = false;
  return {
    push(chunk) {
      if (found) return null;
      window = (window + chunk.toString("utf8")).slice(-OAUTH_URL_SCAN_WINDOW);
      const url = extractOAuthUrl(window);
      if (!url) return null;
      found = true;
      return url;
    },
  };
}

/** Ring buffer of the last OUTPUT_TAIL_BYTES of tee'd vendor output. */
export function createTailBuffer(): { push(chunk: Buffer): void; text(): string } {
  // Byte-accurate ring: keep the final OUTPUT_TAIL_BYTES RAW bytes and decode
  // ONCE in text() — a per-chunk String() decode splits multibyte UTF-8 into
  // replacement chars and a UTF-16 .slice miscounts the byte bound.
  let tail = Buffer.alloc(0);
  // Whether the stream ever exceeded the ring — the truncation signal cannot
  // be recovered from the decoded string's length (already <= the byte cap),
  // so track it HERE and hand it to boundedTail (X224 ring-path fix).
  let overflowed = false;
  return {
    push(chunk) {
      const combined = Buffer.concat([tail, chunk]);
      if (combined.length > OUTPUT_TAIL_BYTES) overflowed = true;
      tail = combined.subarray(-OUTPUT_TAIL_BYTES);
    },
    text() {
      // The ring can start mid-codepoint: drop leading continuation bytes
      // (0b10xxxxxx) so the decode never opens with a replacement char.
      let start = 0;
      while (start < tail.length && (tail[start]! & 0b1100_0000) === 0b1000_0000) start += 1;
      return boundedTail(tail.subarray(start).toString("utf8"), overflowed || start > 0);
    },
  };
}

/** Strip terminal escapes (CSI, OSC, bare ESC, C0 controls except newline),
 * redact secret-like tokens, and clamp - diagnostic evidence entering a
 * durable journal/API surface, never a raw vendor log copy (INV-062). */
export function boundedTail(text: string, truncated = false): string {
  const plain = text.replace(TERM_ESCAPE_RE, "").replace(C0_CONTROL_RE, "");
  // Redact the complete sanitized input before any boundary is selected. A
  // tail-first clamp can retain only the suffix of a token and thereby remove
  // the prefix the detector needs to recognize it.
  const redacted = redactSecrets(plain);
  // When the source was truncated at the front (ring overflow, or a
  // direct-string caller over the byte budget), a secret split by that
  // boundary could leave a prefix-less fragment redactSecrets cannot anchor.
  // Drop the leading partial token in that case; untruncated output is whole.
  // The caller's flag is authoritative (a ring string is already <= the cap,
  // so a length check here cannot see the cut); direct callers OR in their
  // own over-budget check.
  const bytes = Buffer.from(redacted, "utf8");
  const cut = truncated || bytes.length > OUTPUT_TAIL_BYTES;
  const tail = bytes.subarray(Math.max(0, bytes.length - OUTPUT_TAIL_BYTES));
  let start = 0;
  while (start < tail.length && (tail[start]! & 0b1100_0000) === 0b1000_0000) start += 1;
  let bounded = tail.subarray(start).toString("utf8");
  if (cut) bounded = bounded.replace(/^\S+/, "");
  return bounded.trim();
}

/** Run `<binary> login --help` captured, bounded to 10s. Fails OPEN: only a
 * COMPLETED probe whose help text lacks the flag reports unsupported. */
function probeLoginHelp(
  binary: string,
  spawnProcess: typeof spawn,
  probeEnv: NodeJS.ProcessEnv,
): Promise<{ completed: boolean; output: string }> {
  return new Promise((resolveProbe) => {
    const PROBE_OUTPUT_CAP = 65_536;
    const chunks: Buffer[] = [];
    let retainedBytes = 0;
    let settled = false;
    const settle = (completed: boolean) => {
      if (settled) return;
      settled = true;
      resolveProbe({ completed, output: Buffer.concat(chunks).toString("utf8") });
    };
    let probe: ReturnType<typeof spawn>;
    try {
      probe = spawnProcess(binary, ["login", "--help"], {
        // Same provider-secret-scrubbed allowlist env as the real vendor
        // spawn — the probe must never inherit the Terminal's full env.
        env: probeEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      settle(false);
      return;
    }
    // Byte-accurate retention (UTF-16 string length under-counts multibyte
    // output); decode ONCE at settle so split UTF-8 never corrupts.
    const retain = (chunk: Buffer) => {
      if (retainedBytes >= PROBE_OUTPUT_CAP) return;
      const slice = chunk.subarray(0, PROBE_OUTPUT_CAP - retainedBytes);
      chunks.push(Buffer.from(slice));
      retainedBytes += slice.length;
    };
    probe.stdout?.on("data", retain);
    probe.stderr?.on("data", retain);
    probe.on("error", () => settle(false));
    // `close` (streams drained) + exit code 0: an errored-but-chatty probe
    // (old CLI printing \"unrecognized subcommand\") must fail OPEN to the
    // real spawn, and `exit` could race the final help-output chunks.
    probe.on("close", (code) => settle(code === 0 && retainedBytes > 0));
    const timer = setTimeout(() => {
      try {
        probe.kill("SIGKILL");
      } catch {
        // best-effort
      }
      settle(false);
    }, 10_000);
    timer.unref?.();
  });
}

function validateManifest(manifestPath: string): SetupLoginManifest {
  const manifest = readLoginManifest(manifestPath);
  const base = resolve(dirname(manifestPath));
  for (const output of [manifest.statePath, manifest.resultPath, manifest.permitPath]) {
    const absolute = resolve(output);
    if (!absolute.startsWith(base + sep))
      throw new Error("setup-login sidecar escapes its job directory");
  }
  return manifest;
}

function persistResult(
  manifest: SetupLoginManifest,
  result: Omit<
    SetupLoginRunnerResult,
    "version" | "jobId" | "executionId" | "commandDigest" | "manifestDigest"
  >,
): void {
  atomicPrivateJson(manifest.resultPath, {
    version: SETUP_LOGIN_PROTOCOL_VERSION,
    jobId: manifest.jobId,
    executionId: manifest.executionId,
    commandDigest: manifest.commandDigest,
    manifestDigest: manifest.manifestDigest,
    ...result,
  } satisfies SetupLoginRunnerResult);
}

/** Every not-started outcome writes the same receipt: no exit code, no signal.
 * Eight call sites spelled it out; one shape means the next field lands once. */
function persistFailure(
  manifest: SetupLoginManifest,
  now: () => Date,
  permitIssuedAt: string | null,
  errorCode: NonNullable<SetupLoginRunnerResult["errorCode"]>,
  outputTail?: string,
): void {
  persistResult(manifest, {
    permitIssuedAt,
    commandStarted: false,
    errorCode,
    exitCode: null,
    signal: null,
    finishedAt: now().toISOString(),
    ...(outputTail === undefined ? {} : { outputTail }),
  });
}

function waitForExit(
  child: ReturnType<typeof spawn>,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  // `close` fires after the stdio streams drain (wave-1 finding: `exit` can
  // race the final piped data chunks, truncating the captured tail); children
  // with fully-inherited stdio emit `close` immediately after `exit` too.
  return new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolveExit({ code, signal }));
  });
}

/** The bootstrap itself never needs model/provider credentials. */
function runnerBootstrapEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "HOME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "USER",
    "LOGNAME",
    // The daemon's config root MUST survive into the detached worker: without
    // it, any userConfigDir()-derived path in the worker (the default native
    // stores above all) silently re-roots onto the GLOBAL ~/.claudexor/v3 —
    // the exact store split behind the 2026-08-04 codex-login failure. The
    // sealed manifest now carries the resolved store explicitly; this
    // pass-through keeps every other owned-root derivation consistent too.
    "CLAUDEXOR_CONFIG_DIR",
    "CLAUDEXOR_CODEX_NATIVE_HOME",
    "CLAUDEXOR_CLAUDE_NATIVE_DIR",
    // Network reachability for the DETACHED worker: without the proxy/CA
    // family a corporate-proxy machine cannot reach the vendor at all and
    // the device-code login dies opaquely. Pass-through only — never set.
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
  ] as const) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  return env;
}

function isDirectEntrypoint(): boolean {
  if (!process.argv[1]) return false;
  try {
    const self = realpathSync(resolve(fileURLToPath(import.meta.url)));
    return realpathSync(resolve(process.argv[1])) === self;
  } catch {
    return false;
  }
}

if (isDirectEntrypoint()) {
  const workerMode = process.argv[2] === "--worker";
  const manifestPath = process.argv[workerMode ? 3 : 2];
  if (!manifestPath) {
    process.stderr.write("usage: setup-login-runner [--worker] <manifest.json>\n");
    process.exitCode = 2;
  } else {
    (workerMode ? runSetupLoginWorker(manifestPath) : runSetupLogin(manifestPath)).then(
      (code) => {
        process.exitCode = code;
      },
      (error) => {
        const detail = error instanceof Error ? error.message : String(error);
        process.stderr.write(`setup-login-runner: ${detail}\n`);
        process.exitCode = 1;
      },
    );
  }
}

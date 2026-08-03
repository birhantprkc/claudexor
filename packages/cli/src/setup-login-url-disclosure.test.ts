import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ControlSetupJob } from "@claudexor/schema";
import { ProcessGroupService, type ProcessIdentityReader } from "@claudexor/core";
import {
  createOAuthUrlDetector,
  extractOAuthUrl,
  runSetupLoginWorker,
} from "./setup-login-runner.js";
import {
  SETUP_LOGIN_PROTOCOL_VERSION,
  atomicPrivateJson,
  captureExecutableEvidence,
  commandDigest,
  readRunnerDeviceCode,
  sealLoginManifest,
} from "./setup-login-protocol.js";
import { projectSetupDeviceCode } from "./setup-client-pty.js";

/**
 * Upstream half of "non-codex login without Terminal.app": a TERMINAL-mode
 * login job (claude/cursor) captures the vendor CLI's OAuth URL from its own
 * output and surfaces it as the SAME structured sidecar disclosure the codex
 * device-code flow uses — URL-only card, no terminal needed to read it.
 */

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "setup-oauth-url-")));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function processGroups(pid = 4242): ProcessGroupService {
  const leader = {
    status: "known" as const,
    pid,
    platform: "darwin" as const,
    source: "proc_pidinfo" as const,
    startToken: "darwin:1710000000:000001",
    processGroupId: pid,
  };
  const identity: ProcessIdentityReader = {
    read: (requested) =>
      requested === pid ? leader : { status: "missing", pid: requested, platform: "darwin" },
    self: () => leader,
  };
  return new ProcessGroupService({
    platform: "darwin",
    identity,
    probeProcessGroup: () => undefined,
    signalProcessGroup: () => undefined,
  });
}

function prepareTerminalLogin(script: string, harness: "claude" | "cursor" = "claude") {
  const jobDir = join(root, "job");
  mkdirSync(jobDir, { mode: 0o700 });
  const binary = join(jobDir, harness);
  writeFileSync(binary, script, { mode: 0o700 });
  chmodSync(binary, 0o700);
  const executable = captureExecutableEvidence(binary);
  const args = harness === "claude" ? ["auth", "login"] : ["login"];
  const spec = sealLoginManifest({
    version: SETUP_LOGIN_PROTOCOL_VERSION,
    jobId: "setup-oauth",
    executionId: "execution-1",
    harness,
    jobDir,
    binary,
    args,
    cwd: jobDir,
    // Terminal-mode manifests now carry the disclosure sidecar path too.
    deviceCodePath: join(jobDir, "runner-devicecode.json"),
    statePath: join(jobDir, "runner-state.json"),
    resultPath: join(jobDir, "runner-result.json"),
    permitPath: join(jobDir, "runner-permit.json"),
    permitDeadlineAt: new Date(Date.now() + 5_000).toISOString(),
    executable,
    commandDigest: commandDigest(executable, args),
  });
  atomicPrivateJson(join(jobDir, "runner-manifest.json"), spec);
  atomicPrivateJson(spec.permitPath, {
    version: SETUP_LOGIN_PROTOCOL_VERSION,
    jobId: spec.jobId,
    executionId: spec.executionId,
    issuedAt: new Date().toISOString(),
    commandDigest: spec.commandDigest,
    manifestDigest: spec.manifestDigest,
  });
  return { jobDir, manifestPath: join(jobDir, "runner-manifest.json"), spec };
}

async function runWorker(manifestPath: string, nativeDir: string): Promise<number> {
  // The claude native-store override must live INSIDE the Claudexor config
  // root, so the hermetic test roots BOTH in the temp dir.
  const saved: Record<string, string | undefined> = {
    CLAUDEXOR_CONFIG_DIR: process.env.CLAUDEXOR_CONFIG_DIR,
    CLAUDEXOR_CLAUDE_NATIVE_DIR: process.env.CLAUDEXOR_CLAUDE_NATIVE_DIR,
  };
  process.env.CLAUDEXOR_CONFIG_DIR = root;
  process.env.CLAUDEXOR_CLAUDE_NATIVE_DIR = nativeDir;
  try {
    return await runSetupLoginWorker(manifestPath, {
      processGroupService: processGroups(),
      selfPid: 4242,
    });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("extractOAuthUrl", () => {
  it("finds a sign-in URL through ANSI color noise and trims trailing punctuation", () => {
    const text =
      "\u001b[1mBrowser did not open?\u001b[0m Visit:\n" +
      "\u001b[4mhttps://claude.ai/oauth/authorize?client=cli&state=abc123\u001b[0m.\n";
    expect(extractOAuthUrl(text)).toBe("https://claude.ai/oauth/authorize?client=cli&state=abc123");
  });

  it("ignores URLs with no sign-in signature (a docs banner is not the login link)", () => {
    expect(extractOAuthUrl("see https://docs.example.com/guide for help")).toBeNull();
    expect(extractOAuthUrl("no urls at all")).toBeNull();
  });

  it("returns the FIRST qualifying URL when several are printed", () => {
    const text =
      "https://docs.example.com/guide then https://cursor.com/loginDeepControl?token=t1 " +
      "and later https://cursor.com/loginDeepControl?token=t2";
    expect(extractOAuthUrl(text)).toBe("https://cursor.com/loginDeepControl?token=t1");
  });

  it("detector catches a URL split across chunks and reports exactly once", () => {
    const detector = createOAuthUrlDetector();
    expect(detector.push(Buffer.from("Visit https://auth.openai.com/oa"))).toBeNull();
    expect(detector.push(Buffer.from("uth/authorize?x=1 to continue\n"))).toBe(
      "https://auth.openai.com/oauth/authorize?x=1",
    );
    // Re-prints must not re-disclose.
    expect(detector.push(Buffer.from("again https://auth.openai.com/oauth/authorize?x=2"))).toBe(
      null,
    );
  });
});

describe("terminal-mode login worker OAuth URL disclosure", () => {
  it("captures the vendor login URL into the structured oauth_url sidecar, keeps output flowing", async () => {
    const script = [
      "#!/bin/sh",
      "printf 'Opening browser...\\n'",
      "printf '\\033[1mIf it does not open, visit:\\033[0m\\n'",
      "printf 'https://claude.ai/oauth/authorize?code=true&state=abc123\\n'",
      "sleep 0.01",
      "exit 0",
      "",
    ].join("\n");
    const { jobDir, manifestPath, spec } = prepareTerminalLogin(script);
    expect(await runWorker(manifestPath, join(root, "native-claude"))).toBe(0);

    // Structured disclosure — the codex device-code sidecar shape, URL-only.
    const sidecar = readRunnerDeviceCode(spec.deviceCodePath as string);
    expect(sidecar).toMatchObject({
      jobId: spec.jobId,
      executionId: spec.executionId,
      flow: "oauth_url",
      verificationUrl: "https://claude.ai/oauth/authorize?code=true&state=abc123",
      userCode: "",
    });

    // Secret discipline: the URL rides ONLY the transient sidecar, never the
    // durable result receipt (same rule as the device-code userCode).
    const receipt = readFileSync(join(jobDir, "runner-result.json"), "utf8");
    expect(receipt).not.toContain("claude.ai/oauth");
  });

  it("writes no sidecar when the vendor login never prints a sign-in URL", async () => {
    const script = "#!/bin/sh\nprintf 'already authenticated\\n'\nexit 0\n";
    const { manifestPath, spec } = prepareTerminalLogin(script);
    expect(await runWorker(manifestPath, join(root, "native-claude"))).toBe(0);
    expect(existsSync(spec.deviceCodePath as string)).toBe(false);
  });

  it("a pre-upgrade manifest without deviceCodePath still runs and discloses nothing", async () => {
    const jobDir = join(root, "job-legacy");
    mkdirSync(jobDir, { mode: 0o700 });
    const binary = join(jobDir, "claude");
    writeFileSync(
      binary,
      "#!/bin/sh\nprintf 'https://claude.ai/oauth/authorize?s=1\\n'\nexit 0\n",
      {
        mode: 0o700,
      },
    );
    chmodSync(binary, 0o700);
    const executable = captureExecutableEvidence(binary);
    const args = ["auth", "login"];
    const spec = sealLoginManifest({
      version: SETUP_LOGIN_PROTOCOL_VERSION,
      jobId: "setup-legacy",
      executionId: "execution-1",
      harness: "claude",
      jobDir,
      binary,
      args,
      cwd: jobDir,
      statePath: join(jobDir, "runner-state.json"),
      resultPath: join(jobDir, "runner-result.json"),
      permitPath: join(jobDir, "runner-permit.json"),
      permitDeadlineAt: new Date(Date.now() + 5_000).toISOString(),
      executable,
      commandDigest: commandDigest(executable, args),
    });
    const manifestPath = join(jobDir, "runner-manifest.json");
    atomicPrivateJson(manifestPath, spec);
    atomicPrivateJson(spec.permitPath, {
      version: SETUP_LOGIN_PROTOCOL_VERSION,
      jobId: spec.jobId,
      executionId: spec.executionId,
      issuedAt: new Date().toISOString(),
      commandDigest: spec.commandDigest,
      manifestDigest: spec.manifestDigest,
    });
    expect(await runWorker(manifestPath, join(root, "native-claude"))).toBe(0);
    expect(existsSync(join(jobDir, "runner-devicecode.json"))).toBe(false);
  });
});

describe("projectSetupDeviceCode surfaces terminal-login oauth_url sidecars", () => {
  function terminalClaudeJob(): ControlSetupJob {
    return ControlSetupJob.parse({
      jobId: "setup-oauth",
      harness: "claude",
      action: "login",
      state: "waiting_for_input",
      phase: "awaiting_user",
      command: "claude auth login",
      guideUrl: null,
      message: "Complete claude native login.",
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      finishedAt: null,
      authCapability: {
        attemptId: "attempt-oauth",
        challengeDigest: "d".repeat(64),
        requestDigest: "e".repeat(64),
        disclosure: {
          schemaVersion: 1,
          protocolVersion: 1,
          harness: "claude",
          requested: "subscription",
          requiredRoute: "vendor_native",
          requiredSource: "native_session",
          networkScope: "selected_harness_only",
          billingKnowledge: "unknown",
          incrementalCostKnowledge: "unknown",
          mayConsumeQuota: true,
          generatedAt: new Date().toISOString(),
        },
        state: "disclosed",
      },
      authorization: {
        executionId: "execution-1",
        executable: {
          realpath: "/usr/local/bin/claude",
          sha256: "a".repeat(64),
          size: 10,
          mode: 0o755,
          device: "1",
          inode: "2",
        },
        // No "app-server" here — this is exactly the terminal job shape the
        // old isDeviceCodeSetupJob gate used to exclude.
        args: ["auth", "login"],
        commandDigest: "b".repeat(64),
        manifestDigest: "c".repeat(64),
      },
    });
  }

  it("overlays the oauth_url disclosure for an awaiting-user terminal login", () => {
    const sidecarPath = join(root, "runner-devicecode.json");
    atomicPrivateJson(sidecarPath, {
      version: SETUP_LOGIN_PROTOCOL_VERSION,
      jobId: "setup-oauth",
      executionId: "execution-1",
      flow: "oauth_url",
      verificationUrl: "https://claude.ai/oauth/authorize?state=abc",
      userCode: "",
      disclosedAt: new Date().toISOString(),
    });
    expect(projectSetupDeviceCode(terminalClaudeJob(), sidecarPath)).toEqual({
      flow: "oauth_url",
      verificationUrl: "https://claude.ai/oauth/authorize?state=abc",
      userCode: "",
    });
  });

  it("still refuses a sidecar bound to another execution", () => {
    const sidecarPath = join(root, "runner-devicecode.json");
    atomicPrivateJson(sidecarPath, {
      version: SETUP_LOGIN_PROTOCOL_VERSION,
      jobId: "setup-oauth",
      executionId: "execution-OTHER",
      flow: "oauth_url",
      verificationUrl: "https://claude.ai/oauth/authorize?state=abc",
      userCode: "",
      disclosedAt: new Date().toISOString(),
    });
    expect(projectSetupDeviceCode(terminalClaudeJob(), sidecarPath)).toBeUndefined();
  });
});

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  assertNoPreexistingDaemon,
  assertRegularFileUnchanged,
  describeFileSnapshot,
  durableAttemptRouteEvidence,
  evaluateRequiredNativeRoutes,
  isCrossFamilyConvergenceRefusal,
  resolveRealHarnessBatteryLayout,
  runtimeReplacementIdentityFromHandshake,
  sameDaemonLease,
  snapshotRegularFile,
} from "./real-harness-battery-state.mjs";

const fixtureRoots = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "claudexor-battery-state-")));
  fixtureRoots.push(root);
  const home = join(root, "home");
  const sourceRoot = join(root, "source");
  const defaultConfig = join(home, ".claudexor", "v3");
  mkdirSync(defaultConfig, { recursive: true });
  mkdirSync(sourceRoot);
  return { root, home, sourceRoot, defaultConfig };
}

test("scratch mode keeps its isolated config override", () => {
  const f = fixture();
  const defaultBatteryRoot = join(f.home, ".claudexor", "dogfood", "battery-1");
  expect(
    resolveRealHarnessBatteryLayout({
      home: f.home,
      sourceRoot: f.sourceRoot,
      defaultBatteryRoot,
    }),
  ).toEqual({
    mode: "scratch",
    batteryRoot: defaultBatteryRoot,
    configDir: join(defaultBatteryRoot, "config"),
    exportConfigDir: true,
  });
});

test("existing-default mode accepts only the canonical default root and external battery dir", () => {
  const f = fixture();
  const batteryRoot = join(f.root, "dogfood", "battery-1");
  expect(
    resolveRealHarnessBatteryLayout({
      home: f.home,
      sourceRoot: f.sourceRoot,
      defaultBatteryRoot: join(f.root, "unused"),
      batteryDir: batteryRoot,
      requestedConfigDir: f.defaultConfig,
    }),
  ).toEqual({
    mode: "existing_default",
    batteryRoot,
    configDir: f.defaultConfig,
    exportConfigDir: false,
  });
});

test("existing-default mode rejects ambient, foreign, symlinked, and overlapping roots", () => {
  const f = fixture();
  const args = {
    home: f.home,
    sourceRoot: f.sourceRoot,
    defaultBatteryRoot: join(f.root, "unused"),
    batteryDir: join(f.root, "dogfood"),
    requestedConfigDir: f.defaultConfig,
  };
  expect(() =>
    resolveRealHarnessBatteryLayout({ ...args, ambientConfigDir: join(f.root, "ambient") }),
  ).toThrow(/cannot be combined/);
  const foreign = join(f.root, "foreign");
  mkdirSync(foreign);
  expect(() => resolveRealHarnessBatteryLayout({ ...args, requestedConfigDir: foreign })).toThrow(
    /canonical default/,
  );
  const link = join(f.root, "config-link");
  symlinkSync(f.defaultConfig, link);
  expect(() => resolveRealHarnessBatteryLayout({ ...args, requestedConfigDir: link })).toThrow(
    /canonical default/,
  );
  expect(() =>
    resolveRealHarnessBatteryLayout({
      ...args,
      batteryDir: join(f.home, ".claudexor", "dogfood"),
    }),
  ).toThrow(/outside the Claudexor runtime tree/);
  expect(() =>
    resolveRealHarnessBatteryLayout({ ...args, batteryDir: join(f.sourceRoot, "tmp") }),
  ).toThrow(/outside the Claudexor source checkout/);
});

test("protected config snapshot detects byte and mode changes", () => {
  const f = fixture();
  const path = join(f.defaultConfig, "config.yaml");
  writeFileSync(path, "version: 1\n", { mode: 0o600 });
  const before = snapshotRegularFile(path);
  expect(describeFileSnapshot(assertRegularFileUnchanged(path, before))).toEqual({
    exists: true,
    digest: before.digest,
    mode: 0o600,
  });
  writeFileSync(path, "version: 1\nrouting: {}\n");
  expect(() => assertRegularFileUnchanged(path, before)).toThrow(/changed protected state/);
  writeFileSync(path, "version: 1\n");
  chmodSync(path, 0o640);
  expect(() => assertRegularFileUnchanged(path, before)).toThrow(/changed protected state/);
});

test("daemon preflight fails closed on each live ownership surface", () => {
  const clear = {
    statusCode: 1,
    socketIsAlive: false,
    leaseIsAlive: false,
  };
  expect(() => assertNoPreexistingDaemon(clear)).not.toThrow();
  expect(() => assertNoPreexistingDaemon({ ...clear, statusCode: 0 })).toThrow(/pre-existing/);
  expect(() => assertNoPreexistingDaemon({ ...clear, socketIsAlive: true })).toThrow(/live socket/);
  expect(() => assertNoPreexistingDaemon({ ...clear, leaseIsAlive: true })).toThrow(/writer-lease/);
});

test("daemon cleanup authority is bound to the exact writer lease", () => {
  const captured = { pid: 41, token: "captured" };
  expect(sameDaemonLease(captured, { ...captured })).toBe(true);
  expect(sameDaemonLease(captured, { pid: 42, token: "captured" })).toBe(false);
  expect(sameDaemonLease(captured, { pid: 41, token: "successor" })).toBe(false);
  expect(sameDaemonLease(captured, null)).toBe(false);
});

test("daemon cleanup keeps the observed identity when the candidate handshake mismatches", () => {
  const observedSha = "a".repeat(40);
  expect(
    runtimeReplacementIdentityFromHandshake({
      engine: { version: "3.2.1", sha: observedSha, entry: "/tmp/claudexord.js" },
    }),
  ).toEqual({ version: "3.2.1", buildSha: observedSha });
  expect(
    runtimeReplacementIdentityFromHandshake({
      engine: { version: "3.2.1", sha: "not-a-sha", entry: "/tmp/claudexord.js" },
    }),
  ).toBeNull();
});

test("native-session acceptance rejects missing and API-fallback routes", () => {
  const required = ["codex", "claude"];
  const codex = {
    harnessId: "codex",
    authMode: "local_session",
    authSource: "native_session",
  };
  const claude = {
    harnessId: "claude",
    authMode: "local_session",
    authSource: "native_session",
  };
  expect(evaluateRequiredNativeRoutes(required, [codex, claude])).toEqual({
    valid: true,
    missing: [],
    nonNative: [],
  });
  expect(evaluateRequiredNativeRoutes(required, [codex])).toMatchObject({
    valid: false,
    missing: ["claude"],
  });
  expect(
    evaluateRequiredNativeRoutes(required, [
      codex,
      { ...claude, authMode: "api_key", authSource: "api_key_env" },
    ]),
  ).toMatchObject({ valid: false, nonNative: [{ harnessId: "claude" }] });
  expect(
    evaluateRequiredNativeRoutes(required, [
      codex,
      { ...claude, authMode: null, authSource: null },
    ]),
  ).toMatchObject({ valid: false, nonNative: [{ harnessId: "claude" }] });
});

test("cross-family convergence assertion reads the canonical failure, not nested review fields", () => {
  expect(
    isCrossFamilyConvergenceRefusal({
      code: 1,
      json: {
        status: "failed",
        error:
          "convergence requires a cross-family clean review (>=2 healthy reviewer provider families); found 1.",
      },
    }),
  ).toBe(true);
  expect(
    isCrossFamilyConvergenceRefusal({
      code: 1,
      json: {
        status: "failed",
        error: "no harness remains eligible after budget and quota routing",
        runFacts: { outcome: { review: "not_run" }, review: { state: "not_run" } },
      },
    }),
  ).toBe(false);
  expect(
    isCrossFamilyConvergenceRefusal({
      code: 0,
      json: {
        status: "succeeded",
        summary: "convergence requires a cross-family clean review (fixture prose only)",
      },
    }),
  ).toBe(false);
});

test("durable route evidence catches native to API retries after the first start", () => {
  const evidence = durableAttemptRouteEvidence([
    {
      type: "started",
      credential_route: "vendor_native",
      credential_source: "native_session",
    },
    { type: "completed" },
    {
      type: "message",
      payload: { auth_switched: true, to_auth_mode: "api_key" },
    },
    {
      type: "started",
      credential_route: "managed_api_key",
      credential_source: "api_key_env",
    },
  ]);
  expect(evidence).toEqual({
    sawStarted: true,
    observed: [
      { kind: "started", authMode: "local_session", authSource: "native_session" },
      { kind: "auth_switched", authMode: "api_key", authSource: null },
      { kind: "started", authMode: "api_key", authSource: "api_key_env" },
    ],
  });
});

test("durable route evidence fails closed on an unknown auth switch", () => {
  const evidence = durableAttemptRouteEvidence([
    {
      type: "started",
      credential_route: "vendor_native",
      credential_source: "native_session",
    },
    {
      type: "message",
      payload: { auth_switched: true, to_auth_mode: "unknown" },
    },
  ]);
  expect(evidence.observed).toEqual([
    { kind: "started", authMode: "local_session", authSource: "native_session" },
    { kind: "auth_switched", authMode: null, authSource: null },
  ]);
  const observed = evidence.observed.map((route) => ({ harnessId: "codex", ...route }));
  expect(evaluateRequiredNativeRoutes(["codex"], observed)).toMatchObject({
    valid: false,
    missing: [],
    nonNative: [{ harnessId: "codex", kind: "auth_switched", authMode: null, authSource: null }],
  });
});

test.each(["local_session", "subscription"])(
  "durable route evidence accepts a known native %s auth switch",
  (toAuthMode) => {
    const evidence = durableAttemptRouteEvidence([
      {
        type: "started",
        credential_route: "vendor_native",
        credential_source: "native_session",
      },
      {
        type: "message",
        payload: { auth_switched: true, to_auth_mode: toAuthMode },
      },
    ]);
    const observed = evidence.observed.map((route) => ({ harnessId: "codex", ...route }));
    expect(evaluateRequiredNativeRoutes(["codex"], observed)).toMatchObject({
      valid: true,
      missing: [],
      nonNative: [],
    });
  },
);

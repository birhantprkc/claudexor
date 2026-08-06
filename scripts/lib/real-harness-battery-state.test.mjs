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
  FrozenTaskContractArtifact,
  HarnessEvent,
  RunEvent,
  RunTelemetry,
} from "../../packages/schema/dist/index.js";
import {
  assertNoPreexistingDaemon,
  assertRegularFileUnchanged,
  describeFileSnapshot,
  durableAttemptRouteEvidence,
  evaluateRequiredNativeRoutes,
  isBatteryRepoRoot,
  isCrossFamilyConvergenceRefusal,
  relevantRunAttemptKeys,
  resolveRealHarnessBatteryLayout,
  runtimeReplacementIdentityFromHandshake,
  sameDaemonLease,
  snapshotRegularFile,
  validateBatteryRunArtifacts,
  validateBatteryTaskIdentity,
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

test("battery ownership is contained by the synthetic repos root", () => {
  expect(isBatteryRepoRoot("/tmp/battery/repos", "/tmp/battery/repos/phase1")).toBe(true);
  expect(isBatteryRepoRoot("/tmp/battery/repos", "/tmp/foreign/review")).toBe(false);
});

function batteryTask(taskId = "task-1") {
  return {
    schema_version: 2,
    task_id: taskId,
    created_at: "2026-08-06T00:00:00Z",
    repo: { root: "/tmp/battery/repos/phase1", base_ref: "main" },
    mode: { kind: "agent" },
    user_intent: { raw: "exercise native route acceptance" },
    tests: { commands: [] },
  };
}

function batteryHarnessEvent({ runId = "run-1", taskId = "task-1", attemptId = "a01" } = {}) {
  return {
    seq: 1,
    ts: "2026-08-06T00:00:00Z",
    run_id: runId,
    task_id: taskId,
    type: "harness.event",
    payload: {
      harness_id: "codex",
      attempt_id: attemptId,
      session_id: "session-1",
      ts: "2026-08-06T00:00:00Z",
      type: "started",
      title: "started",
      credential_route: "vendor_native",
    },
  };
}

function batteryTelemetry({ runId = "run-1", taskId = "task-1", attemptId = "a01" } = {}) {
  return {
    schema_version: 2,
    run_id: runId,
    task_id: taskId,
    generated_at: "2026-08-06T00:00:00Z",
    mode: "agent",
    requested_access: "workspace_write",
    effective_access: "workspace_write",
    external_context_policy: "off",
    effective_web_mode: "off",
    final_attempt_id: attemptId,
    web: {},
    attempts: [
      {
        attempt_id: attemptId,
        harness_id: "codex",
        auth_mode: "local_session",
        auth_source: "native_session",
        web: {},
      },
    ],
  };
}

const artifactSchemas = {
  runEventSchema: RunEvent,
  harnessEventSchema: HarnessEvent,
  telemetrySchema: RunTelemetry,
};

test("battery evidence validates canonical schemas and binds run/task identity", () => {
  const job = { runId: "run-1", taskId: "task-1" };
  const taskResult = validateBatteryTaskIdentity({
    job,
    task: batteryTask(),
    taskSchema: FrozenTaskContractArtifact,
  });
  expect(taskResult).toMatchObject({ valid: true, reason: null });
  expect(
    validateBatteryRunArtifacts({
      job,
      task: taskResult.task,
      eventText: `${JSON.stringify(batteryHarnessEvent())}\n`,
      telemetry: batteryTelemetry(),
      telemetryPresent: true,
      ...artifactSchemas,
    }),
  ).toMatchObject({ valid: true, reason: null });
});

test("battery evidence rejects partial task contracts and foreign task identities", () => {
  const job = { runId: "run-1", taskId: "task-1" };
  expect(
    validateBatteryTaskIdentity({
      job,
      task: { repo: { root: "/tmp/battery/repos/phase1" } },
      taskSchema: FrozenTaskContractArtifact,
    }),
  ).toMatchObject({ valid: false, reason: "task_contract_missing_or_malformed" });
  expect(
    validateBatteryTaskIdentity({
      job,
      task: batteryTask("task-foreign"),
      taskSchema: FrozenTaskContractArtifact,
    }),
  ).toMatchObject({ valid: false, reason: "artifact_identity_mismatch" });
});

test.each([
  ["empty journal", "", "run_events_missing_or_malformed"],
  ["malformed journal", "{}\n", "run_events_missing_or_malformed"],
  [
    "foreign run event",
    `${JSON.stringify(batteryHarnessEvent({ runId: "run-foreign" }))}\n`,
    "artifact_identity_mismatch",
  ],
  [
    "foreign task event",
    `${JSON.stringify(batteryHarnessEvent({ taskId: "task-foreign" }))}\n`,
    "artifact_identity_mismatch",
  ],
  [
    "non-string attempt id",
    `${JSON.stringify(batteryHarnessEvent({ attemptId: 1 }))}\n`,
    "run_events_missing_or_malformed",
  ],
  [
    "boolean attempt id",
    `${JSON.stringify(batteryHarnessEvent({ attemptId: true }))}\n`,
    "run_events_missing_or_malformed",
  ],
  [
    "malformed nested harness event",
    `${JSON.stringify({
      ...batteryHarnessEvent(),
      payload: { ...batteryHarnessEvent().payload, session_id: undefined },
    })}\n`,
    "run_events_missing_or_malformed",
  ],
])("battery evidence rejects %s", (_label, eventText, reason) => {
  expect(
    validateBatteryRunArtifacts({
      job: { runId: "run-1", taskId: "task-1" },
      task: FrozenTaskContractArtifact.parse(batteryTask()),
      eventText,
      telemetry: null,
      telemetryPresent: false,
      ...artifactSchemas,
    }),
  ).toMatchObject({ valid: false, reason });
});

test("battery evidence rejects malformed and alien telemetry", () => {
  const common = {
    job: { runId: "run-1", taskId: "task-1" },
    task: FrozenTaskContractArtifact.parse(batteryTask()),
    eventText: `${JSON.stringify(batteryHarnessEvent())}\n`,
    telemetryPresent: true,
    ...artifactSchemas,
  };
  expect(validateBatteryRunArtifacts({ ...common, telemetry: { attempts: [] } })).toMatchObject({
    valid: false,
    reason: "attempt_telemetry_missing_or_malformed",
  });
  expect(
    validateBatteryRunArtifacts({
      ...common,
      telemetry: batteryTelemetry({ runId: "run-foreign" }),
    }),
  ).toMatchObject({ valid: false, reason: "artifact_identity_mismatch" });
});

test("valid no-attempt preflight journal stays neutral without telemetry", () => {
  const event = {
    seq: 1,
    ts: "2026-08-06T00:00:00Z",
    run_id: "run-1",
    task_id: "task-1",
    type: "run.created",
    payload: {},
  };
  expect(
    validateBatteryRunArtifacts({
      job: { runId: "run-1", taskId: "task-1" },
      task: FrozenTaskContractArtifact.parse(batteryTask()),
      eventText: `${JSON.stringify(event)}\n`,
      telemetry: null,
      telemetryPresent: false,
      ...artifactSchemas,
    }),
  ).toMatchObject({ valid: true, reason: null, telemetry: null });
});

test("canonical run events discover admitted and raw required-harness attempts", () => {
  expect(
    relevantRunAttemptKeys(
      [
        {
          type: "harness.started",
          payload: { harness_id: "codex", attempt_id: "a01" },
        },
        {
          type: "harness.event",
          payload: { harness_id: "codex", attempt_id: "a01", type: "started" },
        },
        {
          type: "harness.event",
          payload: { harness_id: "claude", attempt_id: "a02", type: "started" },
        },
        {
          type: "harness.event",
          payload: { harness_id: "cursor", attempt_id: "a03", type: "started" },
        },
      ],
      ["codex", "claude"],
    ),
  ).toEqual([
    { harnessId: "codex", attemptId: "a01" },
    { harnessId: "claude", attemptId: "a02" },
  ]);
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

test("top-level route evidence composes its omitted source with exact telemetry", () => {
  const evidence = durableAttemptRouteEvidence(
    [{ type: "started", credential_route: "vendor_native" }, { type: "completed" }],
    { authMode: "local_session", authSource: "native_session" },
  );
  expect(evidence).toEqual({
    sawStarted: true,
    observed: [{ kind: "started", authMode: "local_session", authSource: "native_session" }],
  });
  expect(
    durableAttemptRouteEvidence([{ type: "started", credential_route: "vendor_native" }], {
      authMode: "local_session",
      authSource: null,
    }).observed,
  ).toEqual([{ kind: "started", authMode: "local_session", authSource: null }]);
});

test("telemetry source composition still exposes a later API interval", () => {
  const evidence = durableAttemptRouteEvidence(
    [
      { type: "started", credential_route: "vendor_native" },
      { type: "message", payload: { auth_switched: true, to_auth_mode: "api_key" } },
      { type: "message", credential_route: "managed_api_key" },
    ],
    { authMode: "local_session", authSource: "native_session" },
  );
  const observed = evidence.observed.map((route) => ({ harnessId: "codex", ...route }));
  expect(evaluateRequiredNativeRoutes(["codex"], observed)).toMatchObject({
    valid: false,
    missing: [],
    nonNative: [
      { harnessId: "codex", kind: "auth_switched", authMode: "api_key" },
      { harnessId: "codex", kind: "api_route_event", authMode: "api_key" },
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

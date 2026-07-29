#!/usr/bin/env node
/**
 * Gate: every generated JSON Schema must compile under its declared dialect
 * (draft-07). Catches generator regressions like the historical invalid
 * "jsonSchema2020-12" target that silently emitted a draft-4/7 hybrid
 * (boolean `exclusiveMinimum`) no modern validator accepts.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Ajv = require("ajv");
const addFormats = require("ajv-formats");

const here = dirname(fileURLToPath(import.meta.url));
const genDir = join(here, "..", "packages", "schema", "generated");

const files = readdirSync(genDir).filter((f) => f.endsWith(".schema.json"));
if (files.length === 0) {
  console.error("validate-generated-schemas: no generated schemas found");
  process.exit(1);
}

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const failures = [];
const validators = new Map();
for (const file of files) {
  const raw = JSON.parse(readFileSync(join(genDir, file), "utf8"));
  if (raw.$schema !== "http://json-schema.org/draft-07/schema#") {
    failures.push(`${file}: missing/unexpected $schema declaration (${raw.$schema ?? "none"})`);
    continue;
  }
  try {
    validators.set(file, ajv.compile(raw));
  } catch (err) {
    failures.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function setupEnvelope(kind, job, deviceCode, extra = {}) {
  const projection = deviceCode === undefined ? {} : { deviceCode };
  if (kind === "snapshot") {
    return { job, cursor: "cursor-1", sequence: 1, ...projection, ...extra };
  }
  return {
    jobId: job.jobId,
    cursor: "cursor-1",
    previousCursor: null,
    sequence: 1,
    time: "2026-07-29T00:00:00.000Z",
    kind: "status",
    state: job.state,
    message: job.message,
    job,
    ...projection,
    ...extra,
  };
}

function assertSetupProjection(file, kind) {
  const validate = validators.get(file);
  if (!validate) {
    failures.push(`${file}: missing compiled validator for device-code projection semantics`);
    return;
  }
  const baseJob = {
    jobId: "setup-1",
    harness: "codex",
    action: "login",
    state: "running",
    phase: "awaiting_user",
    command: null,
    guideUrl: null,
    message: "waiting",
    createdAt: "2026-07-29T00:00:00.000Z",
    startedAt: "2026-07-29T00:00:00.000Z",
    finishedAt: null,
  };
  const disclosure = {
    flow: "chatgptDeviceCode",
    verificationUrl: "https://chatgpt.com/device",
    userCode: "TEST-ONLY",
  };
  const expectVerdict = (name, value, expected) => {
    if (validate(value) !== expected) {
      failures.push(`${file}: device-code projection case '${name}' should be ${expected}`);
    }
  };

  expectVerdict("absent", setupEnvelope(kind, baseJob), true);
  expectVerdict(
    "absent-terminal",
    setupEnvelope(kind, { ...baseJob, state: "failed", phase: "completed" }),
    true,
  );
  expectVerdict("absent-claude", setupEnvelope(kind, { ...baseJob, harness: "claude" }), true);
  for (const state of ["queued", "running", "waiting_for_input"]) {
    expectVerdict(`active-${state}`, setupEnvelope(kind, { ...baseJob, state }, disclosure), true);
  }
  for (const state of [
    "succeeded",
    "failed",
    "cancelled",
    "timed_out",
    "interrupted_unknown",
    "not_supported",
  ]) {
    expectVerdict(
      `terminal-${state}`,
      setupEnvelope(kind, { ...baseJob, state }, disclosure),
      false,
    );
  }
  for (const harness of ["claude", "cursor"]) {
    expectVerdict(
      `harness-${harness}`,
      setupEnvelope(kind, { ...baseJob, harness }, disclosure),
      false,
    );
  }
  expectVerdict(
    "wrong-phase",
    setupEnvelope(kind, { ...baseJob, phase: "verifying" }, disclosure),
    false,
  );
  expectVerdict(
    "unknown-outer-field",
    setupEnvelope(kind, baseJob, undefined, { surprise: 1 }),
    false,
  );
  expectVerdict(
    "unknown-outer-field-with-code",
    setupEnvelope(kind, baseJob, disclosure, { surprise: 1 }),
    false,
  );
}

assertSetupProjection("ControlSetupJobSnapshot.schema.json", "snapshot");
assertSetupProjection("ControlSetupJobEvent.schema.json", "event");

if (failures.length > 0) {
  console.error(`validate-generated-schemas: ${failures.length} generated-schema gate failure(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(
  `validate-generated-schemas: ${files.length} schemas compile clean (draft-07); ` +
    "setup device-code projection semantics pass",
);

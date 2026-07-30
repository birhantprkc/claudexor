import { mkdirSync, mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { summaryFingerprint } from "./run-list-fingerprint.js";
import type { DaemonRunRecord } from "./run-record.js";

describe("run-list delivery fingerprint", () => {
  it("detects a same-size atomic replacement with the same millisecond mtime", () => {
    const runDir = mkdtempSync(join(tmpdir(), "claudexor-run-fingerprint-"));
    const finalDir = join(runDir, "final");
    const statePath = join(finalDir, "delivery_state.yaml");
    const replacement = join(finalDir, ".delivery-next");
    mkdirSync(finalDir);
    const timestamp = new Date("2026-07-29T00:00:00.123Z");
    writeFileSync(statePath, "state: old\n");
    utimesSync(statePath, timestamp, timestamp);
    const record = {
      id: "job-1",
      runId: "run-1",
      runDir,
      state: "succeeded",
      params: {},
      finishedAt: timestamp.toISOString(),
    } as unknown as DaemonRunRecord;

    try {
      const before = summaryFingerprint(record);
      writeFileSync(replacement, "state: new\n");
      utimesSync(replacement, timestamp, timestamp);
      renameSync(replacement, statePath);
      const after = summaryFingerprint(record);
      expect(after).not.toBe(before);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it("invalidates a terminal summary when retention replaces the run tree", () => {
    const runDir = mkdtempSync(join(tmpdir(), "claudexor-run-fingerprint-retention-"));
    const finalDir = join(runDir, "final");
    mkdirSync(finalDir);
    writeFileSync(join(finalDir, "answer.md"), "ready\n");
    const record = {
      id: "job-retained",
      runId: "run-retained",
      runDir,
      state: "succeeded",
      params: {},
      finishedAt: "2026-07-29T00:00:00.000Z",
    } as unknown as DaemonRunRecord;

    const before = summaryFingerprint(record);
    rmSync(runDir, { recursive: true, force: true });
    mkdirSync(runDir);
    writeFileSync(join(runDir, "tombstone.yaml"), "reason: retention\n");
    try {
      expect(summaryFingerprint(record)).not.toBe(before);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });
});

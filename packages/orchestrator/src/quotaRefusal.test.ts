/**
 * A spent subscription window must arrive as a MACHINE-READABLE terminal: an
 * automating caller decides when to come back from `code` + `resetsAt`, never
 * by reading `safeMessage`.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "@claudexor/artifact-store";
import { EventLog } from "@claudexor/event-log";
import { RunFailure, type CredentialProfile, type QuotaSnapshot } from "@claudexor/schema";
import { preflightCredentialProfile } from "./credential-profile-rotation.js";
import { failTerminally } from "./runTerminalResults.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const RESETS_AT = "2026-08-02T18:00:00.000Z";

const profile: CredentialProfile = {
  profile_id: "valentine",
  harness_id: "claude",
  display_name: "Valentine",
  credential_kind: "config_dir_login",
  isolation_locator: "/tmp/p/valentine",
  secret_ref: null,
  enabled: true,
  created_at: null,
};

const spent: QuotaSnapshot = {
  subject: {
    harness: "claude",
    credential_route: "vendor_native",
    plan_label: null,
    subject_id: "valentine",
  },
  constraints: [
    {
      id: "weekly_scoped:Fable",
      label: "7 day (Fable)",
      used_ratio: 0.91,
      window_seconds: 604800,
      resets_at: RESETS_AT,
      cooldown_until: null,
    },
  ],
  source: "claude_oauth_usage",
  observed_at: "2026-08-02T12:00:00.000Z",
  freshness: "fresh",
};

function refusal(): unknown {
  try {
    preflightCredentialProfile({
      profile,
      harnessId: "claude",
      policy: { limit_action: "fail", rotation_eligible: [], headroom_threshold: 0.9 },
      registry: [profile],
      snapshots: [spent],
      readyProfileIds: new Set(),
      emit: () => {},
    });
  } catch (error) {
    return error;
  }
  throw new Error("preflightCredentialProfile did not refuse a breached headroom under fail");
}

function terminalFailure(error: unknown): RunFailure {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "cx-quota-refusal-")));
  dirs.push(repo);
  const store = new ArtifactStore(repo);
  const paths = store.createRun("run-quota");
  const log = new EventLog(paths.eventsPath, "run-quota", "task-quota");
  failTerminally(log, store, paths, "run-quota", "task-quota", "agent", "routing", error);
  // failure.yaml is the durable contract surface: read it back the way a caller
  // does rather than trusting the argument that was handed to the writer.
  return RunFailure.parse(store.readYaml(join(paths.finalDir, "failure.yaml")));
}

describe("subscription window exhaustion", () => {
  it("refuses with a typed code, category and structural reset time", () => {
    expect(refusal()).toMatchObject({
      code: "subscription_window_exhausted",
      category: "harness_unavailable",
      resetsAt: RESETS_AT,
    });
  });

  it("lands in failure.yaml as machine-readable fields, not prose", () => {
    const failure = terminalFailure(refusal());
    expect(failure.code).toBe("subscription_window_exhausted");
    expect(failure.category).toBe("harness_unavailable");
    expect(failure.resetsAt).toBe(RESETS_AT);
  });

  it("still defaults an untyped throw to internal with no reset time", () => {
    const failure = terminalFailure(new Error("something broke"));
    expect(failure.category).toBe("internal");
    expect(failure.code).toBeNull();
    expect(failure.resetsAt).toBeNull();
  });

  it("ignores a foreign category an unrelated error happens to carry", () => {
    const failure = terminalFailure(
      Object.assign(new Error("adapter said timeout"), { category: "timeout" }),
    );
    expect(failure.category).toBe("internal");
  });
});

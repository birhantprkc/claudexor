import { fsyncSync, mkdtempSync, realpathSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DurableJournal } from "@claudexor/journal";
import { withQuotaAvailability } from "@claudexor/schema";
import { hashJson } from "@claudexor/util";
import { JournalManager } from "./journal-manager.js";
import { QuotaRegistry, quotaProjection } from "./quota-registry.js";

function quotaSnapshot(harness: string, subjectId: string | null, usedRatio: number) {
  return {
    subject: {
      harness,
      credential_route: "vendor_native" as const,
      plan_label: null,
      subject_id: subjectId,
    },
    constraints: [
      {
        id: "five_hour",
        label: "5 hour",
        used_ratio: usedRatio,
        window_seconds: 18_000,
        resets_at: null,
        cooldown_until: null,
      },
    ],
    source: "claude_oauth_usage" as const,
    observed_at: "2026-07-28T00:00:00.000Z",
    freshness: "fresh" as const,
  };
}

describe("QuotaRegistry", () => {
  it("coalesces foreground and background refreshes behind one fenced cycle", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-single-flight-")));
    const journal = new DurableJournal({ rootDir: root, partition: "global" });
    let calls = 0;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const registry = new QuotaRegistry(
      journal,
      [
        async () => {
          calls += 1;
          await blocked;
          return { snapshots: [quotaSnapshot("claude", null, 0.2)] };
        },
      ],
      () => new Date("2026-07-28T00:00:01.000Z"),
    );

    const foreground = registry.refreshWithCursor();
    await Promise.resolve();
    expect(calls).toBe(1);
    const background = registry.pollStale();
    release();

    const [fenced, polled] = await Promise.all([foreground, background]);
    expect(polled).toBe(true);
    expect(calls).toBe(1);
    expect(
      journal
        .records()
        .filter((record) => record.type === "quota.projection.updated")
        .filter((record) => (record.payload as { reason?: unknown }).reason === "refresh"),
    ).toHaveLength(1);
    expect(journal.cursorFor(journal.records().at(-1)!)).toBe(fenced.quotaEventCursor);

    journal.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("retires a held old-credential cycle before delete and recreate can resurrect it", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-generation-delete-")));
    const journal = new DurableJournal({ rootDir: root, partition: "global" });
    let credential: "old" | "new" = "old";
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    let releaseOld!: () => void;
    const oldHeld = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    const registry = new QuotaRegistry(
      journal,
      [
        async () => {
          calls += 1;
          active += 1;
          maxActive = Math.max(maxActive, active);
          const captured = credential;
          try {
            if (calls === 1) await oldHeld;
            return {
              snapshots: [quotaSnapshot("claude", "work", captured === "old" ? 0.2 : 0.7)],
            };
          } finally {
            active -= 1;
          }
        },
      ],
      () => new Date("2026-07-28T00:00:01.000Z"),
    );

    const startedBeforeDelete = registry.refreshWithCursor();
    await Promise.resolve();
    expect(calls).toBe(1);

    registry.removeSubject("claude", "work");
    credential = "new";
    registry.noteCredentialChange();
    const startedAfterRecreate = registry.refreshWithCursor();
    await Promise.resolve();
    expect(calls).toBe(1);

    releaseOld();
    const [beforeDeleteResult, afterRecreateResult] = await Promise.all([
      startedBeforeDelete,
      startedAfterRecreate,
    ]);

    expect(calls).toBe(2);
    expect(maxActive).toBe(1);
    for (const result of [beforeDeleteResult, afterRecreateResult]) {
      expect(result.response.snapshots).toEqual([
        expect.objectContaining({
          subject: expect.objectContaining({ subject_id: "work" }),
          constraints: [expect.objectContaining({ used_ratio: 0.7 })],
        }),
      ]);
    }
    const records = journal.records();
    expect(records.map((record) => record.type)).toEqual([
      "quota.subject.removed",
      "quota.projection.updated",
      "quota.snapshot.upserted",
      "quota.projection.updated",
    ]);
    expect(
      records
        .filter((record) => record.type === "quota.snapshot.upserted")
        .map(
          (record) =>
            (record.payload as ReturnType<typeof quotaSnapshot>).constraints[0]?.used_ratio,
        ),
    ).toEqual([0.7]);
    const finalCursor = journal.cursorFor(records.at(-1)!);
    expect(beforeDeleteResult.quotaEventCursor).toBe(finalCursor);
    expect(afterRecreateResult.quotaEventCursor).toBe(finalCursor);

    journal.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("makes post-login foreground refresh wait for the obsolete poll, then join one new cycle", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-generation-login-")));
    const journal = new DurableJournal({ rootDir: root, partition: "global" });
    const subject = quotaSnapshot("claude", null, 0).subject;
    let credential: "logged_out" | "logged_in" = "logged_out";
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    let releaseOld!: () => void;
    const oldHeld = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    const registry = new QuotaRegistry(
      journal,
      [
        async () => {
          calls += 1;
          active += 1;
          maxActive = Math.max(maxActive, active);
          const captured = credential;
          try {
            if (calls === 1) await oldHeld;
            return captured === "logged_in"
              ? { snapshots: [quotaSnapshot("claude", null, 0.4)] }
              : {
                  snapshots: [],
                  absences: [
                    {
                      subject,
                      reason: "not_logged_in" as const,
                      detail: null,
                      observed_at: "2026-07-28T00:00:00.000Z",
                    },
                  ],
                };
          } finally {
            active -= 1;
          }
        },
      ],
      () => new Date("2026-07-28T00:00:01.000Z"),
      () => [subject],
    );

    const oldPoll = registry.pollStale();
    await Promise.resolve();
    expect(calls).toBe(1);
    credential = "logged_in";
    registry.noteCredentialChange();
    const foreground = registry.refreshWithCursor();
    await Promise.resolve();
    expect(calls).toBe(1);

    releaseOld();
    const [polled, fenced] = await Promise.all([oldPoll, foreground]);
    expect(polled).toBe(false);
    expect(calls).toBe(2);
    expect(maxActive).toBe(1);
    expect(fenced.response.snapshots).toEqual([
      expect.objectContaining({ constraints: [expect.objectContaining({ used_ratio: 0.4 })] }),
    ]);
    expect(fenced.response.absences).toEqual([]);
    const records = journal.records();
    expect(
      records
        .filter((record) => record.type === "quota.snapshot.upserted")
        .map(
          (record) =>
            (record.payload as ReturnType<typeof quotaSnapshot>).constraints[0]?.used_ratio,
        ),
    ).toEqual([0.4]);
    expect(
      records.filter(
        (record) =>
          record.type === "quota.projection.updated" &&
          (record.payload as { reason?: unknown }).reason === "refresh",
      ),
    ).toHaveLength(1);
    expect(fenced.quotaEventCursor).toBe(journal.cursorFor(records.at(-1)!));

    journal.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("reports a current-generation failure instead of an obsolete success", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-generation-failure-")));
    const journal = new DurableJournal({ rootDir: root, partition: "global" });
    let calls = 0;
    let releaseOld!: () => void;
    const oldHeld = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    const registry = new QuotaRegistry(journal, [
      async () => {
        calls += 1;
        if (calls === 1) {
          await oldHeld;
          return { snapshots: [quotaSnapshot("claude", null, 0.2)] };
        }
        throw new Error("new credential unavailable");
      },
    ]);

    const obsoleteCaller = registry.refresh();
    await Promise.resolve();
    registry.noteCredentialChange();
    const currentCaller = registry.refreshWithCursor();
    releaseOld();

    const outcomes = await Promise.allSettled([obsoleteCaller, currentCaller]);
    expect(calls).toBe(2);
    expect(outcomes).toEqual([
      expect.objectContaining({
        status: "rejected",
        reason: expect.objectContaining({ code: "quota_refresh_unavailable", status: 503 }),
      }),
      expect.objectContaining({
        status: "rejected",
        reason: expect.objectContaining({ code: "quota_refresh_unavailable", status: 503 }),
      }),
    ]);
    expect(journal.records()).toEqual([]);
    expect(registry.read().snapshots).toEqual([]);

    journal.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("starts top-level refreshers together but folds validated results in declaration order", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-parallel-")));
    const journal = new DurableJournal({ rootDir: root, partition: "global" });
    const started: string[] = [];
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const missing = quotaSnapshot("claude", "missing", 0).subject;
    const registry = new QuotaRegistry(
      journal,
      [
        async () => {
          started.push("first");
          await firstGate;
          return {
            snapshots: [quotaSnapshot("claude", "first", 0.2)],
            absences: [
              {
                subject: missing,
                reason: "not_logged_in" as const,
                detail: "first claim",
                observed_at: "2026-07-28T00:00:01.000Z",
              },
            ],
          };
        },
        async () => {
          started.push("second");
          await secondGate;
          return {
            snapshots: [
              {
                ...quotaSnapshot("codex", "second", 0.4),
                source: "codex_app_server" as const,
              },
            ],
            absences: [
              {
                subject: missing,
                reason: "refresh_failed" as const,
                detail: "second claim",
                observed_at: "2026-07-28T00:00:01.000Z",
              },
            ],
          };
        },
      ],
      () => new Date("2026-07-28T00:00:01.000Z"),
      () => [missing],
    );

    const refreshing = registry.refresh();
    await Promise.resolve();
    expect(started).toEqual(["first", "second"]);
    releaseSecond();
    await Promise.resolve();
    expect(journal.records()).toEqual([]);
    releaseFirst();
    const response = await refreshing;

    expect(response.snapshots.map((snapshot) => snapshot.source)).toEqual([
      "claude_oauth_usage",
      "codex_app_server",
    ]);
    expect(response.absences).toEqual([expect.objectContaining({ detail: "first claim" })]);
    expect(journal.records().map((record) => record.type)).toEqual([
      "quota.snapshot.upserted",
      "quota.snapshot.upserted",
      "quota.projection.updated",
    ]);

    journal.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("validates snapshots and absences from every source before its first write", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-validate-batch-")));
    const journal = new DurableJournal({ rootDir: root, partition: "global" });
    const registry = new QuotaRegistry(journal, [
      async () => ({
        snapshots: [quotaSnapshot("claude", null, 0.2)],
        absences: [
          {
            subject: quotaSnapshot("claude", "missing", 0).subject,
            reason: "not_logged_in" as const,
            detail: 42 as never,
            observed_at: "2026-07-28T00:00:01.000Z",
          },
        ],
      }),
      async () => Promise.reject(new Error("second source unavailable")),
    ]);

    await expect(registry.refresh()).rejects.toMatchObject({
      code: "quota_refresh_unavailable",
      status: 503,
    });
    expect(journal.records()).toEqual([]);
    expect(registry.read().snapshots).toEqual([]);

    journal.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("fences one refresh marker after the whole batch and replays only later direct mutations", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-fence-")));
    const now = () => new Date("2026-07-28T00:00:01.000Z");
    const manager = new JournalManager(root, {
      now,
    });
    const slot = manager.registerProjection(
      quotaProjection(
        [
          async () => ({
            snapshots: [quotaSnapshot("claude", null, 0.2), quotaSnapshot("claude", "work", 0.4)],
          }),
        ],
        () => [],
        now,
      ),
    );
    manager.start();

    const fenced = await slot.current().refreshWithCursor();
    expect(fenced.response.snapshots).toHaveLength(2);
    const refreshEvents = manager.events();
    expect(refreshEvents.map((event) => event.type)).toEqual([
      "quota.snapshot.upserted",
      "quota.snapshot.upserted",
      "quota.projection.updated",
    ]);
    expect(refreshEvents.at(-1)?.payload).toMatchObject({ reason: "refresh" });
    expect(manager.events(fenced.quotaEventCursor)).toEqual([]);

    slot.current().upsert(quotaSnapshot("claude", "later", 0.6));
    const laterEvents = manager.events(fenced.quotaEventCursor);
    expect(laterEvents.map((event) => event.type)).toEqual([
      "quota.snapshot.upserted",
      "quota.projection.updated",
    ]);
    expect(laterEvents.at(-1)?.payload).toMatchObject({ reason: "direct_mutation" });
    const afterUpsertCursor = manager.events().at(-1)?.cursor;
    expect(afterUpsertCursor).toBeTruthy();

    slot.current().removeSubject("claude", "later");
    expect(manager.events(afterUpsertCursor).map((event) => event.type)).toEqual([
      "quota.subject.removed",
      "quota.projection.updated",
    ]);

    manager.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("emits a fenced projection marker for an absence-only successful refresh", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-absence-fence-")));
    const subject = {
      harness: "claude",
      credential_route: "vendor_native" as const,
      plan_label: null,
      subject_id: null,
    };
    const manager = new JournalManager(root, {
      now: () => new Date("2026-07-28T00:00:02.000Z"),
    });
    const slot = manager.registerProjection(
      quotaProjection(
        [
          async () => ({
            snapshots: [],
            absences: [
              {
                subject,
                reason: "not_logged_in" as const,
                detail: null,
                observed_at: "2026-07-28T00:00:02.000Z",
              },
            ],
          }),
        ],
        () => [subject],
      ),
    );
    manager.start();

    const fenced = await slot.current().refreshWithCursor();
    expect(fenced.response.snapshots).toEqual([]);
    expect(fenced.response.absences).toHaveLength(1);
    const events = manager.events();
    expect(events.map((event) => event.type)).toEqual(["quota.projection.updated"]);
    expect(events[0]?.payload).toMatchObject({ reason: "refresh" });
    expect(manager.events(fenced.quotaEventCursor)).toEqual([]);

    manager.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("closes a recovered raw-mutation gap with one projection marker", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-recovery-marker-")));
    const first = new DurableJournal({ rootDir: root, partition: "global" });
    first.append("quota.snapshot.upserted", quotaSnapshot("claude", "work", 0.4));
    first.close();

    const afterUpsert = new DurableJournal({ rootDir: root, partition: "global" });
    const now = () => new Date("2026-07-28T00:00:01.000Z");
    const recovered = new QuotaRegistry(afterUpsert, [], now);
    expect(recovered.read().snapshots).toHaveLength(1);
    expect(afterUpsert.records().map((record) => record.type)).toEqual([
      "quota.snapshot.upserted",
      "quota.projection.updated",
    ]);
    expect(afterUpsert.records().at(-1)?.payload).toMatchObject({ reason: "recovery" });

    // A separately durable removal has the same crash boundary. Restart must
    // publish its recovered empty projection instead of leaving subscribers at
    // the preceding marker forever.
    afterUpsert.append("quota.subject.removed", { harness: "claude", subject_id: "work" });
    afterUpsert.close();
    const afterRemove = new DurableJournal({ rootDir: root, partition: "global" });
    const recoveredRemoval = new QuotaRegistry(afterRemove, [], now);
    expect(recoveredRemoval.read().snapshots).toEqual([]);
    expect(afterRemove.records().at(-1)?.payload).toMatchObject({ reason: "recovery" });
    afterRemove.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("ingests a typed harness quota event with its exact credential route", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-ingest-")));
    const manager = new JournalManager(root);
    const slot = manager.registerProjection(quotaProjection());
    manager.start();
    slot.current().ingest("codex", {
      type: "usage",
      session_id: "session-1",
      ts: new Date().toISOString(),
      credential_route: "vendor_native",
      quota: {
        source: "codex_rollout",
        plan_label: null,
        subject_id: null,
        constraints: [
          {
            id: "primary",
            label: "5 hour",
            used_ratio: 0.1,
            window_seconds: 18000,
            resets_at: new Date(Date.now() + 3600000).toISOString(),
            cooldown_until: null,
          },
        ],
      },
    });
    expect(slot.current().read().snapshots[0]).toMatchObject({
      subject: { harness: "codex", credential_route: "vendor_native" },
      source: "codex_rollout",
    });
    slot.current().ingest("codex", {
      type: "error",
      session_id: "session-1",
      ts: new Date().toISOString(),
      error: "rate limited",
      credential_route: "vendor_native",
      rate_limit: { resets_at: null, retry_delay_ms: 60_000 },
    });
    expect(
      slot
        .current()
        .read()
        .snapshots[0]?.constraints.map((item) => item.id),
    ).toEqual(["primary", "cooldown"]);
    manager.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("a profiled quota event registers under ITS profile subject, never the engine default (round-17 #2)", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-subject-")));
    const manager = new JournalManager(root);
    const slot = manager.registerProjection(quotaProjection());
    manager.start();
    slot.current().ingest("codex", {
      type: "usage",
      session_id: "session-1",
      ts: new Date().toISOString(),
      credential_route: "vendor_native",
      credential_profile_id: "acc2",
      quota: {
        source: "codex_rollout",
        plan_label: null,
        // The vendor rollout record carries no subject of its own — the
        // event's Claudexor profile stamp is the credential identity.
        subject_id: null,
        constraints: [
          {
            id: "primary",
            label: "5 hour",
            used_ratio: 0.7,
            window_seconds: 18000,
            resets_at: new Date(Date.now() + 3600000).toISOString(),
            cooldown_until: null,
          },
        ],
      },
    });
    expect(slot.current().read().snapshots[0]?.subject).toMatchObject({
      harness: "codex",
      credential_route: "vendor_native",
      subject_id: "acc2",
    });
    expect(slot.current().removeSubject("codex", "acc2")).toBe(1);
    expect(slot.current().read().snapshots).toEqual([]);
    manager.close();
    const restarted = new JournalManager(root);
    const restartedSlot = restarted.registerProjection(quotaProjection());
    restarted.start();
    expect(restartedSlot.current().read().snapshots).toEqual([]);
    restarted.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("records Claude api_retry cooldowns as retry evidence, never as statusline quota", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-claude-retry-")));
    const manager = new JournalManager(root);
    const slot = manager.registerProjection(quotaProjection());
    manager.start();
    slot.current().ingest("claude", {
      type: "thinking",
      session_id: "session-claude",
      // Recent: observations older than 24h are pruned from reads (W17).
      ts: new Date().toISOString(),
      text: "api_retry",
      payload: { api_retry: true },
      credential_route: "managed_api_key",
      credential_source: "api_key_env",
      rate_limit: { resets_at: null, retry_delay_ms: 30_000 },
    });

    expect(slot.current().read().snapshots).toEqual([
      expect.objectContaining({
        subject: expect.objectContaining({
          harness: "claude",
          credential_route: "managed_api_key",
        }),
        source: "claude_api_retry",
        constraints: [expect.objectContaining({ id: "cooldown" })],
      }),
    ]);
    manager.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("persists independent model-scoped Claude cooldown windows", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-claude-model-cooldown-")));
    const manager = new JournalManager(root);
    const slot = manager.registerProjection(quotaProjection());
    manager.start();
    for (const [constraintId, aliases] of [
      ["seven_day_opus", ["opus", "claude-opus-5", "best"]],
      ["seven_day_sonnet", ["sonnet", "claude-sonnet-5", "best"]],
    ] as const) {
      slot.current().ingest("claude", {
        type: "status",
        session_id: `session-${constraintId}`,
        ts: new Date().toISOString(),
        credential_route: "vendor_native",
        rate_limit: {
          constraint_id: constraintId,
          applies_to_models: aliases,
          resets_at: null,
          retry_delay_ms: 30_000,
        },
      });
    }
    expect(slot.current().read().snapshots[0]?.constraints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "cooldown:seven_day_opus",
          applies_to_models: ["opus", "claude-opus-5", "best"],
        }),
        expect.objectContaining({
          id: "cooldown:seven_day_sonnet",
          applies_to_models: ["sonnet", "claude-sonnet-5", "best"],
        }),
      ]),
    );
    manager.close();
    const restarted = new JournalManager(root);
    const restartedSlot = restarted.registerProjection(quotaProjection());
    restarted.start();
    expect(restartedSlot.current().read().snapshots[0]?.constraints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "cooldown:seven_day_opus",
          applies_to_models: ["opus", "claude-opus-5", "best"],
        }),
        expect.objectContaining({
          id: "cooldown:seven_day_sonnet",
          applies_to_models: ["sonnet", "claude-sonnet-5", "best"],
        }),
      ]),
    );
    restarted.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps the durable base upsert readable by v3.2.0 while replaying model scopes", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-rollback-compat-")));
    const now = () => new Date("2026-07-28T00:00:01.000Z");
    const first = new DurableJournal({ rootDir: root, partition: "global" });
    const registry = new QuotaRegistry(first, [], now);
    registry.upsert({
      ...quotaSnapshot("claude", null, 1),
      constraints: [
        {
          id: "weekly_scoped:Fable 5",
          label: "7 day (Fable 5)",
          applies_to_models: ["fable", "claude-fable-5", "best"],
          used_ratio: 1,
          window_seconds: 604_800,
          resets_at: null,
          cooldown_until: null,
        },
      ],
    });

    const records = first.records();
    expect(records.map((record) => record.type)).toEqual([
      "quota.snapshot.scoped_prepared",
      "quota.snapshot.upserted",
      "quota.projection.updated",
    ]);
    const prepared = records[0]?.payload as {
      version?: unknown;
      base_hash?: unknown;
      snapshot?: { constraints?: Array<Record<string, unknown>> };
    };
    expect(prepared.version).toBe(1);
    expect(prepared.base_hash).toEqual(expect.any(String));
    expect(prepared.snapshot?.constraints?.[0]).toMatchObject({
      applies_to_models: ["fable", "claude-fable-5", "best"],
    });
    const legacy = records[1]?.payload as {
      subject?: Record<string, unknown>;
      constraints?: Array<Record<string, unknown>>;
    };
    expect(legacy.constraints?.[0]).not.toHaveProperty("applies_to_models");
    expect(Object.keys(legacy).sort()).toEqual([
      "constraints",
      "freshness",
      "observed_at",
      "source",
      "subject",
    ]);
    expect(Object.keys(legacy.subject ?? {}).sort()).toEqual([
      "credential_route",
      "harness",
      "plan_label",
      "subject_id",
    ]);
    expect(Object.keys(legacy.constraints?.[0] ?? {}).sort()).toEqual([
      "cooldown_until",
      "id",
      "label",
      "resets_at",
      "used_ratio",
      "window_seconds",
    ]);
    first.close();

    const replay = new DurableJournal({ rootDir: root, partition: "global" });
    const recovered = new QuotaRegistry(replay, [], now);
    expect(recovered.read().snapshots[0]?.constraints[0]).toMatchObject({
      id: "weekly_scoped:Fable 5",
      applies_to_models: ["fable", "claude-fable-5", "best"],
    });
    replay.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps server availability out of raw journal payloads and projection signatures", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-raw-availability-")));
    const journal = new DurableJournal({ rootDir: root, partition: "global" });
    const registry = new QuotaRegistry(journal, [], () => new Date("2026-07-28T00:00:01.000Z"));
    registry.upsert({
      ...quotaSnapshot("claude", "work", 1),
      constraints: [
        {
          ...quotaSnapshot("claude", "work", 1).constraints[0]!,
          resets_at: "2026-07-28T01:00:00.000Z",
        },
      ],
    });

    const raw = registry.read();
    const decorated = withQuotaAvailability(raw, {
      now: new Date("2026-07-28T00:00:01.000Z"),
    });
    expect(decorated.snapshots[0]?.availability?.state).toBe("exhausted");
    expect(raw.snapshots[0]).not.toHaveProperty("availability");
    expect(journal.records()[0]?.payload).not.toHaveProperty("availability");
    expect(journal.records().at(-1)?.payload).toMatchObject({
      projection_signature: JSON.stringify({
        snapshots: raw.snapshots,
        absences: raw.absences,
      }),
    });

    journal.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("discards a scoped prepare when its atomic batch stops before the base commit", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-batch-stop-")));
    const interrupted = new DurableJournal({
      rootDir: root,
      partition: "global",
      appendAndSync: (fd, batch) => {
        const secondFrameOffset = batch.indexOf(batch.subarray(0, 8), 8);
        expect(secondFrameOffset).toBeGreaterThan(0);
        writeSync(fd, batch, 0, secondFrameOffset);
        fsyncSync(fd);
        throw new Error("simulated stop between scoped prepare and base commit");
      },
    });
    const registry = new QuotaRegistry(interrupted, [], () => new Date("2026-07-28T00:00:01.000Z"));
    expect(() =>
      registry.upsert({
        ...quotaSnapshot("claude", null, 1),
        constraints: [
          {
            id: "weekly_scoped:Fable 5",
            label: "7 day (Fable 5)",
            applies_to_models: ["fable"],
            used_ratio: 1,
            window_seconds: 604_800,
            resets_at: null,
            cooldown_until: null,
          },
        ],
      }),
    ).toThrow(/append\/fsync completion is uncertain/);
    interrupted.close();

    const replay = new DurableJournal({ rootDir: root, partition: "global" });
    const recovered = new QuotaRegistry(replay, [], () => new Date("2026-07-28T00:00:01.000Z"));
    expect(recovered.read().snapshots).toEqual([]);
    expect(replay.records().map((record) => record.type)).toEqual([
      "journal.recovery_tail_discarded",
    ]);
    // A rolled-back 3.2.0 writer may later append the identical conservative
    // base. Because the interrupted batch was fully truncated, current replay
    // must not resurrect its stale scope by pairing that later old-engine row.
    replay.append("quota.snapshot.upserted", quotaSnapshot("claude", null, 1));
    replay.close();

    const afterOldWrite = new DurableJournal({ rootDir: root, partition: "global" });
    const afterOldWriteRegistry = new QuotaRegistry(
      afterOldWrite,
      [],
      () => new Date("2026-07-28T00:00:01.000Z"),
    );
    expect(afterOldWriteRegistry.read().snapshots[0]?.constraints[0]).not.toHaveProperty(
      "applies_to_models",
    );
    afterOldWrite.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("falls back to the compatible base for malformed or future scoped prepares", () => {
    const base = quotaSnapshot("claude", null, 0.2);
    const scoped = {
      ...base,
      constraints: base.constraints.map((constraint) => ({
        ...constraint,
        applies_to_models: ["fable"],
      })),
    };
    const prepares: unknown[] = [
      null,
      { version: 1, base_hash: hashJson(base), snapshot: { malformed: true } },
      { version: 2, base_hash: hashJson(base), snapshot: scoped },
    ];
    for (const [index, prepare] of prepares.entries()) {
      const root = realpathSync(
        mkdtempSync(join(tmpdir(), `claudexor-quota-future-prepare-${index}-`)),
      );
      const first = new DurableJournal({ rootDir: root, partition: "global" });
      first.appendBatch([
        { type: "quota.snapshot.scoped_prepared", payload: prepare },
        { type: "quota.snapshot.upserted", payload: base },
      ]);
      first.close();

      const replay = new DurableJournal({ rootDir: root, partition: "global" });
      const recovered = new QuotaRegistry(replay, [], () => new Date("2026-07-28T00:00:01.000Z"));
      expect(recovered.read().snapshots[0]?.constraints[0]).toMatchObject({
        id: "five_hour",
        used_ratio: 0.2,
      });
      expect(recovered.read().snapshots[0]?.constraints[0]).not.toHaveProperty("applies_to_models");
      replay.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lets a later unscoped commit replace a previously scoped snapshot on replay", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-unscoped-replace-")));
    const now = () => new Date("2026-07-28T00:00:01.000Z");
    const first = new DurableJournal({ rootDir: root, partition: "global" });
    const registry = new QuotaRegistry(first, [], now);
    registry.upsert({
      ...quotaSnapshot("claude", null, 1),
      constraints: [
        {
          id: "five_hour",
          label: "5 hour",
          applies_to_models: ["fable"],
          used_ratio: 1,
          window_seconds: 18_000,
          resets_at: null,
          cooldown_until: null,
        },
      ],
    });
    registry.upsert(quotaSnapshot("claude", null, 0.2));
    first.close();

    const replay = new DurableJournal({ rootDir: root, partition: "global" });
    const recovered = new QuotaRegistry(replay, [], now);
    expect(recovered.read().snapshots[0]?.constraints[0]).toMatchObject({
      id: "five_hour",
      used_ratio: 0.2,
    });
    expect(recovered.read().snapshots[0]?.constraints[0]).not.toHaveProperty("applies_to_models");
    replay.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps a new scoped cooldown fresh after an older sibling reset expires", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-claude-cooldown-expiry-")));
    let now = new Date("2026-08-03T00:00:00.000Z");
    const manager = new JournalManager(root);
    const slot = manager.registerProjection(
      quotaProjection(
        [],
        () => [],
        () => now,
      ),
    );
    manager.start();
    slot.current().ingest("claude", {
      type: "status",
      session_id: "session-opus",
      ts: now.toISOString(),
      credential_route: "vendor_native",
      rate_limit: {
        constraint_id: "seven_day_opus",
        applies_to_models: ["opus", "claude-opus-5", "best"],
        resets_at: "2026-08-03T00:00:01.000Z",
        retry_delay_ms: null,
      },
    });
    now = new Date("2026-08-03T00:00:02.000Z");
    slot.current().ingest("claude", {
      type: "status",
      session_id: "session-sonnet",
      ts: now.toISOString(),
      credential_route: "vendor_native",
      rate_limit: {
        constraint_id: "seven_day_sonnet",
        applies_to_models: ["sonnet", "claude-sonnet-5", "best"],
        resets_at: "2026-08-03T00:01:02.000Z",
        retry_delay_ms: null,
      },
    });
    expect(slot.current().read().snapshots).toEqual([
      expect.objectContaining({
        freshness: "fresh",
        constraints: [
          expect.objectContaining({
            id: "cooldown:seven_day_sonnet",
            applies_to_models: ["sonnet", "claude-sonnet-5", "best"],
          }),
        ],
      }),
    ]);
    manager.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("persists all windows and marks expired data stale without fabricating zero usage", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-")));
    const first = new JournalManager(root);
    const slot = first.registerProjection(quotaProjection());
    first.start();
    slot.current().upsert({
      subject: {
        harness: "codex",
        credential_route: "vendor_native",
        plan_label: "Plus",
        subject_id: null,
      },
      source: "codex_app_server",
      // Old enough to be STALE (>5min, reset passed) but well inside the 24h
      // prune horizon — the row must be kept and honestly marked, not hidden.
      observed_at: new Date(Date.now() - 10 * 60_000).toISOString(),
      freshness: "fresh",
      constraints: [
        {
          id: "primary",
          label: "5 hour",
          used_ratio: 0.42,
          window_seconds: 18_000,
          resets_at: new Date(Date.now() - 5 * 60_000).toISOString(),
          cooldown_until: null,
        },
        {
          id: "secondary",
          label: "Weekly",
          used_ratio: null,
          window_seconds: 604_800,
          resets_at: null,
          cooldown_until: null,
        },
      ],
    });
    first.close();

    const reopened = new JournalManager(root);
    const replayed = reopened.registerProjection(quotaProjection());
    reopened.start();
    const value = replayed.current().read();
    expect(value.snapshots[0]?.freshness).toBe("stale");
    expect(value.snapshots[0]?.constraints).toHaveLength(2);
    expect(value.snapshots[0]?.constraints[0]?.used_ratio).toBe(0.42);
    expect(value.snapshots[0]?.constraints[1]?.used_ratio).toBeNull();
    reopened.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("polls empty or stale official sources with bounded failure backoff", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-poll-")));
    const journal = new DurableJournal({ rootDir: join(root, "journal"), partition: "global" });
    let nowMs = Date.parse("2026-07-15T12:00:00.000Z");
    let calls = 0;
    const registry = new QuotaRegistry(
      journal,
      [
        async () => {
          calls += 1;
          if (calls === 1) throw new Error("offline");
          return {
            snapshots: [
              {
                subject: {
                  harness: "codex",
                  credential_route: "vendor_native",
                  plan_label: "Plus",
                  subject_id: null,
                },
                constraints: [],
                source: "codex_app_server",
                observed_at: new Date(nowMs).toISOString(),
                freshness: "fresh",
              },
            ],
          };
        },
      ],
      () => new Date(nowMs),
    );

    await expect(registry.pollStale()).resolves.toBe(false);
    await expect(registry.pollStale()).resolves.toBe(false);
    expect(calls).toBe(1);
    nowMs += 60_000;
    await expect(registry.pollStale()).resolves.toBe(true);
    expect(calls).toBe(2);
    expect(registry.read().snapshots).toEqual([
      expect.objectContaining({ source: "codex_app_server", freshness: "fresh", constraints: [] }),
    ]);
    await expect(registry.pollStale()).resolves.toBe(false);
    expect(calls).toBe(2);

    journal.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("coalesces the whole poll and anchors absence backoff to a held cycle's completion", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-poll-held-")));
    const journal = new DurableJournal({ rootDir: root, partition: "global" });
    let nowMs = Date.parse("2026-07-28T00:00:00.000Z");
    let calls = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const subject = quotaSnapshot("codex", null, 0).subject;
    const registry = new QuotaRegistry(
      journal,
      [
        async () => {
          calls += 1;
          if (calls === 1) await held;
          return {
            snapshots: [],
            absences: [
              {
                subject,
                reason: "not_logged_in" as const,
                detail: null,
                observed_at: new Date(nowMs).toISOString(),
              },
            ],
          };
        },
      ],
      () => new Date(nowMs),
      () => [subject],
    );

    const first = registry.pollStale();
    const concurrent = registry.pollStale();
    expect(concurrent).toBe(first);
    await Promise.resolve();
    expect(calls).toBe(1);
    nowMs += 70_000;
    release();
    await expect(Promise.all([first, concurrent])).resolves.toEqual([true, true]);
    const afterFirstCycle = journal.records().length;
    expect(afterFirstCycle).toBe(2); // initial clock fence + one refresh fence
    expect(
      journal
        .records()
        .filter(
          (record) =>
            record.type === "quota.projection.updated" &&
            (record.payload as { reason?: unknown }).reason === "refresh",
        ),
    ).toHaveLength(1);

    // Backoff begins at completedAt (t+70s), not the stale t=0 start.
    nowMs += 59_999;
    await expect(registry.pollStale()).resolves.toBe(false);
    expect(calls).toBe(1);
    expect(journal.records()).toHaveLength(afterFirstCycle);
    nowMs += 1;
    await expect(registry.pollStale()).resolves.toBe(true);
    expect(calls).toBe(2);
    expect(journal.records()).toHaveLength(afterFirstCycle + 1);
    expect(
      journal
        .records()
        .filter(
          (record) =>
            record.type === "quota.projection.updated" &&
            (record.payload as { reason?: unknown }).reason === "refresh",
        ),
    ).toHaveLength(2);

    journal.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("demands fresh matching primary evidence per subject and ignores reactive/spool freshness", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-primary-demand-")));
    const journal = new DurableJournal({ rootDir: root, partition: "global" });
    const now = () => new Date("2026-07-28T00:00:01.000Z");
    const native = quotaSnapshot("codex", null, 0.2).subject;
    const work = quotaSnapshot("codex", "work", 0.3).subject;
    let calls = 0;
    const registry = new QuotaRegistry(
      journal,
      [
        async () => {
          calls += 1;
          return {
            snapshots: [
              {
                ...quotaSnapshot("codex", "work", 0.4),
                source: "codex_app_server" as const,
                observed_at: now().toISOString(),
              },
            ],
          };
        },
      ],
      now,
      () => [native, work],
    );
    registry.upsert({
      ...quotaSnapshot("codex", null, 0.2),
      source: "codex_app_server",
      observed_at: now().toISOString(),
    });
    registry.upsert({
      ...quotaSnapshot("codex", "work", 0.3),
      source: "codex_rollout",
      observed_at: now().toISOString(),
    });

    await expect(registry.pollStale()).resolves.toBe(true);
    expect(calls).toBe(1);
    expect(registry.read().snapshots.map((snapshot) => snapshot.source)).toEqual([
      "codex_app_server",
      "codex_rollout",
      "codex_app_server",
    ]);
    await expect(registry.pollStale()).resolves.toBe(false);
    expect(calls).toBe(1);

    // A stale reactive sibling does not create demand after primary evidence
    // for that same subject is fresh.
    registry.upsert({
      ...quotaSnapshot("codex", null, 0.5),
      source: "codex_rollout",
      observed_at: "2026-07-27T23:00:00.000Z",
    });
    await expect(registry.pollStale()).resolves.toBe(false);
    expect(calls).toBe(1);

    journal.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps exponential pacing while any enabled subject remains unsatisfied", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-partial-backoff-")));
    const journal = new DurableJournal({ rootDir: root, partition: "global" });
    let nowMs = Date.parse("2026-07-28T00:00:00.000Z");
    let calls = 0;
    const native = quotaSnapshot("codex", null, 0).subject;
    const work = quotaSnapshot("codex", "work", 0).subject;
    const registry = new QuotaRegistry(
      journal,
      [
        async () => {
          calls += 1;
          return {
            snapshots: [
              {
                ...quotaSnapshot("codex", null, 0.2),
                source: "codex_app_server" as const,
                observed_at: new Date(nowMs).toISOString(),
              },
            ],
          };
        },
      ],
      () => new Date(nowMs),
      () => [native, work],
    );

    await expect(registry.pollStale()).resolves.toBe(true);
    nowMs += 60_000;
    await expect(registry.pollStale()).resolves.toBe(true);
    expect(calls).toBe(2);
    nowMs += 60_000;
    await expect(registry.pollStale()).resolves.toBe(false);
    expect(calls).toBe(2);
    nowMs += 60_000;
    await expect(registry.pollStale()).resolves.toBe(true);
    expect(calls).toBe(3);

    journal.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("publishes a clock-derived freshness transition even when refresh fails", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-clock-marker-")));
    const journal = new DurableJournal({ rootDir: root, partition: "global" });
    let nowMs = Date.parse("2026-07-28T00:00:00.000Z");
    const registry = new QuotaRegistry(
      journal,
      [async () => Promise.reject(new Error("vendor offline"))],
      () => new Date(nowMs),
    );
    registry.upsert(quotaSnapshot("claude", "work", 0.8));
    const before = journal.records().length;

    nowMs += 6 * 60_000;
    await expect(registry.pollStale()).resolves.toBe(false);
    expect(registry.read().snapshots[0]?.freshness).toBe("stale");
    expect(journal.records()).toHaveLength(before + 1);
    expect(journal.records().at(-1)?.payload).toMatchObject({ reason: "clock_transition" });

    // The logical projection did not change again; the failed-refresh backoff
    // and signature fence prevent marker chatter.
    await expect(registry.pollStale()).resolves.toBe(false);
    expect(journal.records()).toHaveLength(before + 1);

    journal.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("an absence-only refresh cycle backs off exponentially without throwing", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-absence-backoff-")));
    const journal = new DurableJournal({ rootDir: join(root, "journal"), partition: "global" });
    let nowMs = Date.parse("2026-07-15T12:00:00.000Z");
    let calls = 0;
    let mode: "absence" | "fresh" | "stale" = "absence";
    const subject = {
      harness: "claude",
      credential_route: "vendor_native" as const,
      plan_label: null,
      subject_id: null,
    };
    const registry = new QuotaRegistry(
      journal,
      [
        async () => {
          calls += 1;
          if (mode !== "absence") {
            return {
              snapshots: [
                {
                  subject,
                  constraints: [],
                  source: "claude_oauth_usage" as const,
                  observed_at: new Date(
                    mode === "fresh" ? nowMs : nowMs - 10 * 60_000,
                  ).toISOString(),
                  freshness: "fresh" as const,
                },
              ],
            };
          }
          return {
            snapshots: [],
            absences: [
              {
                subject,
                reason: "not_logged_in" as const,
                detail: "logged out",
                observed_at: new Date(nowMs).toISOString(),
              },
            ],
          };
        },
      ],
      () => new Date(nowMs),
      () => [subject],
    );

    // Cycle 1: an absence-only refresh records the typed absence and arms a 60s
    // backoff. It SUCCEEDS (returns true) and never throws.
    await expect(registry.pollStale()).resolves.toBe(true);
    expect(calls).toBe(1);
    expect(registry.read().absences).toHaveLength(1);
    // A second poll inside the 60s window is skipped — pollNotBefore honored.
    await expect(registry.pollStale()).resolves.toBe(false);
    expect(calls).toBe(1);

    // The interval doubles per absence-only cycle; poll exactly at each boundary.
    nowMs += 60_000; // 2^0 window elapsed
    await expect(registry.pollStale()).resolves.toBe(true);
    expect(calls).toBe(2);
    nowMs += 60_000; // half of the 2^1 (120s) window — still skipped
    await expect(registry.pollStale()).resolves.toBe(false);
    expect(calls).toBe(2);
    nowMs += 60_000; // 2^1 window elapsed
    await expect(registry.pollStale()).resolves.toBe(true);
    expect(calls).toBe(3);

    // Saturate the backoff at the 15-minute ceiling: a full 15 min each step
    // clears whatever the (capped) window is.
    for (let step = 0; step < 6; step += 1) {
      nowMs += 15 * 60_000;
      await expect(registry.pollStale()).resolves.toBe(true);
    }
    const atCeiling = calls;
    // The window never exceeds 15 min: one ms short is skipped, at the ceiling fires.
    nowMs += 15 * 60_000 - 1;
    await expect(registry.pollStale()).resolves.toBe(false);
    expect(calls).toBe(atCeiling);
    nowMs += 1;
    await expect(registry.pollStale()).resolves.toBe(true);
    expect(calls).toBe(atCeiling + 1);

    // Only a cycle that satisfies ALL demand resets the exponential history.
    mode = "fresh";
    nowMs += 15 * 60_000;
    await expect(registry.pollStale()).resolves.toBe(true);
    const afterReset = calls;
    await expect(registry.pollStale()).resolves.toBe(false);
    expect(calls).toBe(afterReset);

    // Once that primary evidence ages stale, the next partial cycle starts a
    // fresh 60s backoff rather than inheriting the former 15-minute ceiling.
    mode = "stale";
    nowMs += 6 * 60_000;
    await expect(registry.pollStale()).resolves.toBe(true);
    const afterStale = calls;
    nowMs += 30_000;
    await expect(registry.pollStale()).resolves.toBe(false);
    expect(calls).toBe(afterStale);
    nowMs += 30_000;
    await expect(registry.pollStale()).resolves.toBe(true);
    expect(calls).toBe(afterStale + 1);

    journal.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("noteCredentialChange drops the absence backoff", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-note-cred-")));
    const journal = new DurableJournal({ rootDir: join(root, "journal"), partition: "global" });
    let nowMs = Date.parse("2026-07-15T12:00:00.000Z");
    let calls = 0;
    const subject = {
      harness: "claude",
      credential_route: "vendor_native" as const,
      plan_label: null,
      subject_id: null,
    };
    const registry = new QuotaRegistry(
      journal,
      [
        async () => {
          calls += 1;
          return {
            snapshots: [],
            absences: [
              {
                subject,
                reason: "not_logged_in" as const,
                detail: "logged out",
                observed_at: new Date(nowMs).toISOString(),
              },
            ],
          };
        },
      ],
      () => new Date(nowMs),
      () => [subject],
    );

    // Arm the backoff: one absence-only cycle, then confirm the next immediate
    // poll is inside the 60s window and is skipped.
    await expect(registry.pollStale()).resolves.toBe(true);
    expect(calls).toBe(1);
    await expect(registry.pollStale()).resolves.toBe(false);
    expect(calls).toBe(1);

    // A credential change (login/logout) drops the backoff — the very next poll
    // runs the refresher at once, without waiting out the window.
    registry.noteCredentialChange();
    await expect(registry.pollStale()).resolves.toBe(true);
    expect(calls).toBe(2);

    journal.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("does not let an in-flight old-credential poll restore backoff after reset", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-note-inflight-")));
    const journal = new DurableJournal({ rootDir: root, partition: "global" });
    const subject = quotaSnapshot("claude", null, 0).subject;
    let calls = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const registry = new QuotaRegistry(
      journal,
      [
        async () => {
          calls += 1;
          if (calls === 1) await held;
          return {
            snapshots: [],
            absences: [
              {
                subject,
                reason: "not_logged_in" as const,
                detail: null,
                observed_at: "2026-07-28T00:00:00.000Z",
              },
            ],
          };
        },
      ],
      () => new Date("2026-07-28T00:00:00.000Z"),
      () => [subject],
    );

    const oldPoll = registry.pollStale();
    await Promise.resolve();
    expect(calls).toBe(1);
    registry.noteCredentialChange();
    release();
    await expect(oldPoll).resolves.toBe(false);
    await expect(registry.pollStale()).resolves.toBe(true);
    expect(calls).toBe(2);

    journal.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps official quota sources independent when one refresher is unavailable", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-sources-")));
    const journal = new DurableJournal({ rootDir: join(root, "journal"), partition: "global" });
    const registry = new QuotaRegistry(journal, [
      () => {
        throw new Error("Codex unavailable");
      },
      async () => ({
        snapshots: [
          {
            subject: {
              harness: "claude",
              credential_route: "vendor_native",
              plan_label: null,
              subject_id: null,
            },
            constraints: [
              {
                id: "five_hour",
                label: "5 hour",
                used_ratio: 0.2,
                window_seconds: 18_000,
                resets_at: null,
                cooldown_until: null,
              },
            ],
            source: "claude_statusline",
            observed_at: new Date().toISOString(),
            freshness: "fresh",
          },
        ],
      }),
    ]);

    await expect(registry.refresh()).resolves.toMatchObject({
      snapshots: [expect.objectContaining({ source: "claude_statusline" })],
    });
    expect(registry.read().snapshots[0]?.subject.harness).toBe("claude");

    journal.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("prunes snapshots older than 24h from every projection read (W17)", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-prune-")));
    const journal = new DurableJournal({ rootDir: root, partition: "global" });
    let nowIso = "2026-07-16T12:00:00.000Z";
    const registry = new QuotaRegistry(journal, [], () => new Date(nowIso));
    const snapshot = (observedAt: string, harness: string) => ({
      subject: {
        harness,
        credential_route: "vendor_native" as const,
        plan_label: null,
        subject_id: null,
      },
      constraints: [
        {
          id: "primary",
          label: "5 hour",
          used_ratio: 0.4,
          window_seconds: 18000,
          resets_at: null,
          cooldown_until: null,
        },
      ],
      source: "claude_statusline" as const,
      observed_at: observedAt,
      freshness: "fresh" as const,
    });
    // A day-old observation is pruned; a merely stale one is kept and marked.
    registry.upsert(snapshot("2026-07-15T11:00:00.000Z", "claude"));
    registry.upsert(snapshot("2026-07-16T11:00:00.000Z", "codex"));
    expect(registry.read().snapshots.map((item) => item.subject.harness)).toEqual(["codex"]);
    expect(registry.read().snapshots[0]?.freshness).toBe("stale");
    // Time passing prunes the survivor too — nothing dead lingers in the footer.
    nowIso = "2026-07-17T12:00:00.000Z";
    expect(registry.read().snapshots).toEqual([]);

    journal.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("aggregates typed absences: snapshot suppresses, claim wins over no_source, universe gap → no_source", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-absence-")));
    const journal = new DurableJournal({ rootDir: join(root, "journal"), partition: "global" });
    const now = () => new Date("2026-07-16T12:00:00.000Z");
    const subject = (harness: string, subjectId: string | null) => ({
      harness,
      credential_route: "vendor_native" as const,
      plan_label: null,
      subject_id: subjectId,
    });
    // Universe: claude default (will get a snapshot), codex default (a refresher
    // claim), and a codex "work" profile (no snapshot, no claim → no_source).
    const registry = new QuotaRegistry(
      journal,
      [
        async () => ({
          snapshots: [
            {
              subject: subject("claude", null),
              constraints: [
                {
                  id: "five_hour",
                  label: "5 hour",
                  used_ratio: 0.3,
                  window_seconds: 18_000,
                  resets_at: null,
                  cooldown_until: null,
                },
              ],
              source: "claude_oauth_usage" as const,
              observed_at: now().toISOString(),
              freshness: "fresh" as const,
            },
          ],
          // A claim for the claude subject that DOES have a snapshot must be
          // suppressed; the codex-default claim must survive.
          absences: [
            {
              subject: subject("claude", null),
              reason: "not_logged_in" as const,
              detail: "should be suppressed by the snapshot",
              observed_at: now().toISOString(),
            },
            {
              subject: subject("codex", null),
              reason: "not_logged_in" as const,
              detail: "no login",
              observed_at: now().toISOString(),
            },
          ],
        }),
      ],
      now,
      () => [subject("claude", null), subject("codex", null), subject("codex", "work")],
    );

    const value = await registry.refresh();
    expect(value.snapshots.map((s) => s.subject.harness)).toEqual(["claude"]);
    const byKey = new Map(
      value.absences.map((a) => [`${a.subject.harness}/${a.subject.subject_id ?? "default"}`, a]),
    );
    // claude/default is covered by a snapshot — no absence.
    expect(byKey.has("claude/default")).toBe(false);
    // codex/default: the refresher claim wins.
    expect(byKey.get("codex/default")?.reason).toBe("not_logged_in");
    // codex/work: in the universe with neither snapshot nor claim → no_source.
    expect(byKey.get("codex/work")?.reason).toBe("no_source");
    expect(value.absences).toHaveLength(2);

    journal.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("retires the snapshot an auth_revoked claim contradicts, for a profile and the default subject", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-revoked-")));
    const journal = new DurableJournal({ rootDir: join(root, "journal"), partition: "global" });
    let nowIso = "2026-07-16T12:00:00.000Z";
    const now = () => new Date(nowIso);
    const subject = (subjectId: string | null) => ({
      harness: "claude",
      credential_route: "vendor_native" as const,
      plan_label: null,
      subject_id: subjectId,
    });
    // Cycle 1 observes both subjects; cycle 2 is the vendor rejecting them.
    let revoked = false;
    const registry = new QuotaRegistry(
      journal,
      [
        async () =>
          revoked
            ? {
                snapshots: [],
                absences: [null, "abstractdl"].map((id) => ({
                  subject: subject(id as string | null),
                  reason: "auth_revoked" as const,
                  detail: "oauth/usage responded 401",
                  observed_at: now().toISOString(),
                })),
              }
            : {
                snapshots: [
                  quotaSnapshot("claude", null, 0.3),
                  quotaSnapshot("claude", "abstractdl", 0.3),
                ],
                absences: [],
              },
      ],
      now,
      () => [subject(null), subject("abstractdl")],
    );

    expect((await registry.refresh()).snapshots).toHaveLength(2);

    // The revocation lands while the cached snapshots are still well inside the
    // 24h retention window — the exact case in which the coverage rule used to
    // suppress it, leaving a dead credential reported as vendor-verified.
    revoked = true;
    nowIso = "2026-07-16T12:06:00.000Z";
    const after = await registry.refresh();
    expect(after.snapshots).toEqual([]);
    expect(after.absences.map((a) => a.subject.subject_id ?? "default").sort()).toEqual([
      "abstractdl",
      "default",
    ]);
    expect(after.absences.every((a) => a.reason === "auth_revoked")).toBe(true);

    // Durable: a restart replaying this journal must not resurrect the window.
    const replayed = new QuotaRegistry(journal, [], now, () => []);
    expect(replayed.read().snapshots).toEqual([]);

    journal.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("a REMOVED append failure leaves state and journal agreeing (no silent live-only retirement)", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-revoke-crash-")));
    const journal = new DurableJournal({ rootDir: join(root, "journal"), partition: "global" });
    let nowIso = "2026-07-16T12:00:00.000Z";
    const now = () => new Date(nowIso);
    const subject = (subjectId: string | null) => ({
      harness: "claude",
      credential_route: "vendor_native" as const,
      plan_label: null,
      subject_id: subjectId,
    });
    let revoked = false;
    const registry = new QuotaRegistry(
      journal,
      [
        async () =>
          revoked
            ? {
                snapshots: [],
                absences: [
                  {
                    subject: subject(null),
                    reason: "auth_revoked" as const,
                    detail: "oauth/usage responded 401",
                    observed_at: now().toISOString(),
                  },
                ],
              }
            : { snapshots: [quotaSnapshot("claude", null, 0.3)], absences: [] },
      ],
      now,
      () => [subject(null)],
    );
    expect((await registry.refresh()).snapshots).toHaveLength(1);

    // The retirement's durable authority write fails (disk error). The live
    // projection must NOT have been mutated first: journal and state still
    // agree that the snapshot exists, so a restart cannot diverge from the
    // running daemon (wave-5 f-dace28127b7a ordering inversion).
    revoked = true;
    nowIso = "2026-07-16T12:06:00.000Z";
    const realAppend = journal.append.bind(journal);
    const spy = vi.spyOn(journal, "append").mockImplementation((type, payload) => {
      if (type === "quota.subject.removed") throw new Error("append failed: no space left");
      return realAppend(type, payload);
    });
    await expect(registry.refresh()).rejects.toThrow("no space left");
    expect(registry.read().snapshots).toHaveLength(1);
    spy.mockRestore();
    const replayedMid = new QuotaRegistry(journal, [], now, () => []);
    expect(replayedMid.read().snapshots).toHaveLength(1);

    // A later healthy cycle completes the retirement durably.
    const after = await registry.refresh();
    expect(after.snapshots).toEqual([]);
    const replayed = new QuotaRegistry(journal, [], now, () => []);
    expect(replayed.read().snapshots).toEqual([]);

    journal.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps an old observation whose constraint still extends into the future (live weekly cooldown)", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-live-")));
    const journal = new DurableJournal({ rootDir: root, partition: "global" });
    let nowIso = "2026-07-16T12:00:00.000Z";
    const registry = new QuotaRegistry(journal, [], () => new Date(nowIso));
    registry.upsert({
      subject: {
        harness: "codex",
        credential_route: "vendor_native",
        plan_label: null,
        subject_id: null,
      },
      constraints: [
        {
          id: "weekly",
          label: "Weekly",
          used_ratio: 1,
          window_seconds: 604_800,
          resets_at: "2026-07-20T00:00:00.000Z",
          cooldown_until: "2026-07-20T00:00:00.000Z",
        },
      ],
      source: "codex_rollout",
      observed_at: "2026-07-14T12:00:00.000Z", // 2 days old — past the 24h horizon
      freshness: "fresh",
    });
    // The cap is still LIVE (resets in the future): kept and stale-marked —
    // hiding it would blind both the footer and the router's ledger.
    expect(registry.read().snapshots).toHaveLength(1);
    expect(registry.read().snapshots[0]?.freshness).toBe("stale");
    // Once the window itself expires, the old observation finally prunes.
    nowIso = "2026-07-21T00:00:00.000Z";
    expect(registry.read().snapshots).toEqual([]);

    journal.close();
    rmSync(root, { recursive: true, force: true });
  });
});

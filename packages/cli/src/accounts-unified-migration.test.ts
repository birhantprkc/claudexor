/**
 * Unified-accounts startup migration battery (plan §K.6): detection,
 * reserved-id policy, collisions, enabled mirroring, crash-phase resumption,
 * repeat-start no-op, lane-home renames, rollback, and the run-refusal gate.
 * The ThreadStore session/checkpoint halves are covered in
 * packages/daemon/src/threads.test.ts; here the stores are typed stubs so the
 * state machine's phase discipline is what's under test.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, updateGlobalConfig } from "@claudexor/config";
import { defaultNativeClaudeConfigDir } from "@claudexor/harness-claude";
import { defaultNativeCodexHome } from "@claudexor/harness-codex";
import { laneHomeDir } from "@claudexor/workspace";
import { noProjectRepoRoot, projectRuntimeDir } from "@claudexor/util";
import {
  accountsMigrationFilePath,
  accountsMigrationGate,
  readAccountsMigrationFile,
  rollbackAccountsUnifiedMigration,
  runAccountsUnifiedMigration,
  type AccountsMigrationStores,
} from "./accounts-unified-migration.js";
import { quotaSubjectUniverseFromConfig } from "./quota-subject-universe.js";

const dirs: string[] = [];
let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "claudexor-uam-"));
  dirs.push(configDir);
  process.env.CLAUDEXOR_CONFIG_DIR = configDir;
});

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function jwt(payload: Record<string, unknown>): string {
  return `x.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.y`;
}

function seedCodexLogin(email = "codex-owner@example.com"): string {
  const home = defaultNativeCodexHome();
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "auth.json"),
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { id_token: jwt({ email, "https://api.openai.com/auth": {} }) },
    }),
  );
  return home;
}

function seedClaudeLogin(email = "claude-owner@example.com"): string {
  const dir = defaultNativeClaudeConfigDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: email } }));
  return dir;
}

interface StubCalls {
  migrated: Array<{ harness: string; rowId: string }>;
  rolledBack: Array<{ harness: string; rowId: string }>;
  removedSubjects: Array<{ harness: string; subjectId: string | null }>;
}

function stubStores(roots: string[] = []): { stores: AccountsMigrationStores; calls: StubCalls } {
  const calls: StubCalls = { migrated: [], rolledBack: [], removedSubjects: [] };
  return {
    calls,
    stores: {
      threads: {
        migrateNullProfileContinuity: (harness, rowId) => {
          calls.migrated.push({ harness, rowId });
          return { sessions: 2, checkpoints: 1, skippedPartitions: [] };
        },
        rollbackProfileContinuity: (harness, rowId) => {
          calls.rolledBack.push({ harness, rowId });
          return { sessions: 2, checkpoints: 1, skippedPartitions: [] };
        },
        listThreads: () => roots.map((root) => ({ repo: { root } })),
      },
      quota: {
        removeSubject: (harness, subjectId) => {
          calls.removedSubjects.push({ harness, subjectId });
          return 0;
        },
      },
    },
  };
}

function registryRows() {
  return loadConfig(noProjectRepoRoot()).global.credential_profiles;
}

describe("unified-accounts startup migration (plan §K.6)", () => {
  it("case 1: no detected login fabricates no row and writes no record", () => {
    const { stores, calls } = stubStores();
    const receipts = runAccountsUnifiedMigration(stores);
    expect(receipts).toEqual([]);
    expect(registryRows()).toEqual([]);
    expect(existsSync(accountsMigrationFilePath())).toBe(false);
    expect(calls.migrated).toEqual([]);
    expect(calls.removedSubjects).toEqual([]);
  });

  it("case 2: a detected codex+claude login registers one row each with the reserved id, identity display name, and untouched bytes", () => {
    const codexHome = seedCodexLogin();
    const claudeDir = seedClaudeLogin();
    const codexBytes = readFileSync(join(codexHome, "auth.json"), "utf8");
    const { stores, calls } = stubStores();
    const receipts = runAccountsUnifiedMigration(stores);
    expect(receipts.map((r) => [r.harness_id, r.row_id, r.outcome])).toEqual([
      ["claude", "claude-default", "migrated"],
      ["codex", "codex-default", "migrated"],
    ]);
    const rows = registryRows();
    expect(rows).toHaveLength(2);
    const codexRow = rows.find((r) => r.harness_id === "codex");
    expect(codexRow).toMatchObject({
      profile_id: "codex-default",
      credential_kind: "config_dir_login",
      isolation_locator: codexHome,
      display_name: "codex-owner@example.com",
      enabled: true,
    });
    const claudeRow = rows.find((r) => r.harness_id === "claude");
    expect(claudeRow).toMatchObject({
      profile_id: "claude-default",
      isolation_locator: claudeDir,
      display_name: "claude-owner@example.com",
    });
    // Bytes never move (Claude keys its Keychain item by the exact dir path).
    expect(readFileSync(join(codexHome, "auth.json"), "utf8")).toBe(codexBytes);
    // Continuity migrated as one unit; the legacy null subject retired.
    expect(calls.migrated).toEqual([
      { harness: "claude", rowId: "claude-default" },
      { harness: "codex", rowId: "codex-default" },
    ]);
    expect(calls.removedSubjects).toEqual([
      { harness: "claude", subjectId: null },
      { harness: "codex", subjectId: null },
    ]);
    expect(readAccountsMigrationFile()["codex"]).toMatchObject({
      phase: "completed",
      row_id: "codex-default",
      legacy_aliases: [null],
      locator: codexHome,
    });
  });

  it("case 3: a reserved-id collision with a DIFFERENT locator takes the deterministic -2 suffix", () => {
    seedCodexLogin();
    const foreign = join(configDir, "profiles", "codex-other");
    mkdirSync(foreign, { recursive: true });
    updateGlobalConfig((config) => ({
      ...config,
      credential_profiles: [
        {
          profile_id: "codex-default",
          harness_id: "codex",
          display_name: "hand-made",
          credential_kind: "config_dir_login",
          isolation_locator: foreign,
          secret_ref: null,
          enabled: true,
          created_at: null,
        },
      ],
    }));
    const { stores } = stubStores();
    const receipts = runAccountsUnifiedMigration(stores);
    expect(receipts.map((r) => r.row_id)).toEqual(["codex-default-2"]);
    expect(registryRows().map((r) => r.profile_id).sort()).toEqual([
      "codex-default",
      "codex-default-2",
    ]);
  });

  it("case 4: native_credentials_enabled=false maps to enabled=false and the mirror key survives", () => {
    seedCodexLogin();
    updateGlobalConfig((config) => ({
      ...config,
      harnesses: {
        ...config.harnesses,
        codex: { ...config.harnesses["codex"], native_credentials_enabled: false },
      },
    }));
    runAccountsUnifiedMigration(stubStores().stores);
    const row = registryRows().find((r) => r.harness_id === "codex");
    expect(row?.enabled).toBe(false);
    // The deprecated key remains as the downgrade-window mirror.
    const cfg = loadConfig(noProjectRepoRoot()).global;
    expect(cfg.harnesses["codex"]?.native_credentials_enabled).toBe(false);
  });

  it("case 5: a crash after any persisted phase resumes idempotently (no duplicate rows, no lost steps)", () => {
    const home = seedCodexLogin();
    const { stores, calls } = stubStores();
    // Simulate a crash after RESERVED was persisted but nothing else ran.
    mkdirSync(join(accountsMigrationFilePath(), ".."), { recursive: true });
    writeFileSync(
      accountsMigrationFilePath(),
      JSON.stringify({
        codex: {
          phase: "reserved",
          row_id: "codex-default",
          legacy_aliases: [null],
          locator: home,
          backup_ref: null,
        },
      }),
    );
    expect(accountsMigrationGate("codex")).not.toBeNull();
    expect(accountsMigrationGate("claude")).toBeNull();
    const receipts = runAccountsUnifiedMigration(stores);
    expect(receipts.map((r) => [r.harness_id, r.outcome])).toEqual([["codex", "resumed"]]);
    expect(registryRows().filter((r) => r.harness_id === "codex")).toHaveLength(1);
    expect(calls.migrated).toEqual([{ harness: "codex", rowId: "codex-default" }]);
    expect(readAccountsMigrationFile()["codex"]?.phase).toBe("completed");
    expect(accountsMigrationGate("codex")).toBeNull();

    // Crash after registry_written: resuming must not duplicate the row and
    // must still run continuity + quota retirement.
    const calls2 = stubStores();
    writeFileSync(
      accountsMigrationFilePath(),
      JSON.stringify({
        codex: {
          phase: "registry_written",
          row_id: "codex-default",
          legacy_aliases: [null],
          locator: home,
          backup_ref: null,
        },
      }),
    );
    runAccountsUnifiedMigration(calls2.stores);
    expect(registryRows().filter((r) => r.harness_id === "codex")).toHaveLength(1);
    expect(calls2.calls.migrated).toEqual([{ harness: "codex", rowId: "codex-default" }]);
    expect(calls2.calls.removedSubjects).toEqual([{ harness: "codex", subjectId: null }]);
  });

  it("case 6: the second start is byte-identical (no further config mutation, no receipts)", () => {
    seedCodexLogin();
    runAccountsUnifiedMigration(stubStores().stores);
    const configBytes = readFileSync(join(configDir, "config.yaml"), "utf8");
    const migrationBytes = readFileSync(accountsMigrationFilePath(), "utf8");
    const { stores, calls } = stubStores();
    const receipts = runAccountsUnifiedMigration(stores);
    expect(receipts).toEqual([]);
    expect(readFileSync(join(configDir, "config.yaml"), "utf8")).toBe(configBytes);
    expect(readFileSync(accountsMigrationFilePath(), "utf8")).toBe(migrationBytes);
    expect(calls.migrated).toEqual([]);
    expect(calls.removedSubjects).toEqual([]);
  });

  it("reuses a row already registered at the same locator (D-U2 no-op reuse)", () => {
    const home = seedCodexLogin();
    updateGlobalConfig((config) => ({
      ...config,
      credential_profiles: [
        {
          profile_id: "my-codex",
          harness_id: "codex",
          display_name: "mine",
          credential_kind: "config_dir_login",
          isolation_locator: home,
          secret_ref: null,
          enabled: true,
          created_at: null,
        },
      ],
    }));
    const receipts = runAccountsUnifiedMigration(stubStores().stores);
    expect(receipts.map((r) => r.row_id)).toEqual(["my-codex"]);
    expect(registryRows()).toHaveLength(1);
    expect(readAccountsMigrationFile()["codex"]?.row_id).toBe("my-codex");
  });

  it("case 7 (lane half): durable lane homes rename to the row lane and back on rollback", () => {
    seedCodexLogin();
    const projectRoot = mkdtempSync(join(tmpdir(), "claudexor-uam-project-"));
    dirs.push(projectRoot);
    const runtime = projectRuntimeDir(projectRoot);
    const legacyLane = laneHomeDir(runtime, "th_1", "codex", null);
    mkdirSync(legacyLane, { recursive: true });
    writeFileSync(join(legacyLane, "session.txt"), "recorded native session");
    const { stores } = stubStores([projectRoot]);
    const receipts = runAccountsUnifiedMigration(stores);
    expect(receipts[0]?.lanes).toBe(1);
    const rowLane = laneHomeDir(runtime, "th_1", "codex", "codex-default");
    expect(readFileSync(join(rowLane, "session.txt"), "utf8")).toBe("recorded native session");
    expect(existsSync(legacyLane)).toBe(false);

    const rollback = rollbackAccountsUnifiedMigration(stores);
    expect(rollback[0]?.lanes).toBe(1);
    expect(readFileSync(join(legacyLane, "session.txt"), "utf8")).toBe("recorded native session");
    expect(existsSync(rowLane)).toBe(false);
  });

  it("case 10 (rollback): the row leaves the registry, its enabled state returns to the mirror, and the record clears", () => {
    seedCodexLogin();
    const { stores, calls } = stubStores();
    runAccountsUnifiedMigration(stores);
    // Disable the migrated row the unified way first, so rollback must carry
    // that state back onto the deprecated key.
    updateGlobalConfig((config) => ({
      ...config,
      credential_profiles: config.credential_profiles.map((p) =>
        p.profile_id === "codex-default" ? { ...p, enabled: false } : p,
      ),
    }));
    const receipts = rollbackAccountsUnifiedMigration(stores);
    expect(receipts.map((r) => [r.harness_id, r.row_id])).toEqual([["codex", "codex-default"]]);
    expect(registryRows()).toEqual([]);
    const cfg = loadConfig(noProjectRepoRoot()).global;
    expect(cfg.harnesses["codex"]?.native_credentials_enabled).toBe(false);
    expect(readAccountsMigrationFile()).toEqual({});
    expect(calls.rolledBack).toEqual([{ harness: "codex", rowId: "codex-default" }]);
    expect(calls.removedSubjects.at(-1)).toEqual({ harness: "codex", subjectId: "codex-default" });
    // A later new-engine start re-migrates cleanly.
    const again = runAccountsUnifiedMigration(stubStores().stores);
    expect(again.map((r) => r.row_id)).toEqual(["codex-default"]);
  });

  it("retires the null quota subject from the refresh universe for migrated harnesses only", () => {
    seedCodexLogin();
    seedClaudeLogin();
    const before = quotaSubjectUniverseFromConfig();
    expect(before.some((s) => s.harness === "codex" && s.subject_id === null)).toBe(true);
    runAccountsUnifiedMigration(stubStores().stores);
    const after = quotaSubjectUniverseFromConfig();
    // No null subject for migrated harnesses — the row subject covers the
    // same store (a null duplicate would double-probe one credential).
    expect(after.some((s) => s.subject_id === null && s.harness !== "cursor")).toBe(false);
    expect(after.some((s) => s.harness === "codex" && s.subject_id === "codex-default")).toBe(true);
    expect(after.some((s) => s.harness === "claude" && s.subject_id === "claude-default")).toBe(
      true,
    );
  });

  it("writes a pre-migration config backup and records its ref", () => {
    seedCodexLogin();
    updateGlobalConfig((config) => config); // materialize config.yaml
    runAccountsUnifiedMigration(stubStores().stores);
    const record = readAccountsMigrationFile()["codex"];
    expect(record?.backup_ref).toBeTruthy();
    expect(existsSync(join(record!.backup_ref!, "config.yaml"))).toBe(true);
  });
});

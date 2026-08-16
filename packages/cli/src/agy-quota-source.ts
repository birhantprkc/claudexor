import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { loadConfig } from "@claudexor/config";
import { providerScrubEnv } from "@claudexor/core";
import type { QuotaRefreshResult } from "@claudexor/daemon";
import {
  AGY_BIN,
  AGY_GEMINI_MODELS,
  AGY_THIRD_PARTY_MODELS,
  agyProfileRunEnv,
  agyTokenPath,
  canonicalAgyProfileHome,
} from "@claudexor/harness-agy";
import { QuotaConstraint as QuotaConstraintSchema } from "@claudexor/schema";
import type { QuotaAbsence, QuotaConstraint, QuotaSnapshot } from "@claudexor/schema";
import { noProjectRepoRoot, redactSecrets } from "@claudexor/util";

/**
 * agy quota (source `agy_command_usage`): the vendor's own `/quota` print-mode
 * slash command returns a JSON envelope WITHOUT spending a turn (1.1.11+). One
 * candidate per enabled agy config_dir_login profile — agy has NO default
 * store (owner decision, PLAN Л-4), so there is no null-subject candidate.
 * A candidate that cannot be observed yields a typed absence CLAIM, never a
 * throw: one account's failure must never blind the others.
 */
export async function refreshAgyQuota(
  options: { bin?: string; baseEnv?: NodeJS.ProcessEnv } = {},
): Promise<QuotaRefreshResult> {
  const bin = options.bin ?? AGY_BIN();
  const snapshots: QuotaSnapshot[] = [];
  const universe = agyQuotaCandidates();
  const absences: QuotaAbsence[] = [...universe.absences];
  for (const candidate of universe.candidates) {
    const home = candidate.home;
    // Logged-out precheck (codex pattern): a profile HOME without the vendor's
    // file token cannot yield a window — typed absence WITHOUT spawning agy
    // (which would otherwise block ~60s on an interactive login prompt).
    if (!existsSync(agyTokenPath(home))) {
      absences.push(
        agyAbsence(candidate.subjectId, "not_logged_in", `no Antigravity token in ${home}`),
      );
      continue;
    }
    try {
      const env = agyProfileRunEnv(home, options.baseEnv ?? process.env);
      const parsed = await readAgyQuota(bin, env);
      if (parsed.kind === "auth_revoked") {
        absences.push(agyAbsence(candidate.subjectId, "auth_revoked", parsed.detail));
      } else if (parsed.kind === "constraints") {
        snapshots.push({
          subject: {
            harness: "agy",
            credential_route: "vendor_native",
            plan_label: parsed.planLabel,
            subject_id: candidate.subjectId,
          },
          constraints: parsed.constraints,
          source: "agy_command_usage",
          observed_at: new Date().toISOString(),
          freshness: "fresh",
        });
      } else {
        absences.push(agyAbsence(candidate.subjectId, "refresh_failed", parsed.detail));
      }
    } catch (err) {
      absences.push(
        agyAbsence(
          candidate.subjectId,
          "refresh_failed",
          redactSecrets(err instanceof Error ? err.message : String(err)).slice(0, 300),
        ),
      );
    }
  }
  return { snapshots, absences };
}

interface AgyQuotaCandidate {
  home: string;
  subjectId: string;
}

function agyQuotaCandidates(): { candidates: AgyQuotaCandidate[]; absences: QuotaAbsence[] } {
  const global = loadConfig(noProjectRepoRoot()).global;
  if (global.harnesses.agy?.enabled === false) return { candidates: [], absences: [] };
  const candidates: AgyQuotaCandidate[] = [];
  const absences: QuotaAbsence[] = [];
  for (const profile of global.credential_profiles) {
    if (profile.harness_id !== "agy" || !profile.enabled) continue;
    if (profile.credential_kind !== "config_dir_login") continue;
    // A profile the subject universe still lists must yield a CLAIM either
    // way: silently skipping a malformed or locator-less row would degrade it
    // to `no_source` with no reason anyone can read (review Ф2 #9).
    try {
      if (!profile.isolation_locator) throw new Error("profile has no isolation locator");
      candidates.push({
        home: canonicalAgyProfileHome(profile.isolation_locator),
        subjectId: profile.profile_id,
      });
    } catch (err) {
      absences.push(
        agyAbsence(
          profile.profile_id,
          "refresh_failed",
          redactSecrets(err instanceof Error ? err.message : String(err)).slice(0, 300),
        ),
      );
    }
  }
  return { candidates, absences };
}

function agyAbsence(
  subjectId: string,
  reason: QuotaAbsence["reason"],
  detail: string,
): QuotaAbsence {
  return {
    subject: {
      harness: "agy",
      credential_route: "vendor_native",
      plan_label: null,
      subject_id: subjectId,
    },
    reason,
    detail,
    observed_at: new Date().toISOString(),
  };
}

type AgyQuotaParse =
  | { kind: "constraints"; constraints: QuotaConstraint[]; planLabel: string | null }
  | { kind: "auth_revoked"; detail: string }
  | { kind: "failed"; detail: string };

/** Spawn `agy -p "/quota" --output-format json`, hard-kill on timeout, parse
 * the envelope tolerantly. stdin is closed (agy runs fine that way when
 * authenticated — PLAN §1.2b); the token precheck already guaranteed a login. */
async function readAgyQuota(
  bin: string,
  env: Record<string, string | null | undefined>,
): Promise<AgyQuotaParse> {
  const merged: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries({ ...env, ...providerScrubEnv() })) {
    if (typeof v === "string") merged[k] = v;
  }
  merged.AGY_CLI_DISABLE_AUTO_UPDATE = "true";
  const child = spawn(bin, ["-p", "/quota", "--output-format", "json"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: merged,
  });
  const kill = setTimeout(() => child.kill("SIGKILL"), 30_000);
  let stdout = "";
  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    // Bounded: a wedged or hostile vendor cannot grow the daemon's heap.
    if (stdout.length < MAX_QUOTA_STDOUT) stdout += line + "\n";
  });
  // `exit`, never `close`: `close` waits for every stdio pipe to end, so a
  // surviving agy DESCENDANT holding stdout would keep this promise pending
  // forever even after the SIGKILL — and a pending promise wedges
  // QuotaPollPacer.inFlight, which stalls the daemon's whole quota refresh
  // cycle (claude and codex included). codex-quota-source and
  // claude-statusline both use `exit` for exactly this reason (review Ф2 #2).
  const [code] = await new Promise<[number | null]>((resolve) => {
    child.once("exit", (c) => resolve([c]));
    child.once("error", () => resolve([null]));
  });
  clearTimeout(kill);
  rl.close();
  child.stdout.destroy();
  child.stderr.destroy();
  if (code === null) return { kind: "failed", detail: "agy quota process could not be spawned" };
  return parseAgyQuotaEnvelope(stdout);
}

/**
 * Tolerant parser for the `/quota` envelope (fixtures/agy-quota-print*.json).
 * DIFFERENT account tiers return DIFFERENT window sets (a lower tier has no
 * 5-hour windows — PLAN §1.2a), so a missing window is normal, never an error.
 * Each of the two vendor GROUPS ("Gemini Models", "Claude and GPT models")
 * becomes constraints tagged with its group's model slugs, so a spent Claude
 * window can never block Gemini routing (INV-136 model scope; roast E2/grok).
 */
export function parseAgyQuotaEnvelope(raw: string): AgyQuotaParse {
  let parsed: any;
  try {
    parsed = JSON.parse(raw.trim() || "{}");
  } catch {
    return { kind: "failed", detail: "agy quota output was not valid JSON" };
  }
  if (parsed?.status === "ERROR" || (typeof parsed?.error === "string" && parsed.error)) {
    const detail = String(parsed.error ?? "authentication required");
    return /auth|login|credential|token/i.test(detail)
      ? { kind: "auth_revoked", detail: redactSecrets(detail).slice(0, 300) }
      : { kind: "failed", detail: redactSecrets(detail).slice(0, 300) };
  }
  const groups = parsed?.command?.data?.groups;
  if (!Array.isArray(groups)) return { kind: "failed", detail: "agy quota envelope had no groups" };
  const constraints: QuotaConstraint[] = [];
  for (const group of groups) {
    const models = modelsForGroup(String(group?.name ?? ""));
    for (const bucket of Array.isArray(group?.buckets) ? group.buckets : []) {
      const remaining =
        typeof bucket?.remaining_fraction === "number" ? bucket.remaining_fraction : null;
      const usedRatio = remaining === null ? null : Math.min(1, Math.max(0, 1 - remaining));
      const window = String(bucket?.window ?? "");
      const groupName = String(group?.name ?? "agy");
      const candidate = {
        // `??` alone is not enough: the vendor's blank string is not nullish,
        // and a blank id/label fails the schema's min(1) (review Ф2 #3).
        id: nonBlank(bucket?.id) ?? `${groupName}-${window || "window"}`,
        label: nonBlank(bucket?.name) ?? nonBlank(window) ?? "Requests",
        applies_to_models: models,
        // A run that names no model goes to the vendor's selected model, which
        // is always a Gemini slug (the Claude/GPT slugs are opt-in), so the
        // Gemini windows govern it. Without this the account's every window is
        // scoped and a bare run could never be refused — Л-2 rotation would
        // never fire in a default configuration (review Ф2 #5).
        applies_to_unspecified_model: models === geminiModels,
        used_ratio: usedRatio,
        // Own-property lookup only: a `window` of `__proto__`/`toString`
        // otherwise resolves to an inherited value, not a number.
        window_seconds: Object.hasOwn(WINDOW_SECONDS, window) ? WINDOW_SECONDS[window]! : null,
        resets_at: isoOrNull(bucket?.reset_time),
        cooldown_until: null,
      };
      // One unparseable window must never cost the account its whole batch:
      // the daemon drops the ENTIRE agy result — snapshots and absences — when
      // a single constraint fails schema validation downstream.
      const checked = QuotaConstraintSchema.safeParse(candidate);
      if (checked.success) constraints.push(checked.data);
    }
  }
  if (constraints.length === 0)
    return { kind: "failed", detail: "agy quota envelope carried no windows" };
  return { kind: "constraints", constraints, planLabel: null };
}

/** A vendor string that is neither missing nor blank. */
function nonBlank(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

/** The vendor's reset stamp only when it really is a date; a garbage string
 * would otherwise fail the schema's datetime check and drop the batch. */
function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

const MAX_QUOTA_STDOUT = 256 * 1024;

const WINDOW_SECONDS: Record<string, number> = {
  "5h": 5 * 60 * 60,
  weekly: 7 * 24 * 60 * 60,
};

/**
 * The vendor groups map to disjoint model families. Gemini models carry the
 * Gemini window; Claude/GPT-OSS the other. Any slug not matched stays
 * vendor-wide (null) so a future group cannot silently escape scoping.
 */
const geminiModels: string[] = [...AGY_GEMINI_MODELS];
const thirdPartyModels: string[] = [...AGY_THIRD_PARTY_MODELS];

function modelsForGroup(groupName: string): string[] | null {
  const n = groupName.toLowerCase();
  if (n.includes("gemini")) return geminiModels;
  if (n.includes("claude") || n.includes("gpt")) return thirdPartyModels;
  return null;
}

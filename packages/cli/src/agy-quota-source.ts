import { spawn } from "node:child_process";
import { loadConfig } from "@claudexor/config";
import { providerScrubEnv } from "@claudexor/core";
import type { QuotaRefreshResult } from "@claudexor/daemon";
import {
  AGY_BIN,
  AGY_GEMINI_MODELS,
  AGY_THIRD_PARTY_MODELS,
  agyProfileRunEnv,
  agyTokenFilePresent,
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
  // Profiles are read CONCURRENTLY: several accounts is the point of the
  // feature, the daemon awaits every refresher in one cycle, and each read can
  // burn its full timeout — serially that is one stalled vendor per account
  // added to claude's and codex's wait too.
  const results = await Promise.all(
    universe.candidates.map(async (candidate) => {
      const home = candidate.home;
      // Logged-out precheck (codex pattern): a profile HOME without the
      // vendor's file token cannot yield a window — typed absence WITHOUT
      // spawning agy, which would otherwise open the user's browser and block
      // on an interactive login prompt.
      if (!agyTokenFilePresent(home)) {
        return {
          absence: agyAbsence(
            candidate.subjectId,
            "not_logged_in",
            `no Antigravity token in ${home}`,
          ),
        };
      }
      try {
        const env = agyProfileRunEnv(home, options.baseEnv ?? process.env);
        const parsed = await readAgyQuota(bin, env);
        if (parsed.kind === "auth_revoked")
          return { absence: agyAbsence(candidate.subjectId, "auth_revoked", parsed.detail) };
        if (parsed.kind !== "constraints")
          return { absence: agyAbsence(candidate.subjectId, "refresh_failed", parsed.detail) };
        // Which window governs a run that names no model depends on the model
        // this profile is actually set to, which the vendor answers for free.
        const selected = await readAgySelectedModel(bin, env);
        return {
          snapshot: {
            subject: {
              harness: "agy" as const,
              credential_route: "vendor_native" as const,
              plan_label: parsed.planLabel,
              subject_id: candidate.subjectId,
            },
            constraints: scopeUnspecifiedModel(parsed.constraints, selected),
            source: "agy_command_usage" as const,
            observed_at: new Date().toISOString(),
            freshness: "fresh" as const,
          },
        };
      } catch (err) {
        return {
          absence: agyAbsence(
            candidate.subjectId,
            "refresh_failed",
            redactSecrets(err instanceof Error ? err.message : String(err)).slice(0, 300),
          ),
        };
      }
    }),
  );
  for (const result of results) {
    if (result.snapshot) snapshots.push(result.snapshot);
    if (result.absence) absences.push(result.absence);
  }
  return { snapshots, absences };
}

/**
 * The model this profile currently routes an unspecified-model run to. The
 * vendor answers `/model` from the CLI without spending a turn; a failure
 * leaves it null and the caller falls back to the Gemini group, which is what
 * a fresh profile selects.
 */
async function readAgySelectedModel(
  bin: string,
  env: Record<string, string | null | undefined>,
): Promise<string | null> {
  const result = await readAgyCommand(bin, "/model", env);
  if ("failure" in result) return null;
  try {
    const parsed = JSON.parse(result.stdout.trim() || "{}");
    const id = parsed?.command?.data?.id;
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

/**
 * Stamp the ONE group that governs a run naming no model. Every agy window is
 * model-scoped, and a scoped window deliberately cannot refuse a route whose
 * model is unknowable before spawn — so without this stamp an exhausted
 * account could never refuse a bare run or trigger rotation (Л-2). The stamp
 * follows the profile's SELECTED model rather than an assumption, because a
 * user who picks a Claude slug would otherwise rotate on Gemini exhaustion and
 * never be refused on their own.
 */
function scopeUnspecifiedModel(
  constraints: QuotaConstraint[],
  selectedModel: string | null,
): QuotaConstraint[] {
  const scoped = constraints.filter((c) => c.applies_to_models && c.applies_to_models.length > 0);
  // A model the pinned inventory does not know — the vendor ships new slugs
  // between releases and the user picks them in its own TUI — must not leave
  // EVERY window ungoverned: that reads as a healthy account no matter how
  // spent it is, and rotation never fires. The Gemini group is the documented
  // fallback, the same one an unreadable `/model` gets.
  const known =
    selectedModel !== null && scoped.some((c) => c.applies_to_models!.includes(selectedModel));
  const governs = known
    ? (c: QuotaConstraint) => c.applies_to_models!.includes(selectedModel!)
    : selectedModel === null || selectedModel.startsWith("gemini-")
      ? // Unreadable, or a Gemini slug newer than the pinned inventory: the
        // vendor's own group governs, as it does for a fresh profile.
        (c: QuotaConstraint) => c.applies_to_models!.some((m) => m.startsWith("gemini-"))
      : // A slug we cannot place at all: EVERY window governs, so an exhausted
        // account is refused rather than reading as healthy. Over-refusing a
        // bare run costs a rotation; under-refusing costs the whole feature.
        () => true;
  return constraints.map((constraint) =>
    constraint.applies_to_models && constraint.applies_to_models.length > 0
      ? { ...constraint, applies_to_unspecified_model: governs(constraint) }
      : constraint,
  );
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

/**
 * Spawn one print-mode slash command and return its raw stdout, or a typed
 * failure. stdin is closed (an authenticated agy runs fine that way — PLAN
 * §1.2b) and the caller's token precheck already proved a login exists, so
 * this can never reach an interactive prompt.
 *
 * stderr is NOT piped: nothing reads it, and an unread pipe fills at 64 KB and
 * blocks the vendor mid-write — which threw away a perfectly good stdout
 * envelope and burned the whole timeout.
 */
async function readAgyCommand(
  bin: string,
  command: string,
  env: Record<string, string | null | undefined>,
): Promise<{ stdout: string } | { failure: string }> {
  const merged: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries({ ...env, ...providerScrubEnv() })) {
    if (typeof v === "string") merged[k] = v;
  }
  merged.AGY_CLI_DISABLE_AUTO_UPDATE = "true";
  const child = spawn(bin, ["-p", command, "--output-format", "json"], {
    stdio: ["ignore", "pipe", "ignore"],
    env: merged,
  });
  let timedOut = false;
  const kill = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, AGY_COMMAND_TIMEOUT_MS);
  // Bounded by BYTES on the raw stream: a line-keyed cap cannot bound a stream
  // with no newline in it, and readline's own buffer would grow first.
  let stdout = "";
  let overflowed = false;
  child.stdout.on("data", (chunk: Buffer) => {
    if (overflowed) return;
    if (stdout.length + chunk.length > MAX_QUOTA_STDOUT) {
      overflowed = true;
      child.kill("SIGKILL");
      return;
    }
    stdout += chunk.toString("utf8");
  });
  // `exit`, never `close`: `close` waits for every stdio pipe to end, so a
  // surviving agy DESCENDANT holding stdout would keep this promise pending
  // forever even after the SIGKILL — and a pending promise wedges
  // QuotaPollPacer.inFlight, which stalls the daemon's whole quota refresh
  // cycle (claude and codex included). codex-quota-source and
  // claude-statusline both use `exit` for exactly this reason.
  const outcome = await new Promise<{ code: number | null } | { spawnFailed: true }>((resolve) => {
    child.once("exit", (code) => resolve({ code }));
    child.once("error", () => resolve({ spawnFailed: true }));
  });
  clearTimeout(kill);
  child.stdout.destroy();
  // The three not-a-result outcomes stay DISTINGUISHABLE: an operator reading
  // "could not be spawned" must not be looking at a vendor that simply hung.
  if ("spawnFailed" in outcome)
    return { failure: `agy could not be spawned (is ${bin} installed?)` };
  if (overflowed) return { failure: "agy printed more output than the quota reader accepts" };
  if (timedOut)
    return {
      failure: `agy did not answer ${command} within ${AGY_COMMAND_TIMEOUT_MS / 1000}s and was stopped`,
    };
  return { stdout };
}

const AGY_COMMAND_TIMEOUT_MS = 30_000;

/** Spawn the vendor's own `/quota` slash command and parse it tolerantly. */
async function readAgyQuota(
  bin: string,
  env: Record<string, string | null | undefined>,
): Promise<AgyQuotaParse> {
  const result = await readAgyCommand(bin, "/quota", env);
  if ("failure" in result) return { kind: "failed", detail: result.failure };
  return parseAgyQuotaEnvelope(result.stdout);
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
        // Which window governs a run that NAMES NO MODEL is stamped by
        // scopeUnspecifiedModel from the profile's actually selected model —
        // one owner, so the parser never guesses it.
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

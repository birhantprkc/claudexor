/**
 * Per-model effort discovery for codex.
 *
 * Codex advertises reasoning-effort vocabularies PER MODEL and exposes them
 * machine-readably: `codex app-server --stdio` speaks JSON-RPC, and the v2
 * `model/list` request answers with `data[].supportedReasoningEfforts` +
 * `defaultReasoningEffort`. The ceiling is genuinely model-scoped — gpt-5.6-sol
 * takes `ultra` while gpt-5.4 stops at `xhigh` — so a harness-wide ladder is
 * always wrong for some model.
 *
 * The vendor's own generated schema types `ReasoningEffort` as "a non-empty
 * reasoning effort value advertised by the model" (a bounded string, NOT an
 * enum). We mirror that: whatever the probe reports is what we advertise, so a
 * level newer than this repo starts working the moment codex ships it.
 *
 * A probe is never load-bearing. Missing binary, an older app-server without
 * `model/list`, a timeout or malformed output all fall back to the recorded
 * snapshot below and the run proceeds.
 */
import { spawn } from "node:child_process";
import type { ModelEffortCapability } from "@claudexor/schema";
import { EFFORT_RANK_ORDER, EffortHint, effortLevelsForModel } from "@claudexor/schema";
import { normalizeEffort } from "@claudexor/core";
import { BIN, probeEnv } from "./missing-cli.js";

export type CodexEffortCapability = Record<string, ModelEffortCapability>;

/**
 * Recorded fallback, captured from a live `model/list` on the CLI version
 * stamped below. Used ONLY when the live probe cannot answer; it is a snapshot
 * of vendor state, never an allow-list this repo maintains by hand.
 */
export const CODEX_EFFORT_SNAPSHOT: CodexEffortCapability = {
  "gpt-5.6-sol": {
    levels: ["low", "medium", "high", "xhigh", "max", "ultra"],
    default: "low",
  },
  "gpt-5.6-terra": {
    levels: ["low", "medium", "high", "xhigh", "max", "ultra"],
    default: "medium",
  },
  "gpt-5.6-luna": { levels: ["low", "medium", "high", "xhigh", "max"], default: "medium" },
  "gpt-5.5": { levels: ["low", "medium", "high", "xhigh"], default: "medium" },
  "gpt-5.4": { levels: ["low", "medium", "high", "xhigh"], default: "medium" },
  "gpt-5.4-mini": { levels: ["low", "medium", "high", "xhigh"], default: "medium" },
  "gpt-5.3-codex-spark": { levels: ["low", "medium", "high", "xhigh"], default: "high" },
};

/** Vendor CLI version `CODEX_EFFORT_SNAPSHOT` was captured from. */
export const CODEX_EFFORT_SNAPSHOT_VERIFIED_AGAINST = "0.144.1";

/**
 * Harness-wide UNION of an advertised set, RANKED weakest→strongest. Kept as the
 * coarse `effort_levels` fallback so every existing reader (settings validation,
 * the composer's picker, INV-105 disclosure) keeps working while per-model
 * narrowing happens through `effortLevelsForModel`.
 *
 * The union is sorted through `EFFORT_RANK_ORDER` rather than emitted in
 * first-seen probe order, because `capabilities.effort_levels` PROMISES weakest
 * to strongest and probe order is really "whatever order the vendor listed its
 * models in". Unranked vendor levels cannot be placed, so they follow the ranked
 * ones sorted lexicographically — the same tail rule the Swift `EffortRanking`
 * contract applies, so both sides of the wire order a union identically.
 */
export function unionEffortLevels(capability: CodexEffortCapability): EffortHint[] {
  const seen = new Set<EffortHint>();
  for (const entry of Object.values(capability)) for (const level of entry.levels) seen.add(level);
  const ranked = (EFFORT_RANK_ORDER as readonly EffortHint[]).filter((level) => seen.has(level));
  const unranked = [...seen].filter((level) => !ranked.includes(level)).sort();
  return [...ranked, ...unranked];
}

interface ModelListEntry {
  id?: unknown;
  defaultReasoningEffort?: unknown;
  supportedReasoningEfforts?: unknown;
}

/**
 * A vendor VALUE that is not an effort level at all. Distinct from `null` (an
 * entry that simply advertises no effort surface, which is normal and skipped):
 * this poisons the whole probe. See `readModelListEfforts`.
 */
const MALFORMED = Symbol("malformed-effort-entry");

/**
 * Shape-check one `model/list` entry; never throws.
 *
 * ABSENCE is skipped (`null`): no id, no `supportedReasoningEfforts` array, an
 * array member without the field, an empty list — a model with no effort surface
 * is ordinary vendor output. A PRESENT value that is not an `EffortHint` is
 * MALFORMED, because `EffortHint` is the wire contract every consumer downstream
 * enforces, right up to `HarnessManifest.parse`.
 */
function readEntry(raw: ModelListEntry): [string, ModelEffortCapability] | null | typeof MALFORMED {
  if (typeof raw.id !== "string" || raw.id.trim() === "") return null;
  if (!Array.isArray(raw.supportedReasoningEfforts)) return null;
  const levels: EffortHint[] = [];
  for (const item of raw.supportedReasoningEfforts) {
    const level = (item as { reasoningEffort?: unknown })?.reasoningEffort;
    if (level === undefined) continue;
    const parsed = EffortHint.safeParse(level);
    if (!parsed.success) return MALFORMED;
    if (!levels.includes(parsed.data)) levels.push(parsed.data);
  }
  if (levels.length === 0) return null;
  // An absent default is normal (the vendor omits it, or sends an empty string);
  // a present one must be a real level, since it is published as the manifest's
  // per-model `default` and read back through the same schema.
  const fallback = raw.defaultReasoningEffort;
  if (fallback === undefined || fallback === null || fallback === "") {
    return [raw.id, { levels, default: null }];
  }
  const parsedDefault = EffortHint.safeParse(fallback);
  if (!parsedDefault.success) return MALFORMED;
  return [raw.id, { levels, default: parsedDefault.data }];
}

/**
 * The whole `model/list` payload as a capability map, or null for a FAILED probe.
 *
 * STRICT on purpose (the reviewed decision): ONE malformed value discards the
 * ENTIRE live catalog and the caller degrades to the recorded snapshot, which is
 * exactly what this module promises. Skipping the bad entry instead would publish
 * a silently NARROWED ladder — a model advertising `["low", "HIGH!"]` would go out
 * as `["low"]`, stamped with the installed CLI version, so a `high` request would
 * clamp down to `low` and the freshness gate would call the ladder fresh. And a
 * malformed value that reached the manifest would fail `HarnessManifest.parse`,
 * breaking discovery rather than degrading it. The snapshot is a real, usable
 * ladder, so strictness costs freshness and never capability.
 */
export function readModelListEfforts(data: unknown): CodexEffortCapability | null {
  if (!Array.isArray(data)) return null;
  const capability: CodexEffortCapability = {};
  for (const raw of data) {
    const entry = readEntry(raw as ModelListEntry);
    if (entry === MALFORMED) return null;
    if (entry) capability[entry[0]] = entry[1];
  }
  return Object.keys(capability).length > 0 ? capability : null;
}

/**
 * Ask a live `codex app-server` what each model advertises. Resolves to null on
 * ANY failure — the caller falls back to the snapshot.
 */
export async function probeCodexEfforts(
  bin: string,
  opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<CodexEffortCapability | null> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  return await new Promise<CodexEffortCapability | null>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, ["app-server", "--stdio"], {
        stdio: ["pipe", "pipe", "ignore"],
        ...(opts.env ? { env: opts.env } : {}),
      });
    } catch {
      resolve(null);
      return;
    }

    let settled = false;
    const finish = (value: CodexEffortCapability | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill("SIGKILL");
      } catch {
        /* the child is already gone; nothing to clean up */
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);

    child.on("error", () => finish(null));
    // A clean exit before `model/list` answered means the method is unsupported.
    child.on("exit", () => finish(null));

    const send = (payload: unknown): void => {
      try {
        child.stdin?.write(`${JSON.stringify(payload)}\n`);
      } catch {
        finish(null);
      }
    };

    let buffer = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line === "") continue;
        let message: { id?: unknown; result?: { data?: unknown } };
        try {
          message = JSON.parse(line) as typeof message;
        } catch {
          continue;
        }
        if (message.id === 1) {
          // Handshake accepted: the notification, then the v2 model query.
          send({ method: "initialized", params: null });
          send({ jsonrpc: "2.0", id: 2, method: "model/list", params: {} });
          continue;
        }
        if (message.id !== 2) continue;
        finish(readModelListEfforts(message.result?.data));
        return;
      }
    });

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "claudexor", version: "1" } },
    });
  });
}

// Codex advertises effort PER MODEL (`model/list`), so there is no single codex
// ladder to declare here — `codexEffortCapability()` below reads the live one and
// falls back to the recorded snapshot. Cached like cursor's api-key smoke: a
// bounded TTL map, so discovery and every run share one probe instead of
// re-spawning an app-server per call.
const CODEX_EFFORT_CACHE_TTL_MS = 10 * 60_000;
const CODEX_EFFORT_FAILURE_CACHE_TTL_MS = 60_000;

interface CodexEffortCacheEntry {
  capability: CodexEffortCapability;
  /** True when a live `model/list` answered; false when the snapshot filled in. */
  live: boolean;
  expiresAtMs: number;
}
const codexEffortCache = new Map<string, CodexEffortCacheEntry>();

/** Drop the cached effort probe (tests; and the doctor's `fresh` path). */
export function clearCodexEffortCache(): void {
  codexEffortCache.clear();
}

/** Live per-model discovery for one binary in one resolved environment. */
export type CodexEffortProbe = (
  bin: string,
  env?: NodeJS.ProcessEnv,
) => Promise<CodexEffortCapability | null>;

/**
 * Cache identity of ONE codex effort catalog: the resolved `CODEX_HOME` plus the
 * binary path.
 *
 * `model/list` answers for the ACCOUNT the resolved home is logged into, and
 * every credential profile and API-key route gets its own `CODEX_HOME`. Keying by
 * the binary alone therefore served one profile another account's models and
 * ladders for the whole TTL — omitting levels the account really has, or sending
 * levels it does not. The binary stays in the key because two codex versions
 * advertise different catalogs from the same home.
 */
function codexEffortCacheKey(bin: string, env?: NodeJS.ProcessEnv): string {
  // A JSON-encoded pair, not a joined string: both halves are paths, so any
  // printable separator would let two different (home, bin) pairs share a key.
  return JSON.stringify([env?.["CODEX_HOME"] ?? "", bin]);
}

/**
 * The per-model effort vocabulary codex currently advertises FOR THIS ENV. Live
 * when the app-server answers, the recorded snapshot otherwise — a probe failure
 * degrades the ladder's freshness, never the run.
 */
export async function codexEffortCapability(
  probe: CodexEffortProbe,
  nowMs: () => number,
  bin: string,
  env?: NodeJS.ProcessEnv,
): Promise<{ capability: CodexEffortCapability; live: boolean }> {
  const now = nowMs();
  const key = codexEffortCacheKey(bin, env);
  const cached = codexEffortCache.get(key);
  if (cached && cached.expiresAtMs > now) {
    return { capability: cached.capability, live: cached.live };
  }
  const probed = await probe(bin, env);
  const live = probed !== null;
  const capability = probed ?? CODEX_EFFORT_SNAPSHOT;
  codexEffortCache.set(key, {
    capability,
    live,
    expiresAtMs: now + (live ? CODEX_EFFORT_CACHE_TTL_MS : CODEX_EFFORT_FAILURE_CACHE_TTL_MS),
  });
  return { capability, live };
}

/**
 * The catalog for the environment a codex child will ACTUALLY run in. ONE owner
 * of that resolution: callers hand over their env PATCH (spec env + provider
 * scrub + the resolved `CODEX_HOME`) and this resolves it exactly the way the
 * spawn will, so the probe env and the cache identity can never disagree.
 *
 * An API-key route uses a fresh temporary `CODEX_HOME` per run, so it re-probes
 * each time by construction. That is the correct trade: one bounded app-server
 * spawn instead of a cross-account catalog served out of the cache.
 */
export async function codexEffortsForEnv(
  deps: { probeEfforts: CodexEffortProbe; nowMs: () => number },
  envPatch?: Record<string, string | null | undefined>,
): Promise<{ capability: CodexEffortCapability; live: boolean }> {
  return await codexEffortCapability(deps.probeEfforts, deps.nowMs, BIN, probeEnv(envPatch));
}

/**
 * The effort value to send for one (model, requested) pair: advertised passes
 * through verbatim, rankable clamps, anything else sends no flag at all.
 */
export function codexEffortFor(
  capability: CodexEffortCapability,
  model: string | null | undefined,
  requested: EffortHint | null | undefined,
): EffortHint | null {
  return normalizeEffort(
    requested,
    effortLevelsForModel(
      { effort_levels: unionEffortLevels(capability), model_effort_levels: capability },
      model,
    ),
  );
}

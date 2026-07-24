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
import type { EffortHint, ModelEffortCapability } from "@claudexor/schema";
import { effortLevelsForModel } from "@claudexor/schema";
import { normalizeEffort } from "@claudexor/core";

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
 * Harness-wide UNION of an advertised set, in rank order as the vendor lists it.
 * Kept as the coarse `effort_levels` fallback so every existing reader (settings
 * validation, the composer's picker, INV-105 disclosure) keeps working while
 * per-model narrowing happens through `effortLevelsForModel`.
 */
export function unionEffortLevels(capability: CodexEffortCapability): EffortHint[] {
  const seen: EffortHint[] = [];
  for (const entry of Object.values(capability)) {
    for (const level of entry.levels) if (!seen.includes(level)) seen.push(level);
  }
  return seen;
}

interface ModelListEntry {
  id?: unknown;
  defaultReasoningEffort?: unknown;
  supportedReasoningEfforts?: unknown;
}

/** Shape-check one `model/list` entry; anything malformed is skipped, not thrown. */
function readEntry(raw: ModelListEntry): [string, ModelEffortCapability] | null {
  if (typeof raw.id !== "string" || raw.id.trim() === "") return null;
  if (!Array.isArray(raw.supportedReasoningEfforts)) return null;
  const levels: EffortHint[] = [];
  for (const item of raw.supportedReasoningEfforts) {
    const level = (item as { reasoningEffort?: unknown })?.reasoningEffort;
    if (typeof level === "string" && level.trim() !== "" && !levels.includes(level)) {
      levels.push(level);
    }
  }
  if (levels.length === 0) return null;
  const fallback = raw.defaultReasoningEffort;
  return [
    raw.id,
    { levels, default: typeof fallback === "string" && fallback !== "" ? fallback : null },
  ];
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
        const data = message.result?.data;
        if (!Array.isArray(data)) {
          finish(null);
          return;
        }
        const capability: CodexEffortCapability = {};
        for (const raw of data) {
          const entry = readEntry(raw as ModelListEntry);
          if (entry) capability[entry[0]] = entry[1];
        }
        finish(Object.keys(capability).length > 0 ? capability : null);
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

/**
 * The per-model effort vocabulary codex currently advertises. Live when the
 * app-server answers, the recorded snapshot otherwise — a probe failure degrades
 * the ladder's freshness, never the run.
 */
export async function codexEffortCapability(
  probe: (bin: string, env?: NodeJS.ProcessEnv) => Promise<CodexEffortCapability | null>,
  nowMs: () => number,
  bin: string,
  env?: NodeJS.ProcessEnv,
): Promise<{ capability: CodexEffortCapability; live: boolean }> {
  const now = nowMs();
  const cached = codexEffortCache.get(bin);
  if (cached && cached.expiresAtMs > now) {
    return { capability: cached.capability, live: cached.live };
  }
  const probed = await probe(bin, env);
  const live = probed !== null;
  const capability = probed ?? CODEX_EFFORT_SNAPSHOT;
  codexEffortCache.set(bin, {
    capability,
    live,
    expiresAtMs: now + (live ? CODEX_EFFORT_CACHE_TTL_MS : CODEX_EFFORT_FAILURE_CACHE_TTL_MS),
  });
  return { capability, live };
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

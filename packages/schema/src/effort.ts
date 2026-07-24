import { z } from "zod";

/**
 * Reasoning-effort vocabulary: the rank table, the open wire type, and the ONE
 * owner of every derived lookup (per-model narrowing, untyped-surface schema,
 * help text). Split out of harness.ts because effort is its own contract with
 * its own consumers — adapters, the CLI, the MCP tool schema and the macOS
 * picker all resolve through here rather than copying a level list.
 */
/**
 * Canonical cross-harness effort RANK order, weakest→strongest. ONE owner of
 * effort ordering (INV-122): the normalizer, the CLI/MCP surfaces and the
 * generated Swift ordering all read this table instead of copying a list.
 *
 * It is a RANKING aid, NOT an allow-list. Vendors advertise their own
 * vocabularies PER MODEL (codex `model/list` → `supportedReasoningEfforts`,
 * `claude --help` → `--effort`), and a level this table has never heard of must
 * still work when the model advertises it — that is why `EffortHint` below is an
 * open slug rather than an enum. Levels listed here that no adapter currently
 * advertises (`none`, `minimal`) are kept ONLY so they rank correctly the day a
 * vendor ships them; declaring them is the probe's job, never this table's.
 */
export const EFFORT_RANK_ORDER = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

/**
 * Wire carrier for `EFFORT_RANK_ORDER` so NON-TypeScript surfaces (the macOS app)
 * read the rank table out of the generated schema and the derived wire fixture
 * instead of hardcoding an ordering that silently rots.
 */
export const EffortRankOrder = z
  .array(z.enum(EFFORT_RANK_ORDER))
  .describe(
    "Canonical cross-harness reasoning-effort rank order, weakest to strongest. A ranking table, not an allow-list: harnesses advertise their own per-model vocabularies and a level outside this table is passed through untouched when the model advertises it.",
  );
export type EffortRankOrder = z.infer<typeof EffortRankOrder>;

/** Longest effort slug accepted on the wire. */
export const EFFORT_HINT_MAX_LENGTH = 32;
/** Lowercase slug shape: `low`, `xhigh`, `ultra`, `super-max`, `turbo_2`. */
export const EFFORT_HINT_PATTERN = /^[a-z0-9]+(?:[_-][a-z0-9]+)*$/;

/**
 * OPEN cross-harness reasoning-effort vocabulary — deliberately a bounded slug,
 * not an enum, mirroring the vendor contract (codex's own generated schema types
 * `ReasoningEffort` as "a non-empty reasoning effort value advertised by the
 * model"). Adapters advertise the subset they actually accept per (harness,
 * model); the shared normalizer passes an advertised level through verbatim,
 * clamps a rankable-but-unadvertised one onto the nearest advertised level, and
 * REFUSES a level that is neither — so a vendor level newer than this repo works
 * with no code change, and a typo is never silently downgraded.
 */
export const EffortHint = z
  .string()
  .min(1)
  .max(EFFORT_HINT_MAX_LENGTH)
  .regex(
    EFFORT_HINT_PATTERN,
    "effort must be a lowercase slug (letters, digits, single - or _ separators)",
  )
  .describe(
    "Cross-harness reasoning-effort level as a lowercase slug (open vocabulary, mirroring the vendor contract); adapters advertise the levels they accept per model and a shared normalizer passes advertised levels through, clamps rankable ones, and refuses unrankable ones.",
  );
export type EffortHint = z.infer<typeof EffortHint>;

/** What one model advertises: its ordered effort vocabulary and vendor default. */
export const ModelEffortCapability = z
  .object({
    levels: z
      .array(EffortHint)
      .default([])
      .describe(
        "Ordered (weakest to strongest) reasoning-effort levels this model advertises, in the vendor's own order.",
      ),
    default: EffortHint.nullable()
      .default(null)
      .describe("The effort level the vendor uses for this model when none is requested."),
  })
  .strict()
  .describe("Reasoning-effort vocabulary a single model advertises.");
export type ModelEffortCapability = z.infer<typeof ModelEffortCapability>;

/**
 * Is this level one the rank table knows?
 *
 * Used where a syntax must DISAMBIGUATE an effort from neighbouring text — the
 * `harness=model:effort` panel spelling, where `cursor=org:model:v2` must keep
 * `v2` in the model id. The open vocabulary cannot answer that question (every
 * slug is well-formed), so those parsers key off the bounded rank table and an
 * unranked vendor level is passed in the unambiguous position instead
 * (`--reviewer-effort family=level`).
 */
export function isRankedEffort(value: string): boolean {
  return (EFFORT_RANK_ORDER as readonly string[]).includes(value);
}

/**
 * How every surface describes the effort vocabulary in help and refusal text.
 * ONE owner (INV-122) so no CLI string hand-copies a level list — and it
 * deliberately does NOT read as an allow-list, because the real answer is per
 * (harness, model) and lives in the manifest. `none`/`minimal` appear here as
 * RANK positions only; no adapter advertises them today.
 */
export const EFFORT_HINT_HELP = `harness-advertised level, weakest to strongest: ${EFFORT_RANK_ORDER.join(" < ")}`;

/**
 * JSON-Schema fragment for an effort value on UNTYPED surfaces (the MCP tool
 * schema). ONE owner (INV-121/122): the bounds come from the same constants the
 * zod SSOT enforces, so no surface hand-copies a level list — and, critically,
 * the surface stays as OPEN as the vendor contract. Pinning an enum here would
 * reject a level a model genuinely advertises, which is the bug this design
 * exists to prevent; the ranked levels ride in the description as guidance.
 */
export function effortJsonSchema(description: string): Record<string, unknown> {
  return {
    type: "string",
    minLength: 1,
    maxLength: EFFORT_HINT_MAX_LENGTH,
    pattern: EFFORT_HINT_PATTERN.source,
    description: `${description} Ranked levels: ${EFFORT_RANK_ORDER.join(", ")}; a harness may advertise others per model, and an advertised level is passed through as-is.`,
  };
}

/**
 * The effort vocabulary advertised for one (harness, model) pair. ONE owner for
 * the per-model narrowing (INV-122): the model's own advertised list when the
 * probe recorded one, else the harness-wide union. Every surface that needs to
 * know "what efforts may this run use" resolves through here.
 */
export function effortLevelsForModel(
  capabilities: {
    effort_levels: readonly EffortHint[];
    model_effort_levels: Record<string, ModelEffortCapability>;
  },
  model: string | null | undefined,
): readonly EffortHint[] {
  const id = typeof model === "string" ? model.trim() : "";
  const advertised = id ? capabilities.model_effort_levels[id]?.levels : undefined;
  return advertised && advertised.length > 0 ? advertised : capabilities.effort_levels;
}

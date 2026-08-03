import { z } from "zod/v3";
import { ContentHash } from "./primitives.js";

/**
 * An APPLIED filesystem boundary, not a request for one.
 *
 * `verified_denied_path` is the path the profile was executed against before
 * the harness ran: the read was refused on this host, for this attempt. A field
 * that only said "confined: true" would be the promise this whole mechanism
 * exists to replace — which is why the two fields are REQUIRED together and a
 * mechanism name without its proof is not representable in this type.
 */
export const HarnessConfinement = z
  .object({
    mechanism: z
      .string()
      .min(1)
      .describe(
        "OPAQUE identifier of the OS mechanism that enforced the boundary. A reader must never branch on this value or on the host platform; the only question it may ask is whether a PROVEN boundary exists, which is this field AND verified_denied_path both present.",
      ),
    profile: z
      .string()
      .min(1)
      .describe("The exact policy the process was started under, in the mechanism's own encoding."),
    profile_digest: ContentHash.describe("Digest of the policy text, for the attempt record."),
    verified_denied_path: z
      .string()
      .min(1)
      .describe("Path proven unreadable under this policy before the harness was spawned."),
  })
  .describe("An applied OS-enforced filesystem boundary for one harness process.");
export type HarnessConfinement = z.infer<typeof HarnessConfinement>;

/**
 * The confinement half of an attempt record, as every reader sees it.
 *
 * Deliberately NOT a zod object: this is the projection shape shared by the
 * orchestrator (which writes it) and the control API (which reads the written
 * artifact back), and the artifact itself is untyped YAML from a possibly older
 * engine — so the fields arrive as `unknown` and the predicate below is the one
 * place that decides what they mean.
 */
export interface AppliedConfinementRecord {
  confinement_mechanism?: unknown;
  confinement_profile_digest?: unknown;
  confinement_verified_denied_path?: unknown;
  /** Why NO boundary was applied; present exactly when the boundary is absent. */
  confinement_unavailable_reason?: unknown;
}

const nonEmpty = (value: unknown): boolean => typeof value === "string" && value.length > 0;

/**
 * Whether an attempt record proves a boundary was actually enforced.
 *
 * ONE owner, because the answer is load-bearing in two codebases: a mechanism
 * named WITHOUT the path it was proven to deny is exactly the bare promise the
 * applied-fact block exists to replace, so it reads as NO boundary. An external
 * orchestrator asks this question and nothing else — never the platform, never
 * the mechanism's name.
 */
export function confinementBoundaryProven(record: AppliedConfinementRecord | null): boolean {
  if (!record) return false;
  return (
    nonEmpty(record.confinement_mechanism) &&
    nonEmpty(record.confinement_profile_digest) &&
    nonEmpty(record.confinement_verified_denied_path)
  );
}

export const ContainmentKind = z
  .enum([
    "env_or_file_injection",
    "scoped_home_keychain_bridge",
    "host_user_context",
    "process_sandbox",
    "container",
  ])
  .describe(
    "Isolation containment level an adapter supports for run environments, from env/file injection through scoped-HOME keychain bridging to process sandboxes and containers.",
  );
export type ContainmentKind = z.infer<typeof ContainmentKind>;

export const IsolationCapabilities = z
  .object({
    supported_containment: z
      .array(ContainmentKind)
      .default(["env_or_file_injection"])
      .describe("Containment mechanisms the adapter can run under."),
  })
  .default({})
  .describe("Declared isolation containment facts for a harness.");
export type IsolationCapabilities = z.infer<typeof IsolationCapabilities>;

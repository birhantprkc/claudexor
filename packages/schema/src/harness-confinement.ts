import { z } from "zod/v3";
import { ContentHash } from "./primitives.js";

/**
 * An APPLIED filesystem boundary, not a request for one.
 *
 * `verified_denied_path` is the path the profile was executed against before
 * the harness ran: the read was refused on this host, for this attempt. A field
 * that only said "confined: true" would be the promise this whole mechanism
 * exists to replace.
 */
export const HarnessConfinement = z
  .object({
    mechanism: z
      .literal("seatbelt")
      .describe("OS mechanism enforcing the boundary (macOS Seatbelt via /usr/bin/sandbox-exec)."),
    profile: z.string().min(1).describe("The exact policy text the process was started under."),
    profile_digest: ContentHash.describe("Digest of the policy text, for the attempt record."),
    verified_denied_path: z
      .string()
      .min(1)
      .describe("Path proven unreadable under this policy before the harness was spawned."),
  })
  .describe("An applied OS-enforced filesystem boundary for one harness process.");
export type HarnessConfinement = z.infer<typeof HarnessConfinement>;

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

import { existsSync } from "node:fs";
import { DelegatedHomeUnavailableError } from "@claudexor/core";
import type { WorkspaceEnvelope } from "@claudexor/schema";
import type { WorkspaceManager } from "@claudexor/workspace";

/** What one attempt's harness HOME actually resolved to, and whether it is scoped. */
export interface ScopedHarnessHome {
  /** Env patch to spread onto the harness spec; absent when the attempt inherits the operator's env. */
  env?: Record<string, string>;
  /** Applied fact, recorded on the attempt so the caller can verify rather than trust. */
  isolated: boolean;
  /** The scoped home directory, or null when the attempt inherits the operator's. */
  homeDir: string | null;
}

/**
 * Decide the harness HOME one attempt runs under.
 *
 * Unchanged for ordinary runs: an ISOLATED envelope gets the envelope's scoped
 * home, while an IN-PLACE attempt deliberately inherits the operator's native
 * environment so a harness whose native session store hangs off `$HOME` can
 * resume its vendor conversation.
 *
 * A DELEGATED run (`execution.delegated`) is scoped either way, and that is a
 * BEHAVIORAL CHANGE against that deliberate design — live + agent is exactly
 * the configuration a delegated mutating subagent uses. It is taken knowingly:
 * the caller is a machine orchestrator that owns the workspace, and the
 * operator's real `$HOME` holds material no delegated harness may read, above
 * all `~/.claudexor/v3/daemon/token`, which grants the entire control API.
 *
 * THE COST, stated plainly: an in-place delegated attempt CANNOT resume a
 * native vendor session whose store lives under the real `$HOME` — cursor
 * (`~/.cursor`) and opencode (XDG data under `$HOME`) lose resume. codex and
 * claude keep it: their native session stores are Claudexor-owned directories
 * (`defaultNativeCodexHome` / `defaultNativeClaudeConfigDir`) that the adapter
 * re-points on top of this env, and the macOS login Keychain is reached through
 * the declared scoped-home bridge (INV-067), so subscription auth is unaffected.
 *
 * Never degrades silently: a delegated attempt whose scoped home is not on disk
 * refuses instead of spawning a harness in the operator's home.
 */
export function scopedHarnessHome(
  wsm: WorkspaceManager,
  envelope: WorkspaceEnvelope,
  inPlaceEnvelope: boolean,
  delegated: boolean,
): ScopedHarnessHome {
  if (inPlaceEnvelope && !delegated) return { isolated: false, homeDir: null };
  const env = wsm.envFor(envelope);
  const homeDir = env["HOME"];
  if (delegated && (!homeDir || !existsSync(homeDir))) {
    throw new DelegatedHomeUnavailableError(
      `delegated run cannot be confined: the scoped harness home for attempt ${envelope.attempt_id} is missing (${homeDir || "unset"})`,
    );
  }
  return { env, isolated: true, homeDir: homeDir ?? null };
}

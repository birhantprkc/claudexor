import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_MAX_SUBRUNS, delegationEnv } from "@claudexor/mcp-server";
import { defaultSocketPath } from "@claudexor/daemon";
import { DelegationBeltUnavailableError } from "@claudexor/core";
import { userConfigDir } from "@claudexor/util";
import type { ExtraMcpServer, PaidBudget } from "@claudexor/schema";

/**
 * The daemon-discovery env the belt process needs to reach THIS daemon from
 * inside the harness's scoped HOME. The belt runs as an MCP subprocess of the
 * delegate harness (claude/codex), which remaps HOME to a per-lane scoped dir
 * for credential isolation. Left to default, the belt's `defaultSocketPath()`
 * and token lookup both re-derive under that scoped HOME → a socket/token that
 * does not exist → the belt tries to AUTO-START a fresh daemon there, fails
 * ("daemon did not come up within 30s"), and every belt run tool errors. Pin
 * the belt to the real daemon by injecting the ACTUAL config root (so the token
 * and daemon dir resolve to this daemon's) and the exact socket path — both
 * captured from the live daemon env at descriptor-build time, so this is correct
 * whether or not the daemon itself was launched under an override. These env
 * vars affect ONLY the belt process's own daemon RPC; the sub-run workspaces the
 * belt requests are scoped by this daemon, not by the belt's environment.
 */
export function beltDaemonDiscoveryEnv(): Record<string, string> {
  return {
    CLAUDEXOR_CONFIG_DIR: userConfigDir(),
    CLAUDEXOR_DAEMON_SOCK: defaultSocketPath(),
    // The belt intentionally points at the parent daemon's non-default root
    // from inside a scoped HOME. Mark that override as deliberate so an
    // inherited matching host-plugin version cannot misclassify it as stale
    // plugin_artifact_skew before MCP initialize.
    CLAUDEXOR_ROOT_MODE: "explicit",
  };
}

/**
 * Resolve the exact entry that started THIS daemon. `runClaudexordEntry()`
 * dispatches `mcp serve-belt` before daemon initialization, so the same path
 * works for direct dev/npm `claudexord.js`, the npm bin wrapper, and the
 * packaged single-file `claudexord.bundle.cjs`. There is no adjacent-file
 * guess and no second CLI copy in the app closure.
 */
export function resolveDaemonEntry(
  argv1: string | undefined = process.argv[1],
): string | undefined {
  if (!argv1) return undefined;
  const entry = resolve(argv1);
  return existsSync(entry) ? entry : undefined;
}

/**
 * Build the delegation belt MCP-server descriptor injected into a delegate
 * agent run's sandbox (D32). The child harness re-enters the exact running
 * daemon entry as `node <daemon-entry> mcp serve-belt`; that entry dispatches
 * the side-effect-free belt server before daemon startup. The belt process
 * reads its policy from the injected env: depth 0
 * (top-level — the sub-runs it starts carry no belt, so nesting cannot exceed
 * 1), the sub-run cap, and a conservative snapshot of the parent's paid-budget
 * headroom. The daemon-lifetime shared ledger remains the authoritative cap.
 *
 * QA-024 remains fail-closed: when the executing daemon entry cannot be
 * resolved on disk, throw before harness spawn instead of emitting a dead MCP
 * descriptor that could silently degrade to a native subagent.
 */
export function buildDelegationBeltDescriptor(
  paidBudget: PaidBudget | undefined,
  daemonEntry: string | null | undefined = resolveDaemonEntry(),
  discoveryEnv: Record<string, string> = beltDaemonDiscoveryEnv(),
): ExtraMcpServer {
  if (!daemonEntry) {
    throw new DelegationBeltUnavailableError(
      "--delegate cannot start the Claudexor delegation belt: the running daemon entry could not be resolved on disk. Re-run without --delegate, or repair/update the Claudexor runtime.",
    );
  }
  return {
    name: "claudexor",
    command: process.execPath,
    args: [daemonEntry, "mcp", "serve-belt"],
    required: true,
    env: {
      // Daemon discovery FIRST so the delegation-policy vars can never be
      // clobbered by a discovery key (disjoint namespaces, but explicit).
      ...discoveryEnv,
      ...delegationEnv({
        parentRunId: "",
        // Rebound by the orchestrator from the normalized run input before the
        // descriptor reaches any lane; empty fails closed at the tool boundary.
        repoRoot: "",
        depth: 0,
        maxSubRuns: DEFAULT_MAX_SUBRUNS,
        parentBudget: paidBudget ?? { kind: "unlimited" },
      }),
    },
  };
}

/** Composition-root policy: only a known pre-start entry absence may degrade
 * Delegate to ordinary Agent. The orchestrator receives requested=true plus a
 * null belt and owns the durable runtime_unavailable receipt. */
export function delegationBeltForRun(
  requested: boolean,
  paidBudget: PaidBudget | undefined,
  daemonEntry: string | null | undefined = resolveDaemonEntry(),
  discoveryEnv: Record<string, string> = beltDaemonDiscoveryEnv(),
): ExtraMcpServer | null {
  if (!requested) return null;
  try {
    return buildDelegationBeltDescriptor(paidBudget, daemonEntry ?? null, discoveryEnv);
  } catch (error) {
    if (error instanceof DelegationBeltUnavailableError) return null;
    throw error;
  }
}

import type { ProcessIdentityReader } from "@claudexor/core";
import {
  classifyDaemonLeaseOwner,
  inspectDaemonWriterLease,
  type DaemonLeaseOwner,
  type DaemonLeaseOwnerCapability,
  type DaemonWriterLeaseStatus,
} from "./writer-lease.js";

export type DaemonTerminationOutcome =
  /** The daemon released its lease or its pid is gone — confirmed dead. */
  | { outcome: "exited"; detail: string }
  /** The graceful window lapsed; an identity-VERIFIED SIGKILL brought it down. */
  | { outcome: "killed"; detail: string }
  /** Still alive at the deadline (or unkillable without identity proof). */
  | { outcome: "still_alive"; detail: string };

export interface AwaitDaemonTerminationOptions {
  /** Total confirmation budget (default 20s: the daemon's own W-C8 ladder
   * self-exits within its 15s stop deadline + 2s drain sweep + slack). */
  deadlineMs?: number;
  /** Graceful window before the SIGKILL escalation (default 17s). */
  killAfterMs?: number;
  /** Whether this caller has authority to escalate to SIGKILL (default false).
   * Runtime
   * replacement grants that authority only after an explicit fenced admission
   * receipt; an ambiguous RPC failure may observe death but never cause it. */
  allowSigkill?: boolean;
  /** Exact daemon process instance selected before the stop RPC. Without this
   * the waiter could pin a same-build successor that acquired the lease while
   * the admission response was in flight. */
  expectedOwner?: DaemonLeaseOwner;
  /** Runtime replacement refuses a successor observed during this termination
   * proof. The separately-adjudicated post-return/pointer-swap gap is outside
   * this waiter's observation window. */
  requireNoSuccessor?: boolean;
  pollMs?: number;
}

export interface DaemonTerminationDeps {
  identity?: ProcessIdentityReader;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  isAlive?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Strict writer-lease authority used by termination. This is deliberately a
 * separate argument rather than new optional members on DaemonTerminationDeps:
 * downstream dependency objects may already use these names for unrelated
 * private or runtime state.
 */
export interface DaemonTerminationLeaseAuthority {
  inspect(socketPath: string): DaemonWriterLeaseStatus;
  classify(owner: DaemonLeaseOwner): DaemonLeaseOwnerCapability;
}

const DEFAULT_LEASE_AUTHORITY: DaemonTerminationLeaseAuthority = {
  inspect: (socketPath) => inspectDaemonWriterLease(socketPath),
  classify: (owner) => classifyDaemonLeaseOwner(owner),
};

function sameOwner(left: DaemonLeaseOwner, right: DaemonLeaseOwner): boolean {
  return left.pid === right.pid && left.token === right.token;
}

function staleOwnerDetail(owner: DaemonLeaseOwner, capability: DaemonLeaseOwnerCapability): string {
  if (capability.status !== "proven_stale") return `daemon pid ${owner.pid} exited`;
  switch (capability.reason) {
    case "process_missing":
      return `daemon pid ${owner.pid} is gone`;
    case "identity_mismatch":
      return `pid ${owner.pid} was recycled by another process (never signalled)`;
    case "linux_zombie":
      return `daemon pid ${owner.pid} is a Linux zombie (never signalled)`;
  }
}

/**
 * Await the CONFIRMED death of the daemon owning `socketPath`'s writer lease
 * (W3.5): "stop requested" is not "stopped" — a disposer that removes state
 * under a still-live daemon manufactures orphans.
 *
 * The target is PINNED at entry (`terminateAndWait(exactIdentity, deadline)`):
 * the lease owner is snapshotted once and every later observation is judged
 * against THAT owner. Re-reading the lease each poll would follow whoever
 * currently holds it, so a replacement daemon started during the confirmation
 * window (the app auto-starts one) could be waited on — and SIGKILLed — in
 * place of the process we were asked to stop.
 *
 * Confirmed death = the pinned owner released its lease, or the canonical
 * classifier proves its pid missing, recycled, or a Linux zombie. A takeover
 * alone does not prove that the old owner exited. Past the graceful window a
 * SIGKILL is sent ONLY when an explicitly supplied pinned birth identity still
 * matches the process in that same iteration; without that proof this fails
 * closed to an honest `still_alive`.
 */
export async function awaitDaemonTermination(
  socketPath: string,
  options: AwaitDaemonTerminationOptions = {},
  deps: DaemonTerminationDeps = {},
  leaseAuthority: DaemonTerminationLeaseAuthority = DEFAULT_LEASE_AUTHORITY,
): Promise<DaemonTerminationOutcome> {
  const deadlineMs = options.deadlineMs ?? 20_000;
  const killAfterMs = options.killAfterMs ?? 17_000;
  const allowSigkill = options.allowSigkill ?? false;
  const pollMs = options.pollMs ?? 150;
  const kill = deps.kill ?? ((pid, signal) => process.kill(pid, signal));
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;

  const start = now();
  let killed = false;
  let noKillReason: string | null = null;
  let current = leaseAuthority.inspect(socketPath);
  // The ONE owner this call is about. Everything below judges the world
  // against this snapshot — never against whoever holds the lease later.
  let owner = options.expectedOwner;
  if (!owner) {
    if (current.status === "absent") {
      return { outcome: "exited", detail: "no daemon owns the writer lease" };
    }
    if (current.status === "unknown") {
      return {
        outcome: "still_alive",
        detail: `daemon activity is unknown (${current.reason})`,
      };
    }
    if (current.capability.status === "proven_stale") {
      return { outcome: "exited", detail: staleOwnerDetail(current.owner, current.capability) };
    }
    owner = current.owner;
  }

  const explicitOwner = options.expectedOwner !== undefined;
  for (;;) {
    if (current.status === "absent") {
      return {
        outcome: killed ? "killed" : "exited",
        detail: killed ? "daemon exited after SIGKILL escalation" : "daemon released its lease",
      };
    }

    const successor =
      current.status === "owned" && !sameOwner(current.owner, owner) ? current : null;
    const targetCapability =
      current.status === "owned" && sameOwner(current.owner, owner)
        ? current.capability
        : leaseAuthority.classify(owner);

    if (targetCapability.status === "proven_stale") {
      if (options.requireNoSuccessor) {
        if (current.status === "unknown") {
          return {
            outcome: "still_alive",
            detail: `daemon pid ${owner.pid} exited but writer-lease activity is unknown (${current.reason})`,
          };
        }
        if (successor && successor.capability.status !== "proven_stale") {
          return {
            outcome: "still_alive",
            detail: `daemon pid ${owner.pid} exited but successor pid ${successor.owner.pid} owns the writer lease`,
          };
        }
      }
      const successorDetail = successor
        ? ` (writer lease now records stale pid ${successor.owner.pid})`
        : "";
      return {
        outcome: killed ? "killed" : "exited",
        detail: `${staleOwnerDetail(owner, targetCapability)}${successorDetail}`,
      };
    }

    const elapsed = now() - start;
    if (elapsed >= deadlineMs) {
      return {
        outcome: "still_alive",
        detail:
          noKillReason ??
          (killed
            ? `daemon pid ${owner.pid} survived SIGKILL confirmation window`
            : `daemon pid ${owner.pid} is still alive after ${deadlineMs}ms`),
      };
    }
    if (!killed && elapsed >= killAfterMs) {
      if (!allowSigkill) {
        noKillReason = `daemon pid ${owner.pid} is still alive; SIGKILL withheld (caller has no signal authority)`;
      } else if (!explicitOwner) {
        noKillReason = `daemon pid ${owner.pid} is still alive; SIGKILL withheld (no explicit expected owner)`;
      } else if (
        owner.identity &&
        targetCapability.status === "capable" &&
        targetCapability.reason === "identity_match"
      ) {
        // Escalate only with caller admission and a fresh canonical identity
        // match for the pinned target from this exact iteration.
        try {
          kill(owner.pid, "SIGKILL");
          killed = true;
        } catch {
          /* delivery raced its exit; the next poll observes the truth */
        }
      } else {
        noKillReason = `daemon pid ${owner.pid} is still alive; SIGKILL withheld (${
          owner.identity ? "identity unverifiable" : "no recorded birth identity"
        })`;
      }
    }
    await sleep(pollMs);
    current = leaseAuthority.inspect(socketPath);
  }
}

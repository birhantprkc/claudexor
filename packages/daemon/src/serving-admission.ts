import { timingSafeEqual } from "node:crypto";

/**
 * Product admission of the serving daemon (issue #165 D5). One canonical
 * coordinator snapshot drives the socket RPC gate, the control-API route
 * gate, and the handshake's `servingMode` disclosure — transport/protocol
 * success stays separate from product readiness. `recovery_only` keeps the
 * recovery plane (health, handshake, recovery routes, operator stop) online
 * while every normal product surface refuses with one typed error.
 */
export type DaemonServingMode = "normal" | "recovery_only";

/** Snapshot reader wired into servers; absent means an always-normal embedder. */
export type DaemonServingModeSnapshot = () => DaemonServingMode;

export function servingModeOf(snapshot: DaemonServingModeSnapshot | undefined): DaemonServingMode {
  return snapshot?.() ?? "normal";
}

/** The single typed refusal every closed product surface returns. */
export function recoveryOnlyRefusal(
  surface: string,
): Error & { code: "daemon_recovery_only"; status: 503; retryable: true } {
  return Object.assign(
    new Error(
      `daemon is serving recovery only; '${surface}' is closed until journal recovery completes`,
    ),
    { code: "daemon_recovery_only" as const, status: 503 as const, retryable: true as const },
  );
}

/** Constant-time token comparison shared by the socket and HTTP planes. */
export function daemonTokenMatches(candidate: string, expected: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

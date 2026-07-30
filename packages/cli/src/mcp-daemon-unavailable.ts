const MUTATING_RECOVERY_MODES = new Set(["__run_cancel", "__run_answer", "__apply_check"]);

export const BELT_DAEMON_LOST =
  "the Claudexor delegation belt cannot reach its parent daemon; retry the parent run after repairing or restarting the runtime";

/** Project one absent-daemon fact without letting mutating recovery look successful. */
export function absentDaemonRecovery(mode: string, beltContext = false): { summary: string } {
  if (MUTATING_RECOVERY_MODES.has(mode)) {
    throw Object.assign(
      new Error(
        beltContext
          ? BELT_DAEMON_LOST
          : "the Claudexor daemon is not running; this action was not performed",
      ),
      { code: "daemon_unavailable", retryable: true },
    );
  }
  return {
    summary: beltContext
      ? BELT_DAEMON_LOST
      : "the Claudexor daemon is not running — there are no live daemon-tracked runs to recover (start one with `claudexor daemon start` or run a mutating tool first)",
  };
}

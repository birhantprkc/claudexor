export type DaemonShutdownRpcReceipt = { ok: true; fenced?: true };

export function replacementRefusal(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = (error as { code: unknown }).code;
  return code === "runtime_replacement_busy" || code === "runtime_activity_unknown";
}

/** Socket shutdown protocol owner. Ordinary operator shutdown stays delayed and
 * forceful. Runtime replacement instead runs one synchronous activity check and
 * composition callback; that callback must check setup then enter the shared
 * shutdown state machine before returning its promise. */
export function dispatchShutdownRpc(
  method: string,
  transientActivity: number,
  readRecords: () => Iterable<{ state: string }>,
  requestOperatorShutdown: () => Promise<void>,
  requestRuntimeReplacement?: () => Promise<void>,
): DaemonShutdownRpcReceipt | null {
  if (method === "claudexor.shutdown") {
    setTimeout(() => {
      void requestOperatorShutdown().catch(() => {
        // Fail closed: the process and ownership lease remain alive. The
        // composition root records the detailed failure in its private log.
      });
    }, 10);
    return { ok: true };
  }
  if (method !== "claudexor.shutdownForRuntimeReplacement") return null;

  let busy: boolean;
  try {
    busy =
      transientActivity > 0 ||
      [...readRecords()].some((record) => record.state === "queued" || record.state === "running");
  } catch (cause) {
    throw Object.assign(new Error("runtime replacement could not prove daemon activity state"), {
      code: "runtime_activity_unknown",
      status: 503,
      retryable: true,
      cause,
    });
  }
  if (busy) {
    throw Object.assign(new Error("runtime replacement is deferred while daemon work is active"), {
      code: "runtime_replacement_busy",
      status: 409,
      retryable: true,
    });
  }
  if (!requestRuntimeReplacement) {
    throw Object.assign(new Error("runtime replacement admission authority is unavailable"), {
      code: "runtime_activity_unknown",
      status: 503,
      retryable: true,
    });
  }

  // No await or timer separates the daemon activity check from this callback.
  // Its synchronous prefix checks setup and fences setup/control/run admission.
  const operation = requestRuntimeReplacement();
  void operation.catch(() => {
    // An accepted stop may close the response socket. The caller proves the
    // pinned daemon's termination rather than trusting response delivery.
  });
  return { ok: true, fenced: true };
}

import type { ChildProcess } from "node:child_process";

const APP_SERVER_TERM_GRACE_MS = 2_000;
const APP_SERVER_KILL_GRACE_MS = 2_000;

/**
 * Stop the directly-owned app-server child and prove its close before a setup
 * result can become durable. A terminal auth frame is not process-death
 * evidence: the vendor child may ignore TERM or retain the stdio closure.
 */
export async function terminateAppServerChild(
  child: ChildProcess,
  connection: { close(): void },
  options: { termGraceMs?: number; killGraceMs?: number } = {},
): Promise<void> {
  connection.close();
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill("SIGTERM");
  } catch {
    // A concurrent natural exit is accepted only when the child reports it.
  }
  if (await childClosedWithin(child, options.termGraceMs ?? APP_SERVER_TERM_GRACE_MS)) return;
  try {
    child.kill("SIGKILL");
  } catch {
    // The bounded proof below remains authoritative.
  }
  if (await childClosedWithin(child, options.killGraceMs ?? APP_SERVER_KILL_GRACE_MS)) return;
  throw new Error("codex app-server termination could not be confirmed");
}

function childClosedWithin(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolveClosed) => {
    const finish = (closed: boolean) => {
      clearTimeout(timer);
      child.off("close", onClose);
      resolveClosed(closed);
    };
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(false), Math.max(0, timeoutMs));
    timer.unref();
    child.once("close", onClose);
  });
}

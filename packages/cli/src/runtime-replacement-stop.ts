import {
  DaemonClient,
  awaitDaemonTermination,
  defaultSocketPath,
  readToken,
  socketAlive,
} from "@claudexor/daemon";

interface RuntimeReplacementStopDeps {
  socketPath(): string;
  readToken(): string | null;
  socketAlive(path: string): Promise<boolean>;
  client(path: string, token: string): Pick<DaemonClient, "shutdownForRuntimeReplacement">;
  awaitTermination(path: string): ReturnType<typeof awaitDaemonTermination>;
  write(line: string): void;
}

const productionDeps: RuntimeReplacementStopDeps = {
  socketPath: defaultSocketPath,
  readToken,
  socketAlive,
  client: (path, token) => new DaemonClient(path, token),
  awaitTermination: awaitDaemonTermination,
  write: (line) => process.stdout.write(line),
};

function refusalCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const code = (error as { code: unknown }).code;
  return code === "runtime_replacement_busy" || code === "runtime_activity_unknown" ? code : null;
}

/** Handle `claudexord --stop`: the identity-proven, admission-safe shutdown the
 * macOS installer runs before an atomic pointer swap. Unlike explicit operator
 * shutdown, this asks the daemon to atomically prove idle and fence every ingress
 * before stopping. The pinned termination proof remains authoritative when the
 * accepted RPC response is lost as the socket closes. */
export async function runStopIfRequested(
  argv: readonly string[],
  deps: RuntimeReplacementStopDeps = productionDeps,
): Promise<boolean> {
  if (!argv.includes("--stop")) return false;
  const socketPath = deps.socketPath();
  const token = deps.readToken();
  if (!token || !(await deps.socketAlive(socketPath))) {
    deps.write(`${JSON.stringify({ stopped: true, alreadyStopped: true })}\n`);
    return true;
  }
  try {
    await deps.client(socketPath, token).shutdownForRuntimeReplacement();
  } catch (error) {
    const code = refusalCode(error);
    if (code) {
      deps.write(
        `${JSON.stringify({ stopped: false, code, retryable: true, detail: (error as Error).message })}\n`,
      );
      process.exitCode = 1;
      return true;
    }
    // An accepted shutdown can close the RPC socket before its response lands.
  }
  const termination = await deps.awaitTermination(socketPath);
  const stopped = termination.outcome !== "still_alive";
  deps.write(
    `${JSON.stringify({ stopped, outcome: termination.outcome, detail: termination.detail })}\n`,
  );
  if (!stopped) process.exitCode = 1;
  return true;
}

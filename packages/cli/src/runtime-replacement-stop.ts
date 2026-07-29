import {
  type AwaitDaemonTerminationOptions,
  type DaemonTerminationOutcome,
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
  awaitTermination(
    path: string,
    options: AwaitDaemonTerminationOptions,
  ): ReturnType<typeof awaitDaemonTermination>;
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

function refusalCode(
  error: unknown,
): "runtime_replacement_busy" | "runtime_activity_unknown" | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const code = (error as { code: unknown }).code;
  return code === "runtime_replacement_busy" || code === "runtime_activity_unknown" ? code : null;
}

function activityUnknown(message: string, cause?: unknown): Error {
  return Object.assign(new Error(message), {
    code: "runtime_activity_unknown",
    status: 503,
    retryable: true,
    ...(cause === undefined ? {} : { cause }),
  });
}

function isFencedAdmissionReceipt(value: unknown): value is { ok: true; fenced: true } {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { ok?: unknown }).ok === true &&
    (value as { fenced?: unknown }).fenced === true
  );
}

/** One owner for the admission/termination uncertainty boundary used by both
 * local and remote runtime replacement. Only a proven `{ok:true,fenced:true}`
 * receipt grants signal authority. A lost or untyped response may passively
 * prove that the pinned daemon exited, but can never turn into a kill. */
export async function admitAndAwaitRuntimeReplacementStop(
  requestAdmission: () => Promise<unknown>,
  awaitTermination: (options: AwaitDaemonTerminationOptions) => Promise<DaemonTerminationOutcome>,
): Promise<DaemonTerminationOutcome> {
  let admitted = false;
  let admissionFailure: unknown;
  try {
    const receipt = await requestAdmission();
    if (!isFencedAdmissionReceipt(receipt)) {
      throw activityUnknown("runtime replacement returned no fenced admission receipt");
    }
    admitted = true;
  } catch (error) {
    if (refusalCode(error)) throw error;
    admissionFailure = error;
  }

  const termination = await awaitTermination({ allowSigkill: admitted });
  if (!admitted && termination.outcome !== "exited") {
    throw activityUnknown(
      `runtime replacement admission is uncertain and the daemon remains alive: ${termination.detail}`,
      admissionFailure,
    );
  }
  return termination;
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
  let termination: DaemonTerminationOutcome;
  try {
    termination = await admitAndAwaitRuntimeReplacementStop(
      () => deps.client(socketPath, token).shutdownForRuntimeReplacement(),
      (options) => deps.awaitTermination(socketPath, options),
    );
  } catch (error) {
    const code = refusalCode(error);
    if (code) {
      deps.write(
        `${JSON.stringify({ stopped: false, code, retryable: true, detail: (error as Error).message })}\n`,
      );
      process.exitCode = 1;
      return true;
    }
    throw error;
  }
  const stopped = termination.outcome !== "still_alive";
  deps.write(
    `${JSON.stringify({ stopped, outcome: termination.outcome, detail: termination.detail })}\n`,
  );
  if (!stopped) process.exitCode = 1;
  return true;
}

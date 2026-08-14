import {
  type AwaitDaemonTerminationOptions,
  type DaemonTerminationOutcome,
  type DaemonLeaseOwner,
  type DaemonWriterLeaseStatus,
  DaemonClient,
  type RuntimeReplacementTarget,
  awaitDaemonTermination,
  defaultSocketPath,
  inspectDaemonWriterLease,
  readToken,
  socketAlive,
} from "@claudexor/daemon";

interface RuntimeReplacementStopDeps {
  socketPath(): string;
  readToken(): string | null;
  socketAlive(path: string): Promise<boolean>;
  inspectLease(path: string): DaemonWriterLeaseStatus;
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
  inspectLease: inspectDaemonWriterLease,
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

function isTargetBoundAdmissionReceipt(
  value: unknown,
): value is { ok: true; fenced: true; targetBound: true } {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { ok?: unknown }).ok === true &&
    (value as { fenced?: unknown }).fenced === true &&
    (value as { targetBound?: unknown }).targetBound === true
  );
}

function stopIdentity(
  argv: readonly string[],
): Pick<RuntimeReplacementTarget, "version" | "buildSha"> | null {
  const stop = argv.indexOf("--stop");
  if (stop < 0 || argv.length !== stop + 3) return null;
  const version = argv[stop + 1];
  const buildSha = argv[stop + 2];
  if (
    typeof version !== "string" ||
    version.length === 0 ||
    typeof buildSha !== "string" ||
    !/^[0-9a-f]{40}$/.test(buildSha)
  ) {
    return null;
  }
  return { version, buildSha };
}

function writeRefusal(
  deps: Pick<RuntimeReplacementStopDeps, "write">,
  code: "runtime_replacement_busy" | "runtime_activity_unknown",
  detail: string,
): void {
  deps.write(`${JSON.stringify({ stopped: false, code, retryable: true, detail })}\n`);
  process.exitCode = 1;
}

/** Shared no-Control decision for local and remote runtime replacement.
 * This policy never selects a target: only a physically absent or positively
 * stale lease alongside an unreachable socket proves idempotent stop. */
export function decideRuntimeReplacementWithoutControl(
  socketReachable: boolean,
  lease: DaemonWriterLeaseStatus,
): { status: "already_stopped" } | { status: "activity_unknown"; detail: string } {
  if (socketReachable) {
    return {
      status: "activity_unknown",
      detail: "runtime replacement found a reachable daemon socket without verified Control",
    };
  }
  if (
    lease.status === "absent" ||
    (lease.status === "owned" && lease.capability.status === "proven_stale")
  ) {
    return { status: "already_stopped" };
  }
  if (lease.status === "unknown") {
    return {
      status: "activity_unknown",
      detail: `runtime replacement cannot verify writer-lease authority (${lease.reason})`,
    };
  }
  return {
    status: "activity_unknown",
    detail:
      lease.capability.status === "capable"
        ? "runtime replacement found a capable writer lease but no reachable daemon socket"
        : "runtime replacement cannot verify writer-lease activity",
  };
}

/** Package-private projection for the authenticated local and remote paths. */
export function runtimeReplacementCapableOwner(
  lease: DaemonWriterLeaseStatus,
): DaemonLeaseOwner | null {
  return lease.status === "owned" && lease.capability.status === "capable" ? lease.owner : null;
}

/** One owner for the admission/termination uncertainty boundary used by both
 * local and remote runtime replacement. Only a proven
 * `{ok:true,fenced:true,targetBound:true}` receipt grants
 * signal authority for the pre-RPC writer-lease owner.
 * A lost, legacy, or untyped response may passively prove that the pinned
 * daemon exited, but can never turn into a kill. */
export async function admitAndAwaitRuntimeReplacementStop(
  requestAdmission: () => Promise<unknown>,
  awaitTermination: (options: AwaitDaemonTerminationOptions) => Promise<DaemonTerminationOutcome>,
  expectedOwner: DaemonLeaseOwner,
): Promise<DaemonTerminationOutcome> {
  let admitted = false;
  let admissionFailure: unknown;
  try {
    const receipt = await requestAdmission();
    if (isTargetBoundAdmissionReceipt(receipt)) {
      admitted = true;
    } else {
      // A pre-v3.2 daemon can accept the same method while ignoring its new
      // identity parameters and return the legacy fenced receipt. It may still
      // exit naturally, but it never grants signal authority to the caller.
      admissionFailure = activityUnknown(
        "runtime replacement returned no identity-bound admission receipt",
      );
    }
  } catch (error) {
    if (refusalCode(error)) throw error;
    admissionFailure = error;
  }

  const termination = await awaitTermination({
    allowSigkill: admitted,
    expectedOwner,
    requireNoSuccessor: true,
  });
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
  const expectedIdentity = stopIdentity(argv);
  if (!expectedIdentity) {
    writeRefusal(
      deps,
      "runtime_activity_unknown",
      "runtime replacement requires an exact expected version and build SHA",
    );
    return true;
  }
  const socketPath = deps.socketPath();
  const alive = await deps.socketAlive(socketPath);
  if (!alive) {
    const decision = decideRuntimeReplacementWithoutControl(false, deps.inspectLease(socketPath));
    if (decision.status === "activity_unknown") {
      writeRefusal(deps, "runtime_activity_unknown", decision.detail);
      return true;
    }
    deps.write(`${JSON.stringify({ stopped: true, alreadyStopped: true })}\n`);
    return true;
  }
  const token = deps.readToken();
  if (!token) {
    const decision = decideRuntimeReplacementWithoutControl(true, deps.inspectLease(socketPath));
    if (decision.status === "activity_unknown") {
      writeRefusal(deps, "runtime_activity_unknown", decision.detail);
      return true;
    }
    throw new Error("reachable socket unexpectedly classified as already stopped");
  }
  // Select the target from a fresh strict inspection immediately before the
  // target-bound admission RPC. Stale, absent, or unknown authority cannot be
  // turned into a signal target even when the socket itself is reachable.
  const expectedOwner = runtimeReplacementCapableOwner(deps.inspectLease(socketPath));
  if (!expectedOwner) {
    writeRefusal(
      deps,
      "runtime_activity_unknown",
      "runtime replacement cannot bind the live daemon to its writer lease",
    );
    return true;
  }
  const expectedTarget: RuntimeReplacementTarget = {
    ...expectedIdentity,
    leaseOwner: { pid: expectedOwner.pid, token: expectedOwner.token },
  };
  let termination: DaemonTerminationOutcome;
  try {
    termination = await admitAndAwaitRuntimeReplacementStop(
      () => deps.client(socketPath, token).shutdownForRuntimeReplacement(expectedTarget),
      (options) => deps.awaitTermination(socketPath, options),
      expectedOwner,
    );
  } catch (error) {
    const code = refusalCode(error);
    if (code) {
      writeRefusal(deps, code, (error as Error).message);
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

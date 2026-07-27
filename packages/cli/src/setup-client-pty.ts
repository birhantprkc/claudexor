import { rmSync } from "node:fs";
import type {
  ControlSetupJob,
  ControlSetupJobTransport,
  SetupDeviceCodeDisclosure,
} from "@claudexor/schema";
import { ACTIVE_SETUP_STATES } from "./setup-job-store.js";
import { readRunnerDeviceCode } from "./setup-login-protocol.js";

export function setupLoginDeadlines(
  startedAt: Date,
  loginTimeoutMs: number,
  launcherTimeoutMs: number,
  transport: ControlSetupJobTransport,
): { loginDeadlineAt: string; permitDeadlineAt: string } {
  const loginDeadlineAt = new Date(startedAt.getTime() + loginTimeoutMs).toISOString();
  return {
    loginDeadlineAt,
    permitDeadlineAt:
      transport === "client_pty"
        ? loginDeadlineAt
        : new Date(startedAt.getTime() + launcherTimeoutMs).toISOString(),
  };
}

export function clientPtyWaitingPatch(input: {
  job: ControlSetupJob;
  deadlineAt: string;
  startedAt: string;
  command: string;
  authorization: NonNullable<ControlSetupJob["authorization"]>;
}): Partial<ControlSetupJob> {
  return {
    state: "waiting_for_input",
    phase: "launching",
    deadlineAt: input.deadlineAt,
    startedAt: input.startedAt,
    command: input.command,
    authorization: input.authorization,
    message:
      `Ready for the Claudexor client terminal to attach and run the allowlisted ` +
      `${input.job.harness} login.`,
  };
}

export function setupTransportConflict(
  active: ControlSetupJob,
  requested: ControlSetupJobTransport,
): string | null {
  if (active.transport === requested) return null;
  return (
    `another ${active.harness} login job is active (${active.jobId}) with ` +
    `${active.transport} transport; finish or cancel it before starting ${requested}`
  );
}

export function isDeviceCodeSetupJob(job: ControlSetupJob): boolean {
  return job.authorization?.args.includes("app-server") ?? false;
}

export function awaitingSetupUserMessage(job: ControlSetupJob): string {
  return isDeviceCodeSetupJob(job)
    ? `Complete ${job.harness} sign-in: open the URL and enter the one-time code shown in Claudexor.`
    : `Complete ${job.harness} native login in Terminal.`;
}

export function projectSetupDeviceCode(
  job: ControlSetupJob,
  sidecarPath: string,
): SetupDeviceCodeDisclosure | undefined {
  if (!ACTIVE_SETUP_STATES.has(job.state) || job.phase !== "awaiting_user") return undefined;
  if (!isDeviceCodeSetupJob(job) || !job.authorization) return undefined;
  let sidecar: ReturnType<typeof readRunnerDeviceCode>;
  try {
    sidecar = readRunnerDeviceCode(sidecarPath);
  } catch {
    return undefined;
  }
  if (
    !sidecar ||
    sidecar.jobId !== job.jobId ||
    sidecar.executionId !== job.authorization.executionId
  ) {
    return undefined;
  }
  return {
    flow: sidecar.flow,
    verificationUrl: sidecar.verificationUrl,
    userCode: sidecar.userCode,
  };
}

export function removeSetupDeviceCodeSidecar(sidecarPath: string): void {
  try {
    rmSync(sidecarPath, { force: true });
  } catch {
    // Best effort: the code is invalid once the durable job is terminal.
  }
}

export interface DelegationControlRecord {
  id: string;
  runId?: string;
  state: string;
}

export interface DelegationControlDaemon {
  status(id: string): Promise<DelegationControlRecord>;
  cancel(id: string): Promise<unknown>;
  fenceDelegationParent?(runId: string): Promise<unknown>;
}

const terminal = (state: string): boolean => state !== "queued" && state !== "running";

/** Fence admission, cancel the whole family, and wait for child settlement.
 * Every cancel is attempted even after another fails; the collected failure is
 * reported only after the parent has also been signalled. */
export async function cancelDelegationFamily(input: {
  daemon: DelegationControlDaemon;
  parent: DelegationControlRecord;
  descendantsAfterFence: () => Promise<DelegationControlRecord[]>;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<{ descendants: DelegationControlRecord[] }> {
  const parentRunId = input.parent.runId ?? input.parent.id;
  const failures: string[] = [];
  let parentSignalled = false;
  try {
    if (!input.daemon.fenceDelegationParent) throw new Error("daemon does not expose a fence");
    await input.daemon.fenceDelegationParent(parentRunId);
  } catch (error) {
    const fenceFailure = `fence: ${error instanceof Error ? error.message : String(error)}`;
    // Without a confirmed fence, abort the parent BEFORE taking the child
    // snapshot. Daemon cancellation fences its live run authority atomically,
    // so no new child can enter the family between snapshot and cascade.
    try {
      await input.daemon.cancel(input.parent.id);
      parentSignalled = true;
    } catch (cancelError) {
      failures.push(fenceFailure);
      failures.push(
        `parent ${parentRunId}: ${cancelError instanceof Error ? cancelError.message : String(cancelError)}`,
      );
    }
  }
  let descendants: DelegationControlRecord[] = [];
  try {
    descendants = await input.descendantsAfterFence();
  } catch (error) {
    failures.push(`descendant snapshot: ${error instanceof Error ? error.message : String(error)}`);
  }
  const active = descendants.filter((record) => !terminal(record.state)).reverse();
  for (const child of active) {
    try {
      await input.daemon.cancel(child.id);
    } catch (error) {
      failures.push(
        `child ${child.runId ?? child.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (!parentSignalled) {
    try {
      await input.daemon.cancel(input.parent.id);
      parentSignalled = true;
    } catch (error) {
      failures.push(
        `parent ${parentRunId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const deadline = Date.now() + (input.timeoutMs ?? 10_000);
  const pollMs = input.pollMs ?? 25;
  for (const child of active) {
    for (;;) {
      try {
        const current = await input.daemon.status(child.id);
        if (terminal(current.state)) break;
      } catch (error) {
        failures.push(
          `child ${child.runId ?? child.id} status: ${error instanceof Error ? error.message : String(error)}`,
        );
        break;
      }
      if (Date.now() >= deadline) {
        failures.push(`child ${child.runId ?? child.id}: terminal drain timed out`);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
  if (failures.length > 0) {
    throw Object.assign(
      new Error(`delegation family cancellation incomplete: ${failures.join("; ")}`),
      {
        code: "delegation_cancel_incomplete",
        status: 503,
      },
    );
  }
  return { descendants: active.reverse() };
}

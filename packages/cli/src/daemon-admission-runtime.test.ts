import {
  QUOTA_POLL_INTERVAL_MS,
  type JournalManager,
  type ProjectPartitions,
} from "@claudexor/daemon";
import { describe, expect, it, vi } from "vitest";
import {
  createDaemonQuotaPoller,
  createStartupAdmissionRuntime,
} from "./daemon-admission-runtime.js";
import { DaemonStartupAdmission } from "./daemon-startup.js";

vi.mock("./daemon-lifecycle.js", () => ({
  logLine: vi.fn(),
  runStartupCrashGc: vi.fn(async () => {}),
}));

function runtimeFixture(initialBlocked: string[]) {
  const admission = new DaemonStartupAdmission();
  const messages: string[] = [];
  let liveBlocked = [...initialBlocked];
  let liveRefreshError: Error | null = null;
  const global = {
    ready: () => true,
    inspect: () => ({ status: "ready" }),
    revalidatePreparation: vi.fn(),
    activatePrepared: vi.fn(),
    recoverAfterStartup: vi.fn(),
  } as unknown as JournalManager;
  const partitions = {
    refreshPreparation: vi.fn(() => {
      if (liveRefreshError) throw liveRefreshError;
      return {
        coverage: "complete",
        fingerprint: null,
        registeredProjectIds: [],
        trustedProjectRoots: [],
        partitions: [],
        readyPartitions: [],
        recoveryRequiredPartitions: [...liveBlocked],
      };
    }),
    revalidatePreparation: vi.fn(),
    activatePrepared: vi.fn(),
    recoverAfterStartup: vi.fn(),
  } as unknown as ProjectPartitions;
  const normalPlane = {
    requested: () => false,
    armQuotaPolling: vi.fn(),
    beginPidSnapshots: vi.fn(),
    migrateAccounts: vi.fn(),
    startSetup: vi.fn(async () => {}),
    quarantineGhosts: vi.fn(),
    scheduleRetention: vi.fn(),
    armJournalMaintenance: vi.fn(),
  };
  const runtime = createStartupAdmissionRuntime({
    admission,
    grant: { advanceFloor: vi.fn() },
    global,
    partitions,
    diagnostics: {
      diagnostics: null,
      recordStage: (_stage, message) => messages.push(message),
      recordFailure: vi.fn(),
      close: vi.fn(),
    },
    normalPlane,
  });
  return {
    runtime,
    messages,
    normalPlane,
    partitions,
    setLiveBlocked: (blocked: string[]) => {
      liveBlocked = [...blocked];
    },
    setLiveRefreshError: (error: Error | null) => {
      liveRefreshError = error;
    },
  };
}

describe("startup admission recovery verdict ordering", () => {
  it("keeps a live recovery verdict authoritative over a delayed frozen startup callback", async () => {
    const first = "project:first";
    const second = "project:second";
    const fixture = runtimeFixture([first, second]);
    const quarantine = fixture.runtime.wrapQuarantineWithReopen(async () => {
      fixture.setLiveBlocked([second]);
      return { ok: true };
    });

    await quarantine(first, {});
    const frozenStartup = vi.fn(() => [first, second]);
    await fixture.runtime.runAdmissionCompletion(frozenStartup);

    const verdicts = fixture.messages.filter((message) => message.includes("recovery required:"));
    expect(verdicts.at(-1)).toContain(`recovery required: ${second})`);
    expect(verdicts.at(-1)).not.toContain(first);
    expect(frozenStartup).not.toHaveBeenCalled();
    expect(fixture.partitions.refreshPreparation).toHaveBeenCalledTimes(2);
  });

  it("retains the frozen startup verdict when the recovery service fails before mutation", async () => {
    const first = "project:first";
    const fixture = runtimeFixture([first]);
    const quarantine = fixture.runtime.wrapQuarantineWithReopen(async () => {
      throw new Error("quarantine refused");
    });

    await expect(quarantine(first, {})).rejects.toThrow("quarantine refused");
    const frozenStartup = vi.fn(() => [first]);
    await fixture.runtime.runAdmissionCompletion(frozenStartup);

    expect(frozenStartup).toHaveBeenCalledTimes(1);
    expect(fixture.partitions.refreshPreparation).not.toHaveBeenCalled();
    expect(fixture.messages.at(-1)).toContain(`recovery required: ${first})`);
  });

  it("retains the frozen startup verdict when the live recovery re-verdict fails", async () => {
    const first = "project:first";
    const fixture = runtimeFixture([first]);
    const quarantine = fixture.runtime.wrapQuarantineWithReopen(async () => {
      fixture.setLiveRefreshError(new Error("live preparation unavailable"));
      return { ok: true };
    });

    await expect(quarantine(first, {})).resolves.toEqual({ ok: true });
    const frozenStartup = vi.fn(() => [first]);
    await expect(fixture.runtime.runAdmissionCompletion(frozenStartup)).resolves.toBe(
      "recovery_only",
    );

    expect(frozenStartup).toHaveBeenCalledTimes(1);
    expect(fixture.partitions.refreshPreparation).toHaveBeenCalledTimes(1);
    expect(fixture.messages.at(-1)).toContain(`recovery required: ${first})`);
  });

  it("lets delayed startup use its frozen verdict when an overlapping live read fails", async () => {
    const first = "project:first";
    const fixture = runtimeFixture([first]);
    const quarantine = fixture.runtime.wrapQuarantineWithReopen(async () => {
      fixture.setLiveRefreshError(new Error("live preparation unavailable"));
      return { ok: true };
    });

    const recovery = quarantine(first, {});
    const frozenStartup = vi.fn(() => [first]);
    const delayedStartup = Promise.resolve().then(() =>
      fixture.runtime.runAdmissionCompletion(frozenStartup),
    );

    await expect(Promise.all([recovery, delayedStartup])).resolves.toEqual([
      { ok: true },
      "recovery_only",
    ]);
    expect(frozenStartup).toHaveBeenCalledTimes(1);
    expect(fixture.partitions.refreshPreparation).toHaveBeenCalledTimes(1);
    expect(fixture.messages.at(-1)).toContain(`recovery required: ${first})`);
  });

  it("publishes a successful live verdict before its flight can clear", async () => {
    const first = "project:first";
    const second = "project:second";
    const fixture = runtimeFixture([first, second]);
    const quarantine = fixture.runtime.wrapQuarantineWithReopen(async () => {
      fixture.setLiveBlocked([second]);
      return { ok: true };
    });

    const recovery = quarantine(first, {});
    const frozenStartup = vi.fn(() => [first, second]);
    let gate: Promise<unknown> = Promise.resolve();
    for (let step = 0; step < 4; step += 1) gate = gate.then(() => undefined);
    const delayedStartup = gate.then(() => fixture.runtime.runAdmissionCompletion(frozenStartup));

    await expect(Promise.all([recovery, delayedStartup])).resolves.toEqual([
      { ok: true },
      "recovery_only",
    ]);
    expect(frozenStartup).not.toHaveBeenCalled();
    expect(fixture.partitions.refreshPreparation).toHaveBeenCalled();
    expect(fixture.messages.at(-1)).toContain(`recovery required: ${second})`);
    expect(fixture.messages.at(-1)).not.toContain(first);
  });

  it("shares completion failures without replaying normal-plane duties", async () => {
    const fixture = runtimeFixture([]);
    fixture.normalPlane.startSetup.mockRejectedValue(new Error("setup failed"));
    const frozenStartup = vi.fn(() => []);

    const first = fixture.runtime.runAdmissionCompletion(frozenStartup);
    const second = fixture.runtime.runAdmissionCompletion(frozenStartup);

    await expect(first).rejects.toThrow("setup failed");
    await expect(second).rejects.toThrow("setup failed");
    expect(frozenStartup).toHaveBeenCalledTimes(1);
    expect(fixture.normalPlane.startSetup).toHaveBeenCalledTimes(1);
  });
});

describe("daemon quota poll cadence", () => {
  it("uses the shared interval, starts immediately, and owns only one timer", async () => {
    vi.useFakeTimers();
    try {
      const poll = vi.fn();
      const poller = createDaemonQuotaPoller(poll);

      poller.arm();
      poller.arm();
      expect(poll).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(QUOTA_POLL_INTERVAL_MS);
      expect(poll).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(1);

      poller.stop();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

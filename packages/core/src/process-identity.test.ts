import { describe, expect, it } from "vitest";
import {
  ProcessIdentityService,
  compareProcessIdentity,
  observeProcess,
  parseDarwinHelperOutput,
  parseLinuxProcStat,
  parseLinuxProcStatObservation,
  type KnownProcessIdentity,
  type LinuxProcessState,
  type ProcessIdentity,
  type ProcessIdentityReader,
  type ProcessObservationReader,
} from "./process-identity.js";
import { ProcessGroupService, parseProcessGroupHandle } from "./process-group.js";

function linuxStat(
  pid: number,
  pgid: number,
  startTicks: string,
  comm = "worker ) with spaces",
  state: LinuxProcessState | string = "S",
): string {
  // fieldsFromState[0]=state, [2]=pgrp/field5, [19]=starttime/field22.
  const fields4Through21 = Array.from({ length: 18 }, (_, index) => String(index + 1));
  fields4Through21[1] = String(pgid);
  return `${pid} (${comm}) ${state} ${fields4Through21.join(" ")} ${startTicks} 0 0 0\n`;
}

function knownLinux(pid: number, pgid: number, startToken: string): KnownProcessIdentity {
  return {
    status: "known",
    pid,
    platform: "linux",
    source: "procfs_stat",
    startToken,
    processGroupId: pgid,
  };
}

describe("locale-independent process identity", () => {
  it("parses exact Linux PGID/start ticks identically for C, English and Russian contexts", () => {
    const raw = linuxStat(4312, 4312, "987654321");
    const identities = ["C", "en_US.UTF-8", "ru_RU.UTF-8"].map(() => parseLinuxProcStat(raw, 4312));
    expect(identities).toEqual(Array(3).fill(knownLinux(4312, 4312, "linux:987654321")));
  });

  it("handles spaces/right parentheses in comm and refuses malformed or mismatched fields", () => {
    expect(parseLinuxProcStat(linuxStat(77, 77, "0", "name ) ) spaces"), 77)).toEqual(
      knownLinux(77, 77, "linux:0"),
    );
    expect(parseLinuxProcStat(linuxStat(41, 41, "123"), 42)).toMatchObject({ status: "unknown" });
    expect(parseLinuxProcStat(linuxStat(42, 42, "12.3"), 42)).toMatchObject({ status: "unknown" });
    expect(parseLinuxProcStatObservation(linuxStat(42, 42, "123", "worker", "?"), 42)).toEqual({
      identity: expect.objectContaining({ status: "unknown", reason: "malformed_response" }),
      linuxState: null,
    });
  });

  it("keeps mutable Linux state separate from byte-compatible birth identity", () => {
    const sleeping = linuxStat(77, 77, "101", "worker", "S");
    const zombie = linuxStat(77, 77, "101", "worker", "Z");
    const sleepingObservation = parseLinuxProcStatObservation(sleeping, 77);
    const zombieObservation = parseLinuxProcStatObservation(zombie, 77);

    expect(sleepingObservation.identity).toEqual(zombieObservation.identity);
    expect(parseLinuxProcStat(sleeping, 77)).toEqual(parseLinuxProcStat(zombie, 77));
    expect(sleepingObservation.linuxState).toBe("S");
    expect(zombieObservation.linuxState).toBe("Z");
    if (sleepingObservation.identity.status !== "known") throw new Error("expected known identity");
    expect(compareProcessIdentity(sleepingObservation.identity, zombieObservation.identity)).toBe(
      "same",
    );
  });

  it("reads identity and Linux state atomically while caching self identity only", () => {
    let reads = 0;
    let state: LinuxProcessState = "S";
    const service = new ProcessIdentityService({
      platform: "linux",
      selfPid: 55,
      readTextFile: () => {
        reads += 1;
        return linuxStat(55, 55, "900", "self", state);
      },
    });

    expect(service.observe(55)).toMatchObject({ linuxState: "S", identity: { status: "known" } });
    expect(reads).toBe(1);
    expect(service.self()).toMatchObject({ status: "known", startToken: "linux:900" });
    expect(reads).toBe(2);
    state = "Z";
    expect(service.self()).toMatchObject({ status: "known", startToken: "linux:900" });
    expect(reads).toBe(2);
    expect(service.observe(55).linuxState).toBe("Z");
    expect(reads).toBe(3);
  });

  it("uses only an explicitly supplied observation capability", () => {
    const identity = knownLinux(55, 55, "linux:1");
    let reads = 0;
    let collidingObserveCalls = 0;
    class LegacyReaderWithUnrelatedObserve implements ProcessIdentityReader {
      constructor() {
        void this.observe;
      }

      private observe(_pid: number): void {
        collidingObserveCalls += 1;
      }

      read(): ProcessIdentity {
        reads += 1;
        return identity;
      }

      self(): ProcessIdentity {
        return identity;
      }
    }
    const legacyReader = new LegacyReaderWithUnrelatedObserve();
    expect(observeProcess(legacyReader, 55)).toEqual({ identity, linuxState: null });
    expect(reads).toBe(1);
    expect(collidingObserveCalls).toBe(0);

    let observations = 0;
    const observationReader: ProcessObservationReader = {
      observe: () => ({ identity, linuxState: "Z" as const }),
    };
    observationReader.observe = () => {
      observations += 1;
      return { identity, linuxState: "Z" };
    };
    expect(observeProcess(legacyReader, 55, observationReader).linuxState).toBe("Z");
    expect(reads).toBe(1);
    expect(observations).toBe(1);
  });

  it("strictly parses Darwin PID/PGID/start and rejects localized prose", () => {
    expect(
      parseDarwinHelperOutput("claudexor-process-identity-v2\t123\t123\t1777777777\t000042\n", 123),
    ).toEqual({
      status: "known",
      pid: 123,
      platform: "darwin",
      source: "proc_pidinfo",
      startToken: "darwin:1777777777:000042",
      processGroupId: 123,
    });
    expect(parseDarwinHelperOutput("Mon Jul 14 10:00:00 2026\n", 123)).toMatchObject({
      status: "unknown",
      reason: "malformed_response",
    });
  });

  it("preserves missing/unknown and compares exact identity including PGID", () => {
    const expected = knownLinux(90, 90, "linux:100");
    expect(compareProcessIdentity(expected, expected)).toBe("same");
    expect(compareProcessIdentity(expected, knownLinux(90, 91, "linux:100"))).toBe("different");
    const missing = new ProcessIdentityService({
      platform: "linux",
      readTextFile: () => {
        throw Object.assign(new Error("gone"), { code: "ENOENT" });
      },
    });
    expect(missing.read(90).status).toBe("missing");

    const denied = new ProcessIdentityService({
      platform: "linux",
      readTextFile: () => {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      },
    });
    expect(denied.observe(90)).toEqual({
      identity: {
        status: "unknown",
        pid: 90,
        platform: "linux",
        reason: "permission_denied",
      },
      linuxState: null,
    });

    const unsupported = new ProcessIdentityService({ platform: "win32" });
    expect(unsupported.observe(90)).toEqual({
      identity: {
        status: "unknown",
        pid: 90,
        platform: "win32",
        reason: "unsupported_platform",
      },
      linuxState: null,
    });
  });

  it("keeps Darwin identity observation state-free", () => {
    const service = new ProcessIdentityService({
      platform: "darwin",
      darwinHelperPath: "/private/helper",
      runDarwinHelper: () => ({
        status: 0,
        stdout: "claudexor-process-identity-v2\t123\t123\t1777777777\t000042\n",
        stderr: "",
      }),
    });
    expect(service.observe(123)).toEqual({
      identity: {
        status: "known",
        pid: 123,
        platform: "darwin",
        source: "proc_pidinfo",
        startToken: "darwin:1777777777:000042",
        processGroupId: 123,
      },
      linuxState: null,
    });
  });
});

describe("process group handles", () => {
  it("brands only an exact known group leader and round-trips strict persisted JSON", () => {
    const identity = {
      read: () => knownLinux(55, 55, "linux:1"),
      self: () => knownLinux(1, 1, "linux:0"),
    };
    const service = new ProcessGroupService({ platform: "linux", identity });
    const captured = service.captureLeader(55);
    expect(captured.status).toBe("known");
    if (captured.status !== "known") throw new Error("expected known group");
    expect(parseProcessGroupHandle(JSON.parse(JSON.stringify(captured.handle)))).toMatchObject({
      pgid: 55,
    });
    expect(JSON.stringify(captured.handle)).not.toContain("linuxState");

    const memberIdentity = { ...identity, read: () => knownLinux(55, 44, "linux:1") };
    expect(
      new ProcessGroupService({ platform: "linux", identity: memberIdentity }).captureLeader(55),
    ).toMatchObject({
      status: "unknown",
      reason: "not_process_group_leader",
    });
  });

  it("treats only ESRCH as proof that every process in the group is gone", () => {
    const identity = {
      read: () => knownLinux(55, 55, "linux:1"),
      self: () => knownLinux(1, 1, "linux:0"),
    };
    const captured = new ProcessGroupService({ platform: "linux", identity }).captureLeader(55);
    if (captured.status !== "known") throw new Error("expected known group");
    const empty = new ProcessGroupService({
      platform: "linux",
      identity,
      probeProcessGroup: () => {
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      },
    });
    const denied = new ProcessGroupService({
      platform: "linux",
      identity,
      probeProcessGroup: () => {
        throw Object.assign(new Error("denied"), { code: "EPERM" });
      },
    });
    expect(empty.probeEmpty(captured.handle).status).toBe("empty");
    expect(denied.probeEmpty(captured.handle)).toMatchObject({
      status: "unknown",
      reason: "permission_denied",
    });
  });
});

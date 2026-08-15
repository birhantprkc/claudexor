import { describe, expect, it } from "vitest";
import {
  descendantProcessGroupIds,
  killWindowsProcessTree,
  processGroupServiceWithWindowsSupport,
  readProcessTable,
  reapProcessTree,
  resolveKillTreeStrategy,
  WINDOWS_TREE_DEATH_PROOF_UNAVAILABLE,
  type ProcessTreeNode,
  type ProcessTreeReader,
} from "./process-tree.js";
import { ProcessGroupService } from "./process-group.js";
import type {
  KnownProcessIdentity,
  ProcessIdentity,
  ProcessIdentityReader,
} from "./process-identity.js";

/**
 * Deterministic fake kernel: a set of live pgids (each led by pid==pgid), a
 * controllable clock, recorded signals, and a scriptable process-tree snapshot.
 * SIGKILL removes a group from the live set so the death proof can converge
 * without any wall-clock waiting.
 */
function fakeWorld(opts: {
  alive: number[];
  /** Snapshot returned each time the tree is read (defaults to alive leaders). */
  snapshots?: ProcessTreeNode[][];
  /** pgids that ignore SIGKILL (stay alive forever) — for the unconfirmed case. */
  immortal?: number[];
  /** When true, a cooperative SIGTERM also kills (models a child that obeys it). */
  coopLethal?: boolean;
}) {
  const alive = new Set(opts.alive);
  const immortal = new Set(opts.immortal ?? []);
  const coopLethal = opts.coopLethal ?? false;
  const signals: Array<{ pgid: number; signal: string }> = [];
  let t = 0;
  const snapshots = opts.snapshots ? [...opts.snapshots] : null;

  const identity: ProcessIdentityReader = {
    read(pid: number): ProcessIdentity {
      if (alive.has(pid)) {
        return {
          status: "known",
          pid,
          platform: "linux",
          source: "procfs_stat",
          startToken: `linux:${pid}`,
          processGroupId: pid,
        };
      }
      return { status: "missing", pid, platform: "linux" };
    },
    self(): ProcessIdentity {
      return { status: "missing", pid: 1, platform: "linux" };
    },
  };

  const groups = new ProcessGroupService({
    platform: "linux",
    identity,
    probeProcessGroup: (negPgid: number) => {
      const pgid = -negPgid;
      if (!alive.has(pgid)) {
        throw Object.assign(new Error("no such group"), { code: "ESRCH" });
      }
    },
    signalProcessGroup: (negPgid: number, signal: NodeJS.Signals) => {
      const pgid = -negPgid;
      signals.push({ pgid, signal });
      const lethal = signal === "SIGKILL" || (coopLethal && signal === "SIGTERM");
      if (lethal && !immortal.has(pgid)) alive.delete(pgid);
    },
  });

  const defaultSnapshot = (): ProcessTreeNode[] =>
    [...alive].map((pid) => ({ pid, ppid: pid === 1 ? 0 : 1, pgid: pid }));

  const tree: ProcessTreeReader = {
    snapshot: () => (snapshots && snapshots.length > 0 ? snapshots.shift()! : defaultSnapshot()),
  };

  return {
    groups,
    tree,
    signals,
    isAlive: (pgid: number) => alive.has(pgid),
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

describe("descendantProcessGroupIds", () => {
  it("collects the escaped grandchild pgid even when it left the parent group", () => {
    // root 100 (pgid 100) -> cli 200 (pgid 100) -> tool 300 which setsid'd into
    // its own pgid 300.
    const nodes: ProcessTreeNode[] = [
      { pid: 100, ppid: 1, pgid: 100 },
      { pid: 200, ppid: 100, pgid: 100 },
      { pid: 300, ppid: 200, pgid: 300 },
      { pid: 999, ppid: 1, pgid: 999 }, // unrelated
    ];
    expect(descendantProcessGroupIds(100, nodes).sort((a, b) => a - b)).toEqual([100, 300]);
  });

  it("returns an empty list when the root is already gone", () => {
    expect(descendantProcessGroupIds(100, [{ pid: 999, ppid: 1, pgid: 999 }])).toEqual([]);
  });
});

describe("readProcessTable", () => {
  it("parses pid/ppid/pgid triples and skips malformed lines", () => {
    const nodes = readProcessTable(() => ({
      status: 0,
      stdout: "  100   1   100\n 200 100 100\nbad line\n 300 200 300\n",
    }));
    expect(nodes).toEqual([
      { pid: 100, ppid: 1, pgid: 100 },
      { pid: 200, ppid: 100, pgid: 100 },
      { pid: 300, ppid: 200, pgid: 300 },
    ]);
  });

  it("fails closed to [] on a non-zero ps exit", () => {
    expect(readProcessTable(() => ({ status: 1, stdout: "" }))).toEqual([]);
  });
});

describe("reapProcessTree", () => {
  it("confirms death after the direct group exits on the cooperative signal", async () => {
    const world = fakeWorld({ alive: [100], coopLethal: true });
    const outcome = await reapProcessTree({
      rootPid: 100,
      groups: world.groups,
      tree: world.tree,
      now: world.now,
      sleep: world.sleep,
      graceMs: 1_000,
      cooperativeSignal: "SIGTERM",
      probeIntervalMs: 50,
    });
    expect(outcome.state).toBe("confirmed");
    expect(world.isAlive(100)).toBe(false);
    // Never escalated: the cooperative signal was enough.
    expect(world.signals.every((s) => s.signal === "SIGTERM")).toBe(true);
  });

  it("KILLS an ESCAPED descendant group, not only the direct group", async () => {
    // Direct group 100 plus a tool that escaped into pgid 300. A group-kill of
    // 100 alone would leak 300 — the QA-027 orphan. The tree snapshot exposes
    // both; both must be signalled and proven dead.
    const world = fakeWorld({
      alive: [100, 300],
      snapshots: [
        // captured while the chain is intact
        [
          { pid: 100, ppid: 1, pgid: 100 },
          { pid: 200, ppid: 100, pgid: 100 },
          { pid: 300, ppid: 200, pgid: 300 },
        ],
      ],
    });
    const outcome = await reapProcessTree({
      rootPid: 100,
      groups: world.groups,
      tree: world.tree,
      now: world.now,
      sleep: world.sleep,
      graceMs: 100,
      cooperativeSignal: "SIGTERM",
      probeIntervalMs: 50,
    });
    expect(outcome.state).toBe("confirmed");
    expect(world.isAlive(100)).toBe(false);
    expect(world.isAlive(300)).toBe(false);
    const killed = world.signals.filter((s) => s.signal === "SIGKILL").map((s) => s.pgid);
    expect(killed).toContain(100);
    expect(killed).toContain(300); // the escaped group got the hard signal
  });

  it("sends the cooperative signal first and escalates to SIGKILL only after grace", async () => {
    const world = fakeWorld({ alive: [100] });
    await reapProcessTree({
      rootPid: 100,
      groups: world.groups,
      tree: world.tree,
      now: world.now,
      sleep: world.sleep,
      graceMs: 200,
      cooperativeSignal: "SIGTERM",
      probeIntervalMs: 50,
    });
    // First signal is cooperative; SIGKILL appears only once the clock passed grace.
    expect(world.signals[0]).toEqual({ pgid: 100, signal: "SIGTERM" });
    expect(world.signals.some((s) => s.signal === "SIGKILL")).toBe(true);
  });

  it("captures a descendant group that forks AFTER the first signal (fixed point)", async () => {
    // First snapshot has only the direct group; a later snapshot reveals a
    // freshly forked escaped group 400 (alive in the kernel from the start but
    // not yet visible in the tree). The fixed-point re-scan must catch it.
    const world = fakeWorld({
      alive: [100, 400],
      snapshots: [
        [{ pid: 100, ppid: 1, pgid: 100 }],
        [{ pid: 100, ppid: 1, pgid: 100 }],
        [
          { pid: 100, ppid: 1, pgid: 100 },
          { pid: 400, ppid: 100, pgid: 400 },
        ],
      ],
    });
    const outcome = await reapProcessTree({
      rootPid: 100,
      groups: world.groups,
      tree: world.tree,
      now: world.now,
      sleep: world.sleep,
      graceMs: 50,
      cooperativeSignal: "SIGTERM",
      probeIntervalMs: 25,
    });
    expect(outcome.state).toBe("confirmed");
    expect(world.isAlive(400)).toBe(false);
    expect(world.signals.filter((s) => s.signal === "SIGKILL").map((s) => s.pgid)).toContain(400);
  });

  it("reports UNCONFIRMED with survivors when a group survives the bounded escalation", async () => {
    const world = fakeWorld({
      alive: [100, 300],
      immortal: [300],
      snapshots: [
        [
          { pid: 100, ppid: 1, pgid: 100 },
          { pid: 200, ppid: 100, pgid: 100 },
          { pid: 300, ppid: 200, pgid: 300 },
        ],
      ],
    });
    const outcome = await reapProcessTree({
      rootPid: 100,
      groups: world.groups,
      tree: world.tree,
      now: world.now,
      sleep: world.sleep,
      graceMs: 100,
      deadlineMs: 500,
      cooperativeSignal: "SIGTERM",
      probeIntervalMs: 50,
    });
    expect(outcome.state).toBe("unconfirmed");
    if (outcome.state === "unconfirmed") {
      expect(outcome.survivors).toContain(300);
      expect(outcome.survivors).not.toContain(100); // the killable group did die
    }
  });

  // Round-2 #3: the group LEADER exited between the ps snapshot and captureLeader
  // (status='missing'), but a non-leader member is still alive under that pgid.
  // The old code dropped the pgid entirely -> reapProcessTree returned
  // `confirmed` while the group survived. A raw signal-0 probe must keep it
  // `unresolved` until it is proven gone.
  it("keeps a leaderless-but-alive group unresolved instead of falsely confirming (round-2 #3)", async () => {
    // The escaped group 300's leader (pid 300) is NOT alive, but member 200 is
    // still running under pgid 300. Only the direct group 100 has a live leader.
    const world = fakeWorld({
      alive: [100],
      coopLethal: true, // group 100 dies on the cooperative signal
      snapshots: [
        [
          { pid: 100, ppid: 1, pgid: 100 },
          { pid: 200, ppid: 100, pgid: 300 }, // member of pgid 300; leader 300 gone
        ],
      ],
    });
    const liveGroups = new Set([300]); // raw probe still sees 300 alive
    const outcome = await reapProcessTree({
      rootPid: 100,
      groups: world.groups,
      tree: world.tree,
      now: world.now,
      sleep: world.sleep,
      graceMs: 10,
      deadlineMs: 40,
      probeIntervalMs: 5,
      probeGroupAlive: (pgid) => liveGroups.has(pgid),
    });
    expect(outcome.state).toBe("unconfirmed");
    if (outcome.state === "unconfirmed") {
      expect(outcome.survivors).toEqual([]); // 100 died; 300 was never signalled
      expect(outcome.unresolved.map((u) => u.pgid)).toContain(300);
      expect(outcome.unresolved.find((u) => u.pgid === 300)?.reason).toBe(
        "leader_exited_group_alive",
      );
    }
  });

  // Round-4 #2: the fixed-point rescan discovers descendants from the numeric
  // rootPid. If the root exits and its PID is REUSED mid-deadline, a later
  // snapshot shows an UNRELATED process tree under the same pid — the rescan must
  // NOT enroll and signal that impostor's descendant groups. A root-identity
  // binding stops new discovery the instant the root's identity differs.
  const ORIG_ROOT: KnownProcessIdentity = {
    status: "known",
    pid: 100,
    platform: "linux",
    source: "procfs_stat",
    startToken: "linux:orig-100",
    processGroupId: 100,
  };
  // Root re-verify reader (used ONLY by reapProcessTree's root check, distinct
  // from the group service's identity): the first observation is the original
  // root; every subsequent observation is a different process that reused pid 100.
  function reusingRootChecker(): ProcessIdentityReader {
    let reads = 0;
    return {
      read(pid: number): ProcessIdentity {
        if (pid !== 100) return { status: "missing", pid, platform: "linux" };
        reads += 1;
        return {
          status: "known",
          pid: 100,
          platform: "linux",
          source: "procfs_stat",
          startToken: reads <= 1 ? "linux:orig-100" : "linux:impostor-100",
          processGroupId: 100,
        };
      },
      self: () => ({ status: "missing", pid: 1, platform: "linux" }),
    };
  }

  it("stops discovering descendants once the root PID is reused mid-deadline (root-identity bound)", async () => {
    // Intact tree first (root 100 + escaped descendant 300); a later snapshot is
    // the impostor's tree (100 -> 500). 500 must NEVER be signalled.
    const world = fakeWorld({
      alive: [100, 300, 500],
      snapshots: [
        [
          { pid: 100, ppid: 1, pgid: 100 },
          { pid: 200, ppid: 100, pgid: 100 },
          { pid: 300, ppid: 200, pgid: 300 },
        ],
        [
          { pid: 100, ppid: 1, pgid: 100 },
          { pid: 500, ppid: 100, pgid: 500 },
        ],
        [
          { pid: 100, ppid: 1, pgid: 100 },
          { pid: 500, ppid: 100, pgid: 500 },
        ],
      ],
    });
    const outcome = await reapProcessTree({
      rootPid: 100,
      rootIdentity: ORIG_ROOT,
      identity: reusingRootChecker(),
      groups: world.groups,
      tree: world.tree,
      now: world.now,
      sleep: world.sleep,
      graceMs: 100,
      cooperativeSignal: "SIGTERM",
      probeIntervalMs: 50,
    });
    expect(outcome.state).toBe("confirmed");
    // The originally-valid tree was reaped to death...
    expect(world.isAlive(100)).toBe(false);
    expect(world.isAlive(300)).toBe(false);
    // ...but the impostor's descendant was never enrolled or signalled.
    expect(world.signals.some((s) => s.pgid === 500)).toBe(false);
    expect(world.isAlive(500)).toBe(true);
  });

  it("WITHOUT a root identity, the same reuse fixture leaks a signal to the impostor tree", async () => {
    // Control: the identical fixture, minus rootIdentity, DOES discover and
    // signal the reused pid's descendant 500 — proving the guard above is what
    // prevents it (not the fixture merely never reaching the impostor snapshot).
    const world = fakeWorld({
      alive: [100, 300, 500],
      snapshots: [
        [
          { pid: 100, ppid: 1, pgid: 100 },
          { pid: 300, ppid: 100, pgid: 300 },
        ],
        [
          { pid: 100, ppid: 1, pgid: 100 },
          { pid: 500, ppid: 100, pgid: 500 },
        ],
        [
          { pid: 100, ppid: 1, pgid: 100 },
          { pid: 500, ppid: 100, pgid: 500 },
        ],
      ],
    });
    await reapProcessTree({
      rootPid: 100,
      groups: world.groups,
      tree: world.tree,
      now: world.now,
      sleep: world.sleep,
      graceMs: 100,
      cooperativeSignal: "SIGTERM",
      probeIntervalMs: 50,
    });
    expect(world.signals.some((s) => s.pgid === 500)).toBe(true);
  });
});

describe("resolveKillTreeStrategy", () => {
  it("dispatches win32 to taskkill and every POSIX platform to process groups", () => {
    expect(resolveKillTreeStrategy("win32")).toBe("windows_taskkill");
    expect(resolveKillTreeStrategy("linux")).toBe("posix_process_group");
    expect(resolveKillTreeStrategy("darwin")).toBe("posix_process_group");
    // An unknown platform keeps the POSIX default (no outcome special-casing).
    expect(resolveKillTreeStrategy("freebsd")).toBe("posix_process_group");
  });
});

describe("killWindowsProcessTree", () => {
  const run =
    (status: number | null, stderr = "") =>
    (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return { status, stdout: "", stderr };
    };
  let calls: Array<{ cmd: string; args: string[] }> = [];

  it("invokes taskkill /PID <pid> /T /F from System32 and reports killed on exit 0", () => {
    calls = [];
    const result = killWindowsProcessTree(4242, run(0));
    expect(result).toEqual({ status: "killed", pid: 4242 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd.toLowerCase()).toContain("system32");
    expect(calls[0]?.cmd.toLowerCase()).toContain("taskkill.exe");
    expect(calls[0]?.args).toEqual(["/PID", "4242", "/T", "/F"]);
  });

  it("maps exit 128 to not_found (the process was already gone)", () => {
    calls = [];
    expect(killWindowsProcessTree(4242, run(128))).toEqual({ status: "not_found", pid: 4242 });
  });

  it("reports failed with detail on any other exit and on a thrown spawn", () => {
    calls = [];
    const failed = killWindowsProcessTree(4242, run(1, "Access is denied."));
    expect(failed.status).toBe("failed");
    expect(failed.status === "failed" && failed.detail).toContain("Access is denied.");
    const thrown = killWindowsProcessTree(4242, () => {
      throw new Error("spawn blew up");
    });
    expect(thrown.status).toBe("failed");
  });

  it("refuses an invalid pid without ever spawning", () => {
    calls = [];
    expect(killWindowsProcessTree(0, run(0)).status).toBe("failed");
    expect(killWindowsProcessTree(-5, run(0)).status).toBe("failed");
    expect(calls).toHaveLength(0);
  });
});

describe("reapProcessTree on win32 (taskkill leg)", () => {
  /** Poisoned POSIX machinery: the win32 leg must never touch ps or pgids. */
  const poisonedTree: ProcessTreeReader = {
    snapshot: () => {
      throw new Error("the win32 reap must not read the POSIX process table");
    },
  };

  function windowsWorld(opts: { probesUntilDead: number | "never"; killStatus?: number }) {
    let t = 0;
    let probes = 0;
    const kills: number[] = [];
    return {
      kills,
      now: () => t,
      sleep: (ms: number) => {
        t += ms;
        return Promise.resolve();
      },
      probePidAlive: (_pid: number) => {
        probes += 1;
        if (opts.probesUntilDead === "never") return true;
        return probes <= opts.probesUntilDead;
      },
      windowsKillTree: (pid: number) => {
        kills.push(pid);
        const status = opts.killStatus ?? 0;
        if (status === 0) return { status: "killed" as const, pid };
        return { status: "failed" as const, pid, detail: `taskkill exited ${status}` };
      },
    };
  }

  it("kills the tree once and settles as the typed no-death-proof disclosure, never confirmed", async () => {
    const world = windowsWorld({ probesUntilDead: 2 });
    const outcome = await reapProcessTree({
      rootPid: 4242,
      platform: "win32",
      tree: poisonedTree,
      ...world,
    });
    expect(world.kills).toEqual([4242]);
    // D21: the absent mechanism (no group ESRCH probe on Windows) is a typed
    // disclosure on the outcome — the reap must NOT overclaim `confirmed`.
    expect(outcome).toEqual({
      state: "unconfirmed",
      survivors: [],
      unresolved: [{ pgid: 4242, reason: WINDOWS_TREE_DEATH_PROOF_UNAVAILABLE }],
    });
  });

  it("reports the root as a SURVIVOR when it outlives the bounded deadline", async () => {
    const world = windowsWorld({ probesUntilDead: "never" });
    const outcome = await reapProcessTree({
      rootPid: 4242,
      platform: "win32",
      tree: poisonedTree,
      graceMs: 100,
      deadlineMs: 500,
      probeIntervalMs: 50,
      ...world,
    });
    expect(outcome).toEqual({ state: "unconfirmed", survivors: [4242], unresolved: [] });
  });

  it("reports the root as a survivor immediately when taskkill itself failed", async () => {
    const world = windowsWorld({ probesUntilDead: "never", killStatus: 1 });
    const outcome = await reapProcessTree({
      rootPid: 4242,
      platform: "win32",
      tree: poisonedTree,
      ...world,
    });
    expect(outcome).toEqual({ state: "unconfirmed", survivors: [4242], unresolved: [] });
  });

  it("never issues a kill for a root that already probes dead (PID-reuse guard)", async () => {
    const world = windowsWorld({ probesUntilDead: 0 });
    const outcome = await reapProcessTree({
      rootPid: 4242,
      platform: "win32",
      tree: poisonedTree,
      ...world,
    });
    expect(world.kills).toEqual([]);
    expect(outcome.state).toBe("unconfirmed");
  });

  it("POSIX platforms never dispatch to the taskkill leg", async () => {
    let windowsKills = 0;
    const emptyTree: ProcessTreeReader = { snapshot: () => [] };
    const outcome = await reapProcessTree({
      rootPid: 4242,
      platform: "linux",
      tree: emptyTree,
      windowsKillTree: (pid: number) => {
        windowsKills += 1;
        return { status: "killed", pid };
      },
      probeGroupAlive: () => false,
    });
    expect(windowsKills).toBe(0);
    expect(outcome.state).toBe("confirmed");
  });
});

describe("processGroupServiceWithWindowsSupport", () => {
  it("is the ordinary process-group service off win32", () => {
    const platform = process.platform;
    expect(processGroupServiceWithWindowsSupport(platform).captureLeader(process.pid)).toEqual(
      new ProcessGroupService({ platform }).captureLeader(process.pid),
    );
  });

  it("refuses to capture a win32 leader when the birth-time reader is unavailable", () => {
    // The production win32 service reads through PowerShell; on this host the
    // reader cannot run, so identity stays unprovable and nothing is signalled.
    const service = processGroupServiceWithWindowsSupport("win32");
    expect(service.captureLeader(process.pid).status).toBe("unknown");
  });
});

import { describe, expect, it } from "vitest";
import { type DaemonWriterLeaseStatus } from "@claudexor/daemon";
import { stopDaemonForOperator } from "./ops-commands.js";

const IDENTITY = {
  status: "known",
  pid: 7331,
  platform: "linux",
  source: "procfs_stat",
  startToken: "linux:7331",
  processGroupId: 7331,
} as const;
const OWNER = { pid: IDENTITY.pid, token: "operator-stop-owner", identity: IDENTITY };
const OBSERVATION = {
  identity: IDENTITY,
  linuxState: "S",
} as const;
const CAPABLE_LEASE = {
  status: "owned",
  path: "/tmp/claudexord.sock.writer",
  owner: OWNER,
  capability: {
    status: "capable",
    reason: "identity_match",
    observation: OBSERVATION,
  },
} satisfies DaemonWriterLeaseStatus;

describe("ordinary daemon stop writer-owner pin", () => {
  it("captures one strict capable owner before shutdown and passes that exact owner to the waiter", async () => {
    const events: string[] = [];
    await expect(
      stopDaemonForOperator("/tmp/claudexord.sock", {
        inspectLease: (path) => {
          expect(path).toBe("/tmp/claudexord.sock");
          events.push("inspect");
          return CAPABLE_LEASE;
        },
        shutdown: async () => {
          events.push("shutdown");
        },
        awaitTermination: async (path, options) => {
          events.push("wait");
          expect(path).toBe("/tmp/claudexord.sock");
          if (!options) throw new Error("expected termination options");
          expect(options).toEqual({
            allowSigkill: true,
            expectedOwner: OWNER,
            requireNoSuccessor: false,
          });
          expect(options.expectedOwner).toBe(OWNER);
          return { outcome: "exited", detail: "pinned owner exited" };
        },
      }),
    ).resolves.toEqual({ outcome: "exited", detail: "pinned owner exited" });
    expect(events).toEqual(["inspect", "shutdown", "wait"]);
  });

  it.each([
    ["physical absence", { status: "absent", path: "/tmp/claudexord.sock.writer" }],
    [
      "malformed authority",
      {
        status: "unknown",
        path: "/tmp/claudexord.sock.writer",
        reason: "owner_malformed",
      },
    ],
    [
      "unknown owner capability",
      {
        ...CAPABLE_LEASE,
        capability: {
          status: "unknown",
          reason: "identity_unavailable",
          observation: {
            identity: {
              status: "unknown",
              pid: OWNER.pid,
              platform: "linux",
              reason: "permission_denied",
            },
            linuxState: null,
          },
        },
      },
    ],
    [
      "proven-stale owner",
      {
        ...CAPABLE_LEASE,
        capability: {
          status: "proven_stale",
          reason: "process_missing",
          observation: {
            identity: { status: "missing", pid: OWNER.pid, platform: "linux" },
            linuxState: null,
          },
        },
      },
    ],
  ] satisfies readonly (readonly [string, DaemonWriterLeaseStatus])[])(
    "keeps %s passive and never grants SIGKILL authority",
    async (_label, lease) => {
      let shutdowns = 0;
      await stopDaemonForOperator("/tmp/claudexord.sock", {
        inspectLease: () => lease,
        shutdown: async () => {
          shutdowns += 1;
        },
        awaitTermination: async (_path, options) => {
          if (!options) throw new Error("expected termination options");
          expect(options).toEqual({ allowSigkill: false, requireNoSuccessor: false });
          expect(options.expectedOwner).toBeUndefined();
          return { outcome: "still_alive", detail: "passive confirmation only" };
        },
      });
      expect(shutdowns).toBe(1);
    },
  );
});

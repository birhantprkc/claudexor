import type { DaemonServer } from "@claudexor/daemon";
import { DelegationBudgetAuthority } from "@claudexor/orchestrator";

/** Break the composition-root callback cycle without weakening cancellation ownership. */
export function createDelegationDaemonBinding(): {
  authority: DelegationBudgetAuthority;
  bind(server: Pick<DaemonServer, "cancelJob">): void;
} {
  let server: Pick<DaemonServer, "cancelJob"> | null = null;
  return {
    authority: new DelegationBudgetAuthority({
      cancelAdmission: (jobId) => {
        if (!server) throw new Error("daemon cancellation authority is not initialized");
        server.cancelJob(jobId);
      },
    }),
    bind(value) {
      server = value;
    },
  };
}

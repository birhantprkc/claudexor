import type { CliCommandSpec } from "./command-registry.js";

export const RETRY_COMMAND_SPECS: readonly CliCommandSpec[] = [
  {
    id: "retry",
    positionalPatterns: [{ min: 1, max: 1 }],
    usageArgs: "<run_id>",
    summary: "Exact Retry with the immutable original request and fresh preflight",
    flags: ["json"],
    mutability: "write",
    stability: "stable",
    recovery: true,
  },
  {
    id: "run-again",
    positionalPatterns: [{ min: 1, max: 1 }],
    usageArgs: "<run_id>",
    summary: "Print an editable draft copied from a prior run",
    flags: ["json"],
    mutability: "read",
    stability: "stable",
    recovery: true,
  },
];

import type { CliCommandSpec } from "./command-registry.js";

export const REMOTE_COMMAND_SPECS = [
  {
    id: "remote",
    positionalPatterns: [
      // The handler's long-standing default action: `remote --json` is probe.
      { min: 0, max: 0 },
      { prefix: ["probe"], min: 1, max: 1 },
      { prefix: ["bootstrap"], min: 1, max: 1 },
      { prefix: ["stop"], min: 3, max: 3 },
      { prefix: ["activate"], min: 3, max: 3 },
      { prefix: ["rollback"], min: 3, max: 3 },
    ],
    usageArgs: "probe|bootstrap --json",
    summary: "Internal SSH runtime bootstrap interface",
    flags: ["json"],
    mutability: "ops",
    stability: "experimental",
  },
  {
    id: "setup",
    positionalPatterns: [{ prefix: ["attach"], min: 2, max: 2 }],
    usageArgs: "attach <jobId>",
    summary: "Attach this PTY to a daemon-prepared setup login",
    flags: [],
    mutability: "ops",
    stability: "experimental",
  },
] as const satisfies readonly CliCommandSpec[];

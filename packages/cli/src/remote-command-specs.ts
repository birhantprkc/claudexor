import type { CliCommandSpec } from "./command-registry.js";

export const REMOTE_COMMAND_SPECS = [
  {
    id: "remote",
    usageArgs: "probe|bootstrap --json",
    summary: "Internal SSH runtime bootstrap interface",
    flags: ["json"],
    mutability: "ops",
    stability: "experimental",
  },
  {
    id: "setup",
    usageArgs: "attach <jobId>",
    summary: "Attach this PTY to a daemon-prepared setup login",
    flags: [],
    mutability: "ops",
    stability: "experimental",
  },
] as const satisfies readonly CliCommandSpec[];

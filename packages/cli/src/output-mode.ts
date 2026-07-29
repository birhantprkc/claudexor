import { flagBool, type ParsedArgs } from "./args.js";
import { renderCliFailure, type RenderCliFailureOptions, usageError } from "./cli-error.js";

/** The complete output contract selected before command dispatch. */
export type CliOutputMode = "human" | "json" | "json-stream" | "conflict";

export function cliOutputMode(args: ParsedArgs): CliOutputMode {
  const json = flagBool(args, "json");
  const stream = flagBool(args, "json-stream");
  if (json && stream) return "conflict";
  if (stream) return "json-stream";
  return json ? "json" : "human";
}

export function outputModeIsMachine(mode: CliOutputMode): boolean {
  return mode !== "human";
}

export function outputModeIsStream(mode: CliOutputMode): boolean {
  return mode === "json-stream";
}

/** Render a failure without reconstructing output mode inside a handler. */
export function renderOutputFailure(
  mode: CliOutputMode,
  error: unknown,
  options: RenderCliFailureOptions = {},
): number {
  return renderCliFailure(outputModeIsMachine(mode), error, {
    ...options,
    stream: outputModeIsStream(mode),
  });
}

export function renderOutputUsageFailure(mode: CliOutputMode, message: string): number {
  return renderOutputFailure(mode, usageError(message, { code: "invalid_argument" }));
}

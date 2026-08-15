/** C7c: `claudexor daemon start` reports the admission mode honestly — a
 * recovery-only daemon came up (exit 0) but product routes stay closed until
 * journal recovery completes, and the JSON envelope carries servingMode. */
import { print, printJson } from "./cli-io.js";

const RECOVERY_ONLY_NOTE =
  " and is serving recovery only — product routes are closed until journal recovery completes";

export function reportDaemonStartReady(input: {
  json: boolean;
  socket: string;
  servingMode: "normal" | "recovery_only";
  pid: number | null;
  alreadyRunning: boolean;
}): void {
  if (input.json) {
    printJson({
      pid: input.pid,
      socket: input.socket,
      ready: true,
      ...(input.alreadyRunning ? { alreadyRunning: true } : {}),
      servingMode: input.servingMode,
    });
    return;
  }
  const note = input.servingMode === "recovery_only" ? RECOVERY_ONLY_NOTE : "";
  print(
    input.alreadyRunning
      ? `claudexord already running${note}; socket ${input.socket}`
      : note
        ? `claudexord started (pid ${input.pid})${note}; socket ${input.socket}`
        : `claudexord ready (pid ${input.pid}); socket ${input.socket}`,
  );
}

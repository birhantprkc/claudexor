import { chmodSync, lstatSync, unlinkSync } from "node:fs";
import type { Server } from "node:net";
import { pathExists } from "@claudexor/util";

/**
 * Clears a stale Unix socket file so the daemon can bind, refusing paths the
 * daemon does not own. Windows named pipes are not filesystem entries, so the
 * caller skips this entirely for pipe endpoints.
 */
export function clearStaleUnixSocketPath(socketPath: string): void {
  if (!pathExists(socketPath)) return;
  const stale = lstatSync(socketPath);
  if (!stale.isSocket() || (process.getuid && stale.uid !== process.getuid())) {
    throw Object.assign(new Error(`refusing to replace non-owned Unix socket path`), {
      code: "unsafe_daemon_socket_path",
    });
  }
  unlinkSync(socketPath);
}

/** Binds the server and tightens Unix socket permissions to the owner. */
export function listenOnDaemonEndpoint(
  server: Server,
  socketPath: string,
  pipeEndpoint: boolean,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      if (!pipeEndpoint) {
        try {
          chmodSync(socketPath, 0o600);
        } catch {
          /* best-effort on exotic filesystems */
        }
      }
      resolve();
    });
  });
}

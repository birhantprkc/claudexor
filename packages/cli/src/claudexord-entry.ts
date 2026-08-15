import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { engineBuildIdentity } from "@claudexor/util";

/**
 * Side-effect-free dispatch for the daemon executable's alternate belt role.
 * Kept outside claudexord.ts so the daemon owner remains below its readability
 * ratchet and the entry decision can be tested without daemon initialization.
 */
/** Handle `claudexord --probe`: print the engine build identity as ONE JSON line
 * ({version, buildSha}) and exit WITHOUT any durable startup — no writer lease,
 * no socket bind, no journal open, no runtime root. This is the pre-swap
 * handshake the macOS installer's RuntimeInstallCoordinator.probeVersion runs
 * against a freshly-unpacked closure with the app-bundled Node (D-2). Returns
 * true when the probe handled the invocation. */
export function runProbeIfRequested(argv: readonly string[]): boolean {
  if (!argv.includes("--probe")) return false;
  const id = engineBuildIdentity();
  process.stdout.write(`${JSON.stringify({ version: id.version, buildSha: id.sha })}\n`);
  return true;
}

export function isBeltServeInvocation(argv: readonly string[]): boolean {
  return argv.length === 2 && argv[0] === "mcp" && argv[1] === "serve-belt";
}

export async function runBeltServeIfRequested(argv: readonly string[]): Promise<boolean> {
  if (!isBeltServeInvocation(argv)) return false;
  const { serveBeltBridge } = await import("./belt-bridge.js");
  process.exitCode = await serveBeltBridge();
  return true;
}

export function dispatchClaudexordEntry(
  daemonMain: () => Promise<void>,
  argv: readonly string[] = process.argv.slice(2),
): void {
  runBeltServeIfRequested(argv)
    .then(async (handled) => {
      if (!handled) await daemonMain();
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `claudexord: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}

/** Preserve import-side-effect freedom while supporting direct `node dist/claudexord.js`. */
export function runIfDirectEntry(
  moduleUrl: string,
  entry: () => void,
  argv: readonly string[] = process.argv,
): void {
  try {
    if (
      typeof argv[1] === "string" &&
      realpathSync.native(resolve(argv[1])) === realpathSync.native(fileURLToPath(moduleUrl))
    ) {
      entry();
    }
  } catch {
    // A malformed executable path is not direct-entry proof.
  }
}

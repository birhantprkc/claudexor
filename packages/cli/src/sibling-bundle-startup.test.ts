import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { build } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const repoRoot = resolve(import.meta.dirname, "../../..");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("self-contained sibling CLI/daemon bundle startup", () => {
  it.skipIf(process.platform === "win32")(
    "starts, handshakes, tails logs, and stops from an isolated sibling bundle",
    async () => {
      // Keep the default daemon socket below macOS' short AF_UNIX path limit.
      const root = mkdtempSync(join(realpathSync("/tmp"), "cx165-"));
      roots.push(root);
      const bundleDir = join(root, "bundle");
      const configDir = join(root, "config");
      const homeDir = join(root, "home");
      const projectDir = join(root, "repo");
      for (const path of [bundleDir, configDir, homeDir, projectDir])
        mkdirSync(path, { recursive: true, mode: 0o700 });
      const cli = join(bundleDir, "claudexor-cli.js");
      const daemon = join(bundleDir, "claudexord.js");
      const banner =
        "import { createRequire as __cxCreateRequire } from 'node:module';\n" +
        "import { fileURLToPath as __cxFileURLToPath } from 'node:url';\n" +
        "import { dirname as __cxDirname } from 'node:path';\n" +
        "const require = __cxCreateRequire(import.meta.url);\n" +
        "const __filename = __cxFileURLToPath(import.meta.url);\n" +
        "const __dirname = __cxDirname(__filename);";
      for (const [entry, outfile] of [
        [join(repoRoot, "packages", "cli", "dist", "cli.js"), cli],
        [join(repoRoot, "packages", "cli", "dist", "claudexord.js"), daemon],
      ] as const) {
        await build({
          entryPoints: [entry],
          outfile,
          bundle: true,
          platform: "node",
          format: "esm",
          target: "node20",
          banner: { js: banner },
          logLevel: "silent",
        });
      }
      const bundleHashes = new Map([cli, daemon].map((path) => [path, sha256(path)] as const));
      const homeSentinel = join(homeDir, "sentinel");
      writeFileSync(homeSentinel, "unchanged\n");
      const {
        CLAUDEXOR_DAEMON_ENTRY: _entry,
        CLAUDEXOR_DAEMON_SOCK: _sock,
        ...baseEnv
      } = process.env;
      const env = {
        ...baseEnv,
        HOME: homeDir,
        CLAUDEXOR_CONFIG_DIR: configDir,
        PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
      };
      const run = (args: string[]) =>
        spawnSync(process.execPath, [cli, ...args], {
          cwd: projectDir,
          env,
          encoding: "utf8",
          timeout: 30_000,
        });

      let started: ReturnType<typeof run> | null = null;
      try {
        started = run(["daemon", "start", "--json"]);
        const daemonLog = join(configDir, "daemon", "claudexord.log");
        const logTail = (() => {
          try {
            return readFileSync(daemonLog, "utf8");
          } catch {
            return "<no daemon log>";
          }
        })();
        expect(started.status, `${started.stdout}\n${started.stderr}\n${logTail}`).toBe(0);
        expect(JSON.parse(started.stdout)).toMatchObject({ ready: true });
        const status = run(["daemon", "status", "--json"]);
        expect(status.status, `${status.stdout}\n${status.stderr}`).toBe(0);
        expect(JSON.parse(status.stdout)).toMatchObject({ ok: true });
        const logs = run(["daemon", "logs", "--json"]);
        expect(logs.status, `${logs.stdout}\n${logs.stderr}`).toBe(0);
        expect(JSON.parse(logs.stdout)).toMatchObject({ ok: true });
        expect(JSON.parse(logs.stdout).log_tail).toContain("claudexor");
      } finally {
        const stopped = run(["daemon", "stop", "--json"]);
        if (started?.status === 0)
          expect(stopped.status, `${stopped.stdout}\n${stopped.stderr}`).toBe(0);
      }

      expect(readFileSync(homeSentinel, "utf8")).toBe("unchanged\n");
      expect(readdirSync(projectDir)).toEqual([]);
      for (const [path, hash] of bundleHashes) expect(sha256(path)).toBe(hash);
      expect(readdirSync(root).sort()).toEqual(["bundle", "config", "home", "repo"]);
    },
    30_000,
  );
});

import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { copyTreeMaterialized } from "./remote-runtime-archive.mjs";

const source = fileURLToPath(new URL("../build-engine-resources.sh", import.meta.url));
const roots = [];
const shellTest = existsSync("/bin/bash") ? test : test.skip;
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture({ darwin = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "engine-resource-stage-"));
  roots.push(root);
  const repo = join(root, "repo");
  const script = join(repo, "scripts/build-engine-resources.sh");
  const bin = join(root, "bin");
  const native = join(repo, "packages/core/dist/native/claudexor-process-identity");
  mkdirSync(dirname(script), { recursive: true });
  mkdirSync(bin);
  copyFileSync(source, script);
  if (darwin) {
    mkdirSync(dirname(native), { recursive: true });
    writeFileSync(
      native,
      "#!/bin/sh\nprintf 'claudexor-process-identity-v2\\t%s\\t1\\t1\\t000001\\n' \"$2\"\n",
      { mode: 0o755 },
    );
    writeFileSync(join(bin, "uname"), "#!/bin/sh\nprintf 'Darwin\\n'\n", { mode: 0o755 });
  }
  writeFileSync(
    join(bin, "pnpm"),
    `#!/bin/bash
set -eu
if [ "$1" = "-w" ]; then exit 0; fi
if [ "$1" = "exec" ]; then
  for arg in "$@"; do
    case "$arg" in --outfile=*) printf '// sha=%s\\n' "$CLAUDEXOR_BUILD_SHA" > "\${arg#--outfile=}";; esac
  done
  exit 0
fi
for dest in "$@"; do :; done
mkdir -p "$dest/dist/native" "$dest/node_modules/.pnpm/node_modules/@claudexor"
if [ -f "$PWD/packages/core/dist/native/claudexor-process-identity" ]; then
  cp "$PWD/packages/core/dist/native/claudexor-process-identity" "$dest/dist/native/"
fi
printf 'browser\\n' > "$dest/dist/browser-mcp-launcher.js"
ln -s "$PWD/packages/core" "$dest/node_modules/.pnpm/node_modules/@claudexor/core"
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, "codesign"),
    `#!/bin/bash
set -eu
if [ "$1" = "--verify" ]; then exit 0; fi
for target in "$@"; do :; done
printf '# signature\\n' >> "$target"
`,
    { mode: 0o755 },
  );
  const out = join(root, "resources");
  const env = {
    ...process.env,
    PATH: `${bin}:/usr/bin:/bin`,
    CLAUDEXOR_BUILD_SHA: "0123456789abcdef0123456789abcdef01234567",
    CLAUDEXOR_WIN32_CONPTY_HELPER: "",
    CLAUDEXOR_WIN32_CONPTY_SHA256: "",
    CLAUDEXOR_REQUIRE_WIN32_CONPTY_HELPER: "0",
    SIGN_IDENTITY: darwin ? "fixture" : "",
  };
  return { root, script, native, out, env };
}

shellTest(
  "Darwin engine resources build without Swift/app packaging and sign native bytes once",
  () => {
    const f = fixture({ darwin: true });
    const result = spawnSync("/bin/bash", [f.script, f.out], { env: f.env, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    for (const name of [
      "claudexord.bundle.cjs",
      "claudexor.bundle.cjs",
      "setup-login-runner.cjs",
    ]) {
      expect(readFileSync(join(f.out, name), "utf8")).toContain(f.env.CLAUDEXOR_BUILD_SHA);
    }
    expect(existsSync(join(f.out, "node"))).toBe(false);
    for (const name of [
      "native/claudexor-process-identity",
      "browser-mcp-runtime/dist/native/claudexor-process-identity",
    ]) {
      expect(readFileSync(join(f.out, name), "utf8").match(/# signature/g)).toHaveLength(1);
    }
    expect(
      existsSync(
        join(f.out, "browser-mcp-runtime/node_modules/.pnpm/node_modules/@claudexor/core"),
      ),
    ).toBe(false);
  },
);

(process.platform === "linux" ? shellTest : test.skip)(
  "Linux builds resources without any Darwin helper",
  () => {
    const f = fixture();
    expect(existsSync(f.native)).toBe(false);
    const result = spawnSync("/bin/bash", [f.script, f.out], { env: f.env, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    for (const name of [
      "claudexord.bundle.cjs",
      "claudexor.bundle.cjs",
      "setup-login-runner.cjs",
      "browser-mcp-runtime/dist/browser-mcp-launcher.js",
    ]) {
      expect(existsSync(join(f.out, name))).toBe(true);
    }
    expect(existsSync(join(f.out, "native"))).toBe(false);
  },
);

shellTest.each(["missing", "failed_probe"])("Darwin refuses a %s native helper", (failure) => {
  const f = fixture({ darwin: true });
  if (failure === "missing") rmSync(f.native);
  else writeFileSync(f.native, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const result = spawnSync("/bin/bash", [f.script, f.out], { env: f.env, encoding: "utf8" });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(
    failure === "missing" ? /claudexor-process-identity/ : /failed its offline probe/,
  );
});

shellTest(
  "shared-lockfile hoisted deploy preserves transitive requires after materialization",
  () => {
    const root = mkdtempSync(join(tmpdir(), "engine-dependency-closure-"));
    roots.push(root);
    const repo = join(root, "repo");
    for (const [name, dependencies, code] of [
      ["entry", { middle: "workspace:*" }, "module.exports = require('middle');"],
      ["middle", { leaf: "workspace:*" }, "module.exports = require('leaf');"],
      ["leaf", {}, "module.exports = 'exact leaf bytes';"],
    ]) {
      const dir = join(repo, "packages", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name, version: "1.0.0", main: "index.cjs", dependencies }),
      );
      writeFileSync(join(dir, "index.cjs"), code);
    }
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({
        private: true,
        packageManager: JSON.parse(
          readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
        ).packageManager,
      }),
    );
    writeFileSync(join(repo, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
    const command = (args) =>
      execFileSync("pnpm", args, { cwd: repo, encoding: "utf8", timeout: 15000, stdio: "pipe" });
    command(["install", "--lockfile-only", "--offline", "--ignore-scripts"]);
    const lock = readFileSync(join(repo, "pnpm-lock.yaml"));
    const deployed = join(root, "deployed");
    const args = [
      "--filter",
      "entry",
      "deploy",
      "--prod",
      "--offline",
      "--config.inject-workspace-packages=true",
      "--config.node-linker=hoisted",
      deployed,
    ];
    for (const option of args.filter((arg) => arg.startsWith("--config."))) {
      expect(readFileSync(source, "utf8")).toContain(option);
    }
    command(args);
    const materialized = join(root, "materialized");
    copyTreeMaterialized(deployed, materialized);
    expect(
      execFileSync(process.execPath, ["-p", "require('./index.cjs')"], {
        cwd: materialized,
        encoding: "utf8",
      }).trim(),
    ).toBe("exact leaf bytes");
    expect(readFileSync(join(repo, "pnpm-lock.yaml"))).toEqual(lock);
  },
);

shellTest("a previous resource tree is never overwritten", () => {
  const f = fixture();
  mkdirSync(f.out);
  writeFileSync(join(f.out, "sentinel"), "old bytes");
  expect(() =>
    execFileSync("/bin/bash", [f.script, f.out], { env: f.env, stdio: "pipe" }),
  ).toThrow();
  expect(readFileSync(join(f.out, "sentinel"), "utf8")).toBe("old bytes");
});

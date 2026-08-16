import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { HarnessConfinement } from "@claudexor/schema";
import {
  applyConfinement,
  buildConfinementProfile,
  confinedInvocation,
  confinementBoundaryAvailable,
  confinementDeniedReadPaths,
  type ConfinementHost,
  type ConfinementInput,
} from "./confinement.js";
import { ConfinementUnavailableError } from "./errors.js";

const darwin = process.platform === "darwin";

/**
 * A fake operator home laid out like the real one: a Claudexor runtime tree
 * holding the daemon token, a vendor-credential root beside it, the managed
 * toolchain (`node/bin` shims + `node/lib` payloads), a scoped harness home
 * inside it, an `.ssh` store, and a worktree.
 */
function scaffold(): {
  base: string;
  input: ConfinementInput;
  token: string;
  sshKey: string;
  codexHome: string;
  toolchainBin: string;
} {
  const base = mkdtempSync(join(tmpdir(), "cxi-confinement-"));
  const operatorHome = join(base, "home");
  const runtimeRoot = join(operatorHome, ".claudexor");
  const nativeStateRoot = join(runtimeRoot, "native");
  // The production CODEX_HOME shape: a vendor directory INSIDE the native root.
  const codexHome = join(nativeStateRoot, "codex");
  const scopedHome = join(runtimeRoot, "projects", "abc", "workspaces", "a01", "home");
  const worktree = join(operatorHome, "project");
  const toolchainBin = join(runtimeRoot, "node", "bin");
  for (const dir of [
    join(runtimeRoot, "daemon"),
    codexHome,
    scopedHome,
    worktree,
    toolchainBin,
    join(operatorHome, ".ssh"),
    join(runtimeRoot, "projects", "other-project"),
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  const token = join(runtimeRoot, "daemon", "token");
  writeFileSync(token, "cxi-daemon-bearer");
  const sshKey = join(operatorHome, ".ssh", "id_ed25519");
  writeFileSync(sshKey, "PRIVATE");
  writeFileSync(join(nativeStateRoot, "auth.json"), "{}");
  writeFileSync(join(runtimeRoot, "projects", "other-project", "note"), "sibling");
  writeFileSync(join(worktree, "README.md"), "hello");
  return {
    base,
    token,
    sshKey,
    codexHome,
    toolchainBin,
    input: { operatorHome, runtimeRoot, nativeStateRoot, scopedHome, worktree },
  };
}

/** Read a path INSIDE the profile, the way the harness child would. */
function readUnder(profile: string, path: string): number | null {
  return spawnSync("/usr/bin/sandbox-exec", ["-p", profile, "/bin/cat", path], {
    encoding: "utf8",
  }).status;
}

function writeUnder(profile: string, path: string): number | null {
  return spawnSync("/usr/bin/sandbox-exec", ["-p", profile, "/usr/bin/touch", path], {
    encoding: "utf8",
  }).status;
}

/** Canonicalize a path INSIDE the profile — `realpath(3)`, the same libc walk as Rust `fs::canonicalize`. */
function canonicalizeUnder(profile: string, path: string): number | null {
  return spawnSync("/usr/bin/sandbox-exec", ["-p", profile, "/bin/realpath", path], {
    encoding: "utf8",
  }).status;
}

/** List a directory INSIDE the profile: readdir is a DATA read on the directory. */
function listUnder(profile: string, path: string): number | null {
  return spawnSync("/usr/bin/sandbox-exec", ["-p", profile, "/bin/ls", path], {
    encoding: "utf8",
  }).status;
}

/**
 * Execute a binary INSIDE the profile, the way the spawn layer starts the
 * harness child: sandbox-exec itself execvp's the target, so a read-denied
 * executable fails before the program runs a single instruction.
 */
function execUnder(
  profile: string,
  path: string,
): { status: number | null; stdout: string; stderr: string } {
  const run = spawnSync("/usr/bin/sandbox-exec", ["-p", profile, path], { encoding: "utf8" });
  return { status: run.status, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
}

/**
 * The platform branches are driven by INJECTING the host, because this machine
 * cannot boot the other two. Each of these is a real shape the engine must
 * handle: a platform Claudexor applies no boundary on at all (every non-macOS
 * host, by decision), and a macOS host whose `sandbox-exec` is absent.
 */
const WINDOWS_HOST: ConfinementHost = {
  platform: "win32",
  exists: existsSync,
  run: () => ({ status: 0 }),
};

const LINUX_HOST: ConfinementHost = {
  platform: "linux",
  exists: existsSync,
  run: () => ({ status: 0 }),
};

const DARWIN_WITHOUT_SEATBELT: ConfinementHost = {
  platform: "darwin",
  exists: () => false,
  run: () => ({ status: 0 }),
};

describe("confinement profile", () => {
  const fixture = scaffold();
  afterAll(() => rmSync(fixture.base, { recursive: true, force: true }));

  it("names the daemon tree, the runtime root and the operator credential stores", () => {
    const denied = confinementDeniedReadPaths(fixture.input);
    expect(denied[0]).toBe(join(fixture.input.runtimeRoot, "daemon"));
    expect(denied).toContain(fixture.input.runtimeRoot);
    // Derived from the sensitive-resource owner, never re-listed here.
    expect(denied).toContain(join(fixture.input.operatorHome, ".ssh"));
    expect(denied).toContain(join(fixture.input.operatorHome, ".aws"));
  });

  it.runIf(darwin)("makes the daemon token unreadable to a process inside it", () => {
    const profile = buildConfinementProfile(fixture.input);
    // The pre-fix reproduction: TOKEN_READABLE=yes out of a workspace_write run.
    expect(readUnder(profile, fixture.token)).not.toBe(0);
    expect(spawnSync("/bin/cat", [fixture.token], { encoding: "utf8" }).status).toBe(0);
  });

  it.runIf(darwin)("also denies the operator's own credential stores and other projects", () => {
    const profile = buildConfinementProfile(fixture.input);
    expect(readUnder(profile, fixture.sshKey)).not.toBe(0);
    expect(
      readUnder(profile, join(fixture.input.runtimeRoot, "projects", "other-project", "note")),
    ).not.toBe(0);
  });

  it.runIf(darwin)("keeps everything the child legitimately needs", () => {
    const profile = buildConfinementProfile(fixture.input);
    // Worktree read+write, scoped home write, vendor credential read: without
    // these the boundary would be a capability regression, not a fix.
    expect(readUnder(profile, join(fixture.input.worktree, "README.md"))).toBe(0);
    expect(writeUnder(profile, join(fixture.input.worktree, "new-file"))).toBe(0);
    expect(writeUnder(profile, join(fixture.input.scopedHome, "state"))).toBe(0);
    expect(readUnder(profile, join(fixture.input.nativeStateRoot, "auth.json"))).toBe(0);
  });

  it.runIf(darwin)("denies writes into the operator home outside the run's own roots", () => {
    const profile = buildConfinementProfile(fixture.input);
    expect(writeUnder(profile, join(fixture.input.operatorHome, "planted"))).not.toBe(0);
  });
});

/**
 * Two startup regressions of one class, measured live on different own roots.
 * Canonicalization — libc `realpath(3)`, Rust `fs::canonicalize`, SQLite's
 * unix VFS path resolution — lstat/readlinks every INTERMEDIATE path
 * component. The own-roots allow covers each root's subtree, but the
 * components between the runtime root and the root matched the read deny:
 * codex died canonicalizing CODEX_HOME under the native state root
 * (2026-08-10, EPERM, `failed to canonicalize CODEX_HOME`), and cursor-agent
 * died opening its SQLite chat store under the scoped HOME (2026-08-15,
 * SQLITE_CANTOPEN, `unable to open database file`). The profile now carries a
 * literal, metadata-only allowance for the union of every own root's denied
 * ancestor chain.
 */
describe("metadata traversal carve-out for the run's own roots", () => {
  const fixture = scaffold();
  afterAll(() => rmSync(fixture.base, { recursive: true, force: true }));
  const res = (path: string): string => realpathSync.native(path);
  const lit = (path: string): string => `(literal ${JSON.stringify(res(path))})`;
  // The scoped home sits five levels below the runtime root in the scaffold
  // (the production workspace shape), so its chain is the deepest one.
  const scopedHomeChain = [
    join(fixture.input.runtimeRoot, "projects", "abc", "workspaces", "a01"),
    join(fixture.input.runtimeRoot, "projects", "abc", "workspaces"),
    join(fixture.input.runtimeRoot, "projects", "abc"),
    join(fixture.input.runtimeRoot, "projects"),
    fixture.input.runtimeRoot,
  ];

  it("emits literal metadata allows for every own root's denied ancestors, deduplicated", () => {
    const profile = buildConfinementProfile(fixture.input);
    const lines = profile.split("\n");
    const deny = lines.findIndex((line) => line.startsWith("(deny file-read* "));
    const meta = lines.findIndex((line) => line.startsWith("(allow file-read-metadata "));
    const own = lines.findIndex((line) => line.startsWith("(allow file-read* file-write* "));
    // SBPL is last-match-wins: the metadata allow must FOLLOW the deny it
    // punches through, and the own-roots allow must stay last.
    expect(deny).toBeGreaterThanOrEqual(0);
    expect(meta).toBeGreaterThan(deny);
    expect(own).toBeGreaterThan(meta);
    expect(own).toBe(lines.length - 2);
    // literal, never subpath: metadata of the directory entry itself, nothing
    // under it. The scoped-home chain comes first (own-roots order), the
    // worktree is outside the runtime root and contributes nothing, and the
    // native root's only ancestor — the runtime root — is already collected.
    expect(lines[meta]).toBe(`(allow file-read-metadata ${scopedHomeChain.map(lit).join(" ")})`);
    expect(lines[meta]).not.toContain("subpath");
  });

  it("walks every intermediate directory for a deeper native root, deduplicated against the scoped-home chain", () => {
    const deepNative = join(fixture.input.runtimeRoot, "native", "vendors", "codex-deep");
    mkdirSync(deepNative, { recursive: true });
    const profile = buildConfinementProfile({ ...fixture.input, nativeStateRoot: deepNative });
    const meta = profile.split("\n").find((line) => line.startsWith("(allow file-read-metadata "));
    expect(meta).toBe(
      "(allow file-read-metadata " +
        `${scopedHomeChain.map(lit).join(" ")} ` +
        `${lit(join(fixture.input.runtimeRoot, "native", "vendors"))} ` +
        `${lit(join(fixture.input.runtimeRoot, "native"))})`,
    );
  });

  it("emits no carve-out when no own root lies inside the runtime root", () => {
    const nativeOutside = join(fixture.base, "native-outside");
    const scopedHomeOutside = join(fixture.base, "scoped-home-outside");
    mkdirSync(nativeOutside, { recursive: true });
    mkdirSync(scopedHomeOutside, { recursive: true });
    const profile = buildConfinementProfile({
      ...fixture.input,
      nativeStateRoot: nativeOutside,
      scopedHome: scopedHomeOutside,
    });
    expect(profile).not.toContain("file-read-metadata");
  });

  it("keeps the scoped-home chain when only the native root moves outside", () => {
    const outside = join(fixture.base, "native-outside-solo");
    mkdirSync(outside, { recursive: true });
    const profile = buildConfinementProfile({ ...fixture.input, nativeStateRoot: outside });
    const meta = profile.split("\n").find((line) => line.startsWith("(allow file-read-metadata "));
    expect(meta).toBe(`(allow file-read-metadata ${scopedHomeChain.map(lit).join(" ")})`);
  });

  it.runIf(darwin)(
    "lets a confined child canonicalize its own roots — CODEX_HOME and the scoped HOME",
    () => {
      const profile = buildConfinementProfile(fixture.input);
      expect(canonicalizeUnder(profile, fixture.codexHome)).toBe(0);
      expect(canonicalizeUnder(profile, fixture.input.nativeStateRoot)).toBe(0);
      expect(canonicalizeUnder(profile, fixture.input.scopedHome)).toBe(0);
    },
  );

  it.runIf(darwin)(
    "proves the carve-out is load-bearing: stripping it kills the same canonicalize",
    () => {
      const stripped = buildConfinementProfile(fixture.input)
        .split("\n")
        .filter((line) => !line.startsWith("(allow file-read-metadata "))
        .join("\n");
      expect(canonicalizeUnder(stripped, fixture.input.scopedHome)).not.toBe(0);
      expect(canonicalizeUnder(stripped, fixture.codexHome)).not.toBe(0);
    },
  );

  it.runIf(darwin)("does not re-open data reads or listings under the runtime root", () => {
    const profile = buildConfinementProfile(fixture.input);
    // File DATA inside the daemon dir stays denied.
    expect(readUnder(profile, fixture.token)).not.toBe(0);
    // A sibling project's file data stays denied even though `projects` itself
    // is now a metadata-allowed literal on the scoped-home chain.
    expect(
      readUnder(profile, join(fixture.input.runtimeRoot, "projects", "other-project", "note")),
    ).not.toBe(0);
    // readdir is a data read on the DIRECTORY, not metadata: listing stays denied.
    expect(listUnder(profile, fixture.input.runtimeRoot)).not.toBe(0);
    expect(listUnder(profile, join(fixture.input.runtimeRoot, "daemon"))).not.toBe(0);
    expect(listUnder(profile, join(fixture.input.runtimeRoot, "projects"))).not.toBe(0);
  });
});

/**
 * The cursor-startup regression (2026-08-15, live), pinned end to end:
 * cursor-agent keeps its chat store in SQLite under the scoped HOME
 * (`<scoped home>/.config/cursor/chats/<cwd-hash>/<chat-uuid>/store.db`), and
 * SQLite's unix VFS canonicalizes the database path on open — the same
 * lstat/readlink walk as `realpath(3)`. Without the scoped-home ancestor
 * carve-out that open died with SQLITE_CANTOPEN (`RetriableError: [internal]
 * unable to open database file`) on 100% of mutating delegated cursor runs.
 * Apple's /usr/bin/sqlite3 build does NOT canonicalize on open (verified: it
 * survives the pre-fix profile), so this pin drives Node's own SQLite binding
 * — the engine cursor-agent actually runs on — through the real sandbox.
 */
describe("cursor sqlite regression: chat store under the scoped HOME", () => {
  const fixture = scaffold();
  afterAll(() => rmSync(fixture.base, { recursive: true, force: true }));
  const chatDir = join(
    fixture.input.scopedHome,
    ".config",
    "cursor",
    "chats",
    "0123abcd",
    "chat-uuid-1",
  );
  mkdirSync(chatDir, { recursive: true });

  /** Open + WAL-write a SQLite db INSIDE the profile, the way cursor-agent's chat store does. */
  function sqliteUnder(
    profile: string,
    dbPath: string,
  ): { status: number | null; stdout: string; stderr: string } {
    const script = [
      'const { DatabaseSync } = require("node:sqlite");',
      'const { existsSync } = require("node:fs");',
      "const db = new DatabaseSync(process.argv[1]);",
      'db.exec("PRAGMA journal_mode=WAL");',
      'db.exec("CREATE TABLE IF NOT EXISTS t(x)");',
      'db.exec("INSERT INTO t VALUES(1)");',
      // WAL actually engaged: the sidecars exist while the connection is open
      // (SQLite removes them again on a clean close).
      'if (!existsSync(process.argv[1] + "-wal")) throw new Error("wal sidecar missing");',
      'if (!existsSync(process.argv[1] + "-shm")) throw new Error("shm sidecar missing");',
      "db.close();",
      'console.log("cursor-sqlite-ok");',
    ].join("\n");
    const run = spawnSync(
      "/usr/bin/sandbox-exec",
      ["-p", profile, process.execPath, "-e", script, dbPath],
      { encoding: "utf8" },
    );
    return { status: run.status, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
  }

  it.runIf(darwin)("lets a confined cursor-shaped child open and WAL-write its chat store", () => {
    const profile = buildConfinementProfile(fixture.input);
    const opened = sqliteUnder(profile, join(chatDir, "store.db"));
    expect(opened.stderr).not.toMatch(/unable to open database file/);
    expect(opened.status).toBe(0);
    expect(opened.stdout).toContain("cursor-sqlite-ok");
  });

  it.runIf(darwin)("reproduces the pre-fix crash when the traversal carve-out is stripped", () => {
    const stripped = buildConfinementProfile(fixture.input)
      .split("\n")
      .filter((line) => !line.startsWith("(allow file-read-metadata "))
      .join("\n");
    const opened = sqliteUnder(stripped, join(chatDir, "store-prefix.db"));
    expect(opened.status).not.toBe(0);
    expect(opened.stderr).toMatch(/unable to open database file/);
  });

  it.runIf(darwin)("keeps the boundary intact around the sqlite grant", () => {
    const profile = buildConfinementProfile(fixture.input);
    // The daemon token's data and the runtime root's listing stay denied.
    expect(readUnder(profile, fixture.token)).not.toBe(0);
    expect(listUnder(profile, fixture.input.runtimeRoot)).not.toBe(0);
    // A database INSIDE the denied daemon dir stays unopenable.
    const denied = sqliteUnder(profile, join(fixture.input.runtimeRoot, "daemon", "planted.db"));
    expect(denied.status).not.toBe(0);
  });
});

/**
 * The codex-startup regression's SECOND half (2026-08-10, VM battery phase 13,
 * default config): in the default layout the managed toolchain lives INSIDE the
 * runtime root (`~/.claudexor/node`), and exec is a read — sandbox-exec's
 * execvp of `<runtime root>/node/bin/codex` died with `Operation not
 * permitted` (exit 71) before the harness ran an instruction. The metadata
 * carve-out above fixed only realpath traversal, not binary exec. The profile
 * now carries a full read allow on exactly that subtree; everything else under
 * the runtime root stays denied.
 */
describe("managed toolchain exec carve-out", () => {
  const fixture = scaffold();
  afterAll(() => rmSync(fixture.base, { recursive: true, force: true }));
  const res = (path: string): string => realpathSync.native(path);

  // The production `bin/codex` shape: a relative symlink into
  // `lib/node_modules/**` whose target is what execvp actually reads.
  const libBin = join(fixture.input.runtimeRoot, "node", "lib", "node_modules", "probe", "bin");
  mkdirSync(libBin, { recursive: true });
  const shimTarget = join(libBin, "probe.js");
  writeFileSync(shimTarget, "#!/bin/sh\necho shim-ok\n", { mode: 0o755 });
  const shim = join(fixture.toolchainBin, "probe");
  symlinkSync(join("..", "lib", "node_modules", "probe", "bin", "probe.js"), shim);

  it("emits a subpath read allow on the node root, between the metadata carve-out and the write section", () => {
    const profile = buildConfinementProfile(fixture.input);
    const lines = profile.split("\n");
    const deny = lines.findIndex((line) => line.startsWith("(deny file-read* "));
    const meta = lines.findIndex((line) => line.startsWith("(allow file-read-metadata "));
    const tool = lines.findIndex((line) => line.startsWith("(allow file-read* (subpath"));
    const firstWriteDeny = lines.findIndex((line) => line.startsWith("(deny file-write* "));
    const own = lines.findIndex((line) => line.startsWith("(allow file-read* file-write* "));
    // Placement is policy: the allow must FOLLOW the read deny it punches
    // through (last-match-wins), sit with the other read carve-out, and stay
    // BEFORE the write section so it can never outrank a write deny.
    expect(deny).toBeGreaterThanOrEqual(0);
    expect(tool).toBeGreaterThan(meta);
    expect(meta).toBeGreaterThan(deny);
    expect(firstWriteDeny).toBeGreaterThan(tool);
    expect(own).toBe(lines.length - 2);
    // subpath, never literal: exec needs the shims, the node binary AND the
    // lib/ payloads they resolve to. Derived from the launcher's own helper.
    expect(lines[tool]).toBe(
      `(allow file-read* (subpath ${JSON.stringify(res(join(fixture.input.runtimeRoot, "node")))}))`,
    );
  });

  it("emits no toolchain carve-out when the runtime root does not contain the toolchain", () => {
    // The CLAUDEXOR_CONFIG_DIR shape: the override IS the runtime root while
    // the toolchain stays HOME-anchored outside it. Nothing denies it there,
    // so nothing is carved out — allow-default already covers it, mirroring
    // the native-root traversal pattern.
    const overrideRoot = join(fixture.base, "override-root");
    mkdirSync(join(overrideRoot, "daemon"), { recursive: true });
    const profile = buildConfinementProfile({
      ...fixture.input,
      runtimeRoot: overrideRoot,
      nativeStateRoot: join(overrideRoot, "native"),
    });
    expect(profile.split("\n").some((line) => line.startsWith("(allow file-read* (subpath"))).toBe(
      false,
    );
  });

  it.runIf(darwin)(
    "lets a confined child execute the managed toolchain (the phase-13 shape)",
    () => {
      const profile = buildConfinementProfile(fixture.input);
      // Through the shim symlink — exactly how the spawn layer starts codex.
      const viaShim = execUnder(profile, shim);
      expect(viaShim.status).toBe(0);
      expect(viaShim.stdout).toContain("shim-ok");
      // And the resolved target directly: the lib/ payload is readable too.
      const direct = execUnder(profile, shimTarget);
      expect(direct.status).toBe(0);
    },
  );

  it.runIf(darwin)("keeps exec denied everywhere else under the runtime root", () => {
    const profile = buildConfinementProfile(fixture.input);
    // The same executable bytes planted OUTSIDE the toolchain subtree must
    // stay unrunnable: the carve-out is the node root, not a general reopen.
    const planted = join(fixture.input.runtimeRoot, "daemon", "planted");
    writeFileSync(planted, "#!/bin/sh\necho must-not-print\n", { mode: 0o755 });
    const denied = execUnder(profile, planted);
    expect(denied.status).not.toBe(0);
    expect(denied.stderr).toMatch(/Operation not permitted/);
  });

  it.runIf(darwin)("does not weaken the boundary around the toolchain grant", () => {
    const profile = buildConfinementProfile(fixture.input);
    // The token's DATA stays denied, and the runtime root still cannot be listed.
    expect(readUnder(profile, fixture.token)).not.toBe(0);
    expect(listUnder(profile, fixture.input.runtimeRoot)).not.toBe(0);
    expect(listUnder(profile, join(fixture.input.runtimeRoot, "daemon"))).not.toBe(0);
    // The toolchain stays UNWRITABLE (the operator-home write deny outranks the
    // read allow): a confined child cannot trojan the shims the operator's own
    // daemon executes.
    expect(writeUnder(profile, join(fixture.toolchainBin, "trojan"))).not.toBe(0);
    // The disclosed grant, stated two-sidedly: the toolchain subtree itself is
    // readable and listable — it holds a Node distribution, not secrets.
    expect(listUnder(profile, fixture.toolchainBin)).toBe(0);
  });
});

describe("an applied boundary is a proof, never a name", () => {
  const fixture = scaffold();
  afterAll(() => rmSync(fixture.base, { recursive: true, force: true }));

  it("cannot even be expressed as a mechanism without the path it denied", () => {
    // The load-bearing shape: a reader treats a mechanism name with no proof as
    // NO boundary, so the engine must be unable to emit one in the first place.
    expect(
      HarnessConfinement.safeParse({
        mechanism: "seatbelt",
        profile: "(version 1)",
        profile_digest: "sha256:abc",
      }).success,
    ).toBe(false);
    expect(
      HarnessConfinement.safeParse({
        mechanism: "seatbelt",
        profile: "(version 1)",
        profile_digest: "sha256:abc",
        verified_denied_path: "",
      }).success,
    ).toBe(false);
  });

  it.runIf(darwin)("returns an applied record whose denial was proven on this host", () => {
    const applied = applyConfinement(fixture.input);
    expect(applied.unavailableReason).toBeNull();
    expect(applied.confinement?.mechanism).toBe("seatbelt");
    expect(applied.confinement?.profile_digest).toMatch(/^sha256:/);
    expect(applied.confinement?.verified_denied_path).toContain(".claudexor");
  });

  it("refuses a policy whose own carve-out would swallow a path it must deny", () => {
    // Not a platform fact — a layout Claudexor itself got wrong, on any host.
    expect(() =>
      applyConfinement({ ...fixture.input, worktree: fixture.input.operatorHome }),
    ).toThrowError(ConfinementUnavailableError);
  });

  it("refuses that same contradiction on hosts that have no boundary mechanism at all", () => {
    // The regression this pins: a host with no mechanism (every non-macOS
    // platform, and a macOS without sandbox-exec) used to return "no boundary
    // here" BEFORE the self-defeating layout was noticed, so the contradiction
    // sailed through as a quiet scoped-HOME run. The refusal is about the
    // policy's own shape and must not depend on the platform probe.
    const swallowing = { ...fixture.input, worktree: fixture.input.operatorHome };
    for (const host of [LINUX_HOST, WINDOWS_HOST, DARWIN_WITHOUT_SEATBELT]) {
      expect(() => applyConfinement(swallowing, host)).toThrowError(ConfinementUnavailableError);
    }
  });
});

describe("a host with no boundary works and says so", () => {
  const fixture = scaffold();
  afterAll(() => rmSync(fixture.base, { recursive: true, force: true }));

  it("does not refuse on windows, and names no mechanism it could not prove", () => {
    const applied = applyConfinement(fixture.input, WINDOWS_HOST);
    expect(applied.confinement).toBeNull();
    expect(applied.unavailableReason).toMatch(/applies no OS-enforced filesystem boundary/);
    expect(applied.unavailableReason).toContain("win32");
    expect(confinementBoundaryAvailable(WINDOWS_HOST).available).toBe(false);
  });

  it("does not refuse on linux either", () => {
    // Claudexor applies no kernel boundary here BY DECISION, not by omission.
    // The delegated run gets the scoped HOME and a stated absence, and completes.
    const applied = applyConfinement(fixture.input, LINUX_HOST);
    expect(applied.confinement).toBeNull();
    expect(applied.unavailableReason).toMatch(/applies no OS-enforced filesystem boundary/);
    expect(applied.unavailableReason).toContain("linux");
  });

  it("does not refuse on a macOS host whose sandbox-exec is missing", () => {
    const applied = applyConfinement(fixture.input, DARWIN_WITHOUT_SEATBELT);
    expect(applied.confinement).toBeNull();
    expect(applied.unavailableReason).toMatch(/seatbelt, which is not installed here/);
  });
});

describe("proveConfinementDenial rejects a sandbox that did not actually deny (audit claim E)", () => {
  const fixture = scaffold();
  afterAll(() => rmSync(fixture.base, { recursive: true, force: true }));

  const SEATBELT = "/usr/bin/sandbox-exec";
  // The denied probe applyConfinement selects is the daemon dir (first existing
  // denied path); an own-root is the positive-control surface.
  const isDeniedTarget = (path: string): boolean => path.includes("/daemon");

  /**
   * A darwin host whose sandbox-exec behavior is scripted, so the three failure
   * shapes are exercised on ANY platform (this box cannot boot the others, and a
   * real failed sandbox_apply cannot be provoked on demand). Unconfined `/bin/ls`
   * always succeeds (the paths are real); the wrapped sandbox-exec run is faked.
   */
  function scriptedHost(sandbox: (path: string) => { status: number | null; stderr?: string }) {
    return {
      platform: "darwin" as const,
      // sandbox-exec is present even on non-darwin dev/CI so the mechanism resolves.
      exists: (path: string) => path === SEATBELT || existsSync(path),
      run: (bin: string, args: string[]) => {
        if (bin === "/bin/ls") return { status: 0 }; // unconfined controls
        // mechanism.invocation => ["-p", profile, "/bin/ls", <path>]
        return sandbox(args[args.length - 1] ?? "");
      },
    } satisfies ConfinementHost;
  }

  it("records a proven boundary when the sandbox APPLIED and the denied path was denied", () => {
    const host = scriptedHost((path) =>
      isDeniedTarget(path)
        ? { status: 1, stderr: `ls: ${path}: Operation not permitted` } // program-level deny
        : { status: 0 },
    );
    const applied = applyConfinement(fixture.input, host);
    expect(applied.unavailableReason).toBeNull();
    expect(applied.confinement?.mechanism).toBe("seatbelt");
    expect(applied.confinement?.verified_denied_path).toContain("daemon");
  });

  it("does NOT record proof when the profile FAILED TO APPLY (sandbox_apply refused)", () => {
    // Every wrapped run fails identically: the positive control catches it.
    const host = scriptedHost(() => ({
      status: 1,
      stderr: "sandbox-exec: sandbox_apply: Operation not permitted",
    }));
    expect(() => applyConfinement(fixture.input, host)).toThrowError(ConfinementUnavailableError);
    try {
      applyConfinement(fixture.input, host);
    } catch (err) {
      expect((err as Error).message).toMatch(/sandbox did not apply/);
    }
  });

  it("does NOT record proof when the profile is MALFORMED (parse/compile error)", () => {
    const host = scriptedHost(() => ({
      status: 1,
      stderr: "/usr/bin/sandbox-exec: failed to parse the profile: unexpected token",
    }));
    expect(() => applyConfinement(fixture.input, host)).toThrowError(ConfinementUnavailableError);
  });

  it("does NOT credit an application fault that surfaces on the denied probe after the control passed", () => {
    // Belt-and-suspenders: the positive control passes (own-root readable), but
    // the denied probe's nonzero carries a sandbox_apply signature -> not a deny.
    const host = scriptedHost((path) =>
      isDeniedTarget(path)
        ? { status: 1, stderr: "sandbox-exec: sandbox_apply: Operation not permitted" }
        : { status: 0 },
    );
    expect(() => applyConfinement(fixture.input, host)).toThrowError(ConfinementUnavailableError);
    try {
      applyConfinement(fixture.input, host);
    } catch (err) {
      expect((err as Error).message).toMatch(/application fault, not a policy deny/);
    }
  });

  it("does NOT credit an unexplained non-completion (status null) as a deny", () => {
    const host = scriptedHost((path) =>
      isDeniedTarget(path) ? { status: null, stderr: "" } : { status: 0 },
    );
    expect(() => applyConfinement(fixture.input, host)).toThrowError(ConfinementUnavailableError);
  });

  it("does NOT record proof when an allowed path is denied under the sandbox (control failed)", () => {
    // The sandbox is over-broad: it denies EVERYTHING, so the denied path would
    // exit nonzero, but the positive control proves the sandbox is not honoring
    // its allow carve-outs and the denial is meaningless.
    const host = scriptedHost(() => ({ status: 1, stderr: "ls: Operation not permitted" }));
    expect(() => applyConfinement(fixture.input, host)).toThrowError(ConfinementUnavailableError);
    try {
      applyConfinement(fixture.input, host);
    } catch (err) {
      expect((err as Error).message).toMatch(/sandbox did not apply/);
    }
  });
});

describe("confined invocation", () => {
  it("wraps the argv when a boundary is applied and passes through when it is not", () => {
    const confinement = {
      mechanism: "seatbelt",
      profile: "(version 1)(allow default)",
      profile_digest: "sha256:x",
      verified_denied_path: "/x",
    };
    expect(confinedInvocation(confinement, "codex", ["exec"])).toEqual({
      bin: "/usr/bin/sandbox-exec",
      args: ["-p", confinement.profile, "codex", "exec"],
    });
    expect(confinedInvocation(null, "codex", ["exec"])).toEqual({ bin: "codex", args: ["exec"] });
  });

  it("refuses to spawn unwrapped when the record names a mechanism it cannot apply", () => {
    expect(() =>
      confinedInvocation(
        {
          mechanism: "landlock",
          profile: "x",
          profile_digest: "sha256:x",
          verified_denied_path: "/x",
        },
        "codex",
        ["exec"],
      ),
    ).toThrowError(ConfinementUnavailableError);
  });
});

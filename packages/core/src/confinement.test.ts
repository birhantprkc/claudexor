import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
 * holding the daemon token, a vendor-credential root beside it, a scoped harness
 * home inside it, an `.ssh` store, and a worktree.
 */
function scaffold(): {
  base: string;
  input: ConfinementInput;
  token: string;
  sshKey: string;
  codexHome: string;
} {
  const base = mkdtempSync(join(tmpdir(), "cxi-confinement-"));
  const operatorHome = join(base, "home");
  const runtimeRoot = join(operatorHome, ".claudexor");
  const nativeStateRoot = join(runtimeRoot, "native");
  // The production CODEX_HOME shape: a vendor directory INSIDE the native root.
  const codexHome = join(nativeStateRoot, "codex");
  const scopedHome = join(runtimeRoot, "projects", "abc", "workspaces", "a01", "home");
  const worktree = join(operatorHome, "project");
  for (const dir of [
    join(runtimeRoot, "daemon"),
    codexHome,
    scopedHome,
    worktree,
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
 * The codex-startup regression (2026-08-10, live): codex canonicalizes its
 * CODEX_HOME (`fs::canonicalize` = `realpath(3)`), which lstat/readlinks every
 * INTERMEDIATE path component. The own-roots allow covers the native root's
 * subtree, but the components between the runtime root and the native root
 * matched the read deny — EPERM, `failed to canonicalize CODEX_HOME`, and every
 * mutating delegated codex run crashed within seconds. The profile now carries
 * a literal, metadata-only allowance for exactly that ancestor chain.
 */
describe("metadata traversal carve-out for the native state root", () => {
  const fixture = scaffold();
  afterAll(() => rmSync(fixture.base, { recursive: true, force: true }));
  const res = (path: string): string => realpathSync.native(path);

  it("emits literal metadata allows for the denied ancestors, between the read deny and the own-roots allow", () => {
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
    // literal, never subpath: metadata of the directory entry itself, nothing under it.
    expect(lines[meta]).toBe(
      `(allow file-read-metadata (literal ${JSON.stringify(res(fixture.input.runtimeRoot))}))`,
    );
    expect(lines[meta]).not.toContain("subpath");
  });

  it("walks every intermediate directory for a deeper native root", () => {
    const deepNative = join(fixture.input.runtimeRoot, "native", "vendors", "codex-deep");
    mkdirSync(deepNative, { recursive: true });
    const profile = buildConfinementProfile({ ...fixture.input, nativeStateRoot: deepNative });
    const meta = profile.split("\n").find((line) => line.startsWith("(allow file-read-metadata "));
    expect(meta).toBe(
      "(allow file-read-metadata " +
        `(literal ${JSON.stringify(res(join(fixture.input.runtimeRoot, "native", "vendors")))}) ` +
        `(literal ${JSON.stringify(res(join(fixture.input.runtimeRoot, "native")))}) ` +
        `(literal ${JSON.stringify(res(fixture.input.runtimeRoot))}))`,
    );
  });

  it("emits no carve-out when the native root is not inside the runtime root", () => {
    const outside = join(fixture.base, "native-outside");
    mkdirSync(outside, { recursive: true });
    const profile = buildConfinementProfile({ ...fixture.input, nativeStateRoot: outside });
    expect(profile).not.toContain("file-read-metadata");
  });

  it.runIf(darwin)("lets a confined child canonicalize CODEX_HOME, the codex startup path", () => {
    const profile = buildConfinementProfile(fixture.input);
    expect(canonicalizeUnder(profile, fixture.codexHome)).toBe(0);
    expect(canonicalizeUnder(profile, fixture.input.nativeStateRoot)).toBe(0);
  });

  it.runIf(darwin)("does not re-open data reads or listings under the runtime root", () => {
    const profile = buildConfinementProfile(fixture.input);
    // File DATA inside the daemon dir stays denied.
    expect(readUnder(profile, fixture.token)).not.toBe(0);
    // readdir is a data read on the DIRECTORY, not metadata: listing stays denied.
    expect(listUnder(profile, fixture.input.runtimeRoot)).not.toBe(0);
    expect(listUnder(profile, join(fixture.input.runtimeRoot, "daemon"))).not.toBe(0);
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

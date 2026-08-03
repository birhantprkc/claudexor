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
function scaffold(): { base: string; input: ConfinementInput; token: string; sshKey: string } {
  const base = mkdtempSync(join(tmpdir(), "cxi-confinement-"));
  const operatorHome = join(base, "home");
  const runtimeRoot = join(operatorHome, ".claudexor");
  const nativeStateRoot = join(runtimeRoot, "native");
  const scopedHome = join(runtimeRoot, "projects", "abc", "workspaces", "a01", "home");
  const worktree = join(operatorHome, "project");
  for (const dir of [
    join(runtimeRoot, "daemon"),
    nativeStateRoot,
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

const BWRAP = "/usr/bin/bwrap";

/**
 * A Linux host whose bubblewrap is SIMULATED at the mount-semantics level:
 * `--tmpfs P` hides everything under P, a later `--bind Q Q` brings Q back.
 *
 * This is how the platform branch is exercised on a machine that cannot boot
 * Linux. It proves what the ENGINE does with each answer the mechanism can
 * give — including "bwrap is installed but does not enforce here", which is the
 * case a real distro produces by disabling unprivileged user namespaces. It
 * proves nothing about bwrap itself; the engine never trusts that either, which
 * is why the availability probe executes the mechanism before naming it.
 */
function fakeLinuxHost(behaviour: {
  installed: boolean;
  hides?: boolean;
  honorsBinds?: boolean;
}): ConfinementHost {
  return {
    platform: "linux",
    exists: (path) => (path === BWRAP ? behaviour.installed : existsSync(path)),
    run: (bin, args) => {
      if (bin !== BWRAP) return { status: existsSync(args[args.length - 1]) ? 0 : 1 };
      const probe = args[args.length - 1];
      const tmpfs: string[] = [];
      const binds: string[] = [];
      for (let i = 0; i < args.length - 2; i += 1) {
        if (args[i] === "--tmpfs") tmpfs.push(args[i + 1]);
        if (args[i] === "--bind") binds.push(args[i + 1]);
      }
      const under = (root: string) => probe === root || probe.startsWith(`${root}/`);
      if (behaviour.honorsBinds !== false && binds.some(under)) return { status: 0 };
      if (behaviour.hides !== false && tmpfs.some(under)) return { status: 1 };
      return { status: existsSync(probe) ? 0 : 1 };
    },
  };
}

const WINDOWS_HOST: ConfinementHost = {
  platform: "win32",
  exists: existsSync,
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
});

describe("a host with no boundary works and says so", () => {
  const fixture = scaffold();
  afterAll(() => rmSync(fixture.base, { recursive: true, force: true }));

  it("does not refuse on windows, and names no mechanism it could not prove", () => {
    const applied = applyConfinement(fixture.input, WINDOWS_HOST);
    expect(applied.confinement).toBeNull();
    expect(applied.unavailableReason).toMatch(/no OS-enforced filesystem boundary is implemented/);
    expect(applied.unavailableReason).toContain("win32");
    expect(confinementBoundaryAvailable(WINDOWS_HOST).available).toBe(false);
  });

  it("does not refuse on a linux host without bubblewrap installed", () => {
    const applied = applyConfinement(fixture.input, fakeLinuxHost({ installed: false }));
    expect(applied.confinement).toBeNull();
    expect(applied.unavailableReason).toMatch(/bubblewrap, but it is not installed here/);
  });

  it("treats an installed-but-unenforcing bubblewrap as no boundary, not as one", () => {
    // The real distro case: bwrap on PATH, unprivileged user namespaces off.
    // "The binary exists" is not an availability oracle on this platform, so
    // the engine executes the mechanism before it will name it.
    const applied = applyConfinement(
      fixture.input,
      fakeLinuxHost({ installed: true, hides: false }),
    );
    expect(applied.confinement).toBeNull();
    expect(applied.unavailableReason).toMatch(/bubblewrap is installed on this linux host/);
    expect(applied.unavailableReason).toMatch(/stayed readable under the bubblewrap policy/);
  });

  it("treats a boundary that severs the run's own carve-outs as no boundary", () => {
    // A policy that hides the vendor credential root along with the runtime
    // tree would "prove" a denial and break every subscription lane.
    const applied = applyConfinement(
      fixture.input,
      fakeLinuxHost({ installed: true, honorsBinds: false }),
    );
    expect(applied.confinement).toBeNull();
    expect(applied.unavailableReason).toMatch(/cut off the carve-outs the run needs/);
  });
});

describe("linux bubblewrap, when the host really enforces", () => {
  const fixture = scaffold();
  afterAll(() => rmSync(fixture.base, { recursive: true, force: true }));
  const host = fakeLinuxHost({ installed: true });

  it("names the mechanism together with the path it proved denied", () => {
    const applied = applyConfinement(fixture.input, host);
    expect(applied.unavailableReason).toBeNull();
    expect(applied.confinement?.mechanism).toBe("bubblewrap");
    expect(applied.confinement?.verified_denied_path).toContain(".claudexor");
    expect(applied.confinement?.profile_digest).toMatch(/^sha256:/);
  });

  it("hides the runtime tree and re-exposes only the run's own roots inside it", () => {
    const argv = JSON.parse(applyConfinement(fixture.input, host).confinement!.profile) as string[];
    expect(argv[0]).toBe(BWRAP);
    expect(argv.slice(1, 4)).toEqual(["--dev-bind", "/", "/"]);
    // Mount targets are realpath-resolved: a policy written against a symlinked
    // spelling would name something the kernel never matches.
    const real = (path: string) => realpathSync.native(path);
    const tmpfs = argv.filter((_, i) => argv[i - 1] === "--tmpfs");
    expect(tmpfs).toContain(real(fixture.input.runtimeRoot));
    expect(tmpfs).toContain(real(join(fixture.input.operatorHome, ".ssh")));
    // The scoped home and the vendor credential root live INSIDE the runtime
    // tree; without the carve-out the boundary would take the run's own state.
    const binds = argv.filter((_, i) => argv[i - 1] === "--bind");
    expect(binds).toContain(real(fixture.input.scopedHome));
    expect(binds).toContain(real(fixture.input.nativeStateRoot));
    // The worktree is outside every deny, so it needs no carve-out at all.
    expect(binds).not.toContain(real(fixture.input.worktree));
  });

  it("wraps the argv with the mechanism the record names, without branching on the OS", () => {
    const confinement = applyConfinement(fixture.input, host).confinement!;
    const invocation = confinedInvocation(confinement, "codex", ["exec"]);
    expect(invocation.bin).toBe(BWRAP);
    expect(invocation.args.slice(-2)).toEqual(["codex", "exec"]);
    expect(invocation.args).toContain("--tmpfs");
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

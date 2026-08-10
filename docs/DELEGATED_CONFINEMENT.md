# Delegated-run confinement — threat model

Status: **enforced on macOS (Seatbelt). Everywhere else there is NO kernel boundary — by
decision, not by omission — and the run proceeds on the scoped `HOME` with the absence
disclosed.** Owner: `packages/core/src/confinement.ts` (mechanism) and
`packages/orchestrator/src/delegatedHome.ts` (per-attempt decision + applied facts).

## 1. The actor

A run marked `execution.delegated` is driven by an EXTERNAL machine orchestrator (the "host")
that owns the workspace, not by a person at a Claudexor surface. When such a run is also
MUTATING (`mode: agent`, a write-capable access profile) the harness gives its model a real
shell inside the host's worktree. That shell is the actor this document is about. It is not
assumed hostile; it is assumed *uncontrolled* — its command stream is model output, and the
host cannot review each command before it runs.

## 2. What the actor must keep

Confinement that removes any of these is a regression, not a fix:

- a working shell in the run's worktree, with its own toolchain on `PATH` (node, pnpm, cargo,
  uv, git, the vendor CLI itself — all of which live at absolute paths under the operator's
  real home or under `/opt`);
- read and write of the worktree;
- write access to a scratch area (`TMPDIR`) and to its own scoped `HOME`;
- the vendor credential the attempt is already authenticated with, so a subscription lane keeps
  working;
- network, exactly as the run's web policy configures it. Confinement here is a FILESYSTEM
  boundary and takes no position on the network.

## 3. What the actor must never reach

- `~/.claudexor/v3/daemon/token` — a bearer for the ENTIRE `/v2` control API. A child that reads
  it can start its own runs at any access level, on any registered project, and every
  host-side authority derivation is then decoration. This is the critical.
- the rest of the daemon directory: `control-api.json` (host/port), the control socket, the
  journal.
- other projects' runtime state under the Claudexor runtime root — their scoped homes, their
  run artifacts, their trust records.
- the operator's own credential stores: `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.claude`, `~/.codex`,
  `~/.netrc`, `~/.npmrc`, and the rest of the set already classified by
  `packages/util/src/sensitive-resource.ts`. That file is the single owner of "what is
  sensitive"; the confinement deny set is DERIVED from it and never re-listed.

## 4. Reproduction of the pre-fix state (2026-08-03, live)

A run with `mode: agent`, `execution.isolation: live`, `access: workspace_write`, scoped to a
registered project, on the operator's own daemon, reported:

```
HOME=<operator-home>
CODEX_HOME=<operator-home>/.claudexor/v3/native/codex
TOKEN_READABLE=yes
TOKEN_BYTES=37
CANARY=CXI-CANARY-…                      (a file planted in ~/.claudexor/v3/daemon/)
CONTROLAPI={ "host": "127.0.0.1", "port": …, "tokenPath": "…/daemon/token" }
SSHDIR=agent,config,…
```

The child read a file inside the daemon directory, confirmed the token is readable, and learned
where the control API listens.

## 5. Why a scoped `HOME` is not the fix

`HOME=<scoped>` is a CONVENTION. It redirects `~`-relative lookups; it says nothing about
`<operator-home>/.claudexor/v3/daemon/token`. Every line of the reproduction above used an
absolute path. The scoped home remains valuable — it keeps vendor state out of the operator's
home and gives the confinement a place to allow — but it is not a boundary and must never be
reported as one.

## 6. Mechanisms considered

| Candidate | What it actually enforces | Verdict |
| --- | --- | --- |
| Scoped `HOME` env var | `~`-relative lookups only | Convention. Keep, do not rely on. |
| Harness-native deny rules (codex permission profile, claude `--disallowedTools`) | Varies per harness; claude's is a tool-name filter a `sh -c` defeats | Not uniformly enforceable; the engine could not prove it |
| Run-scoped credential broker (no long-lived token handed to the child) | Nothing here. The child does not need to be HANDED the token — it READS the operator's copy. A broker changes what we give out, not what is readable at a path | Does not address this threat |
| Separate uid | A real boundary | Needs root; the daemon runs as the operator |
| Container | A real boundary | Rebuilds the toolchain contract; violates §2 |
| **macOS Seatbelt (`sandbox-exec`)** | **Kernel-enforced per-path read/write denial on the process and every descendant** | **Chosen — macOS, and the only mechanism** |
| Linux bubblewrap / Landlock / user namespaces | A real boundary of the same class | **Declined by the owner.** Not deferred pending effort — decided. Non-macOS gets the scoped `HOME` plus a disclosed absence, and that is the whole design there. Do not add one back without the owner saying so |
| Windows (job objects, AppContainer, restricted tokens) | Nothing that denies *per path* to an arbitrary child without re-architecting the launch | **None.** Stated, not faked — see §6.1 |

### 6.1 A platform with no mechanism is not a refusal

Where no kernel boundary can be applied, the run WORKS and the absence is disclosed in three
places: the attempt record (`confinement_unavailable_reason`), the child's own prompt (an engine
notice stating there is no boundary and what that means for it), and the caller's result
(`candidates[].confinement`, whose `proven` is false and whose `unavailableReason` carries the
same sentence). Refusing instead would make `execution.delegated` a macOS-only feature wearing a
general name.

Three conditions still refuse, because they are Claudexor's own layout or this host's rather
than the platform's: an allowed root that would swallow a path the policy must deny; a host on
which NONE of the denied paths exists, so the policy cannot be proven to deny anything; and a
policy that the macOS mechanism failed to enforce when probed for one attempt.

What a non-macOS delegated mutating run therefore gets, in full: the scoped harness `HOME`
(unchanged), NO confinement mechanism recorded — no mechanism name, no denied path, no digest —
and `confinement_unavailable_reason` naming the platform. Nothing probes for a boundary, and
nothing is invented.

### The nesting constraint (measured, not assumed)

A process already under a RESTRICTIVE seatbelt cannot apply another one:

```
$ sandbox-exec -p '(version 1)(allow default)(deny file-read* (literal "/private/tmp/x"))' \
    /bin/bash -c 'sandbox-exec -p "(version 1)(allow default)" /bin/echo ok'
sandbox-exec: sandbox_apply: Operation not permitted
```

Any deny clause in the outer profile produces this; an outer `(allow default)` with no denies
nests fine. `codex` shells out to `/usr/bin/sandbox-exec` for its own `workspace-write`
sandbox, so an outer boundary and the harness's own sandbox are mutually exclusive on this OS.

Therefore, when Claudexor applies the boundary it must also tell the adapter to stand its own
sandbox down. That instruction already exists as a first-class access profile:
`external_sandbox_full` — the harness stands its own sandbox down. The engine does not branch
on a harness name to say this; it states the access profile, and each adapter already maps that
profile onto its own switch. The profile itself carries NO boundary: requested directly on a
non-delegated run it is honestly unrestricted — the engine applies its own OS boundary only on
the delegated path described here — and, unlike `full`, it is not behind the per-repo trust
allow.

## 7. The policy

Built by `buildConfinementProfile`. Every path is realpath-resolved first, because Seatbelt
matches resolved paths (`/tmp` is `/private/tmp`).

```
(version 1)
(allow default)                       ; nothing is restricted that §3 does not name
(deny file-read*  <claudexor runtime root + operator credential stores, from the
                   sensitive-resource owner — one directive, every subpath>)
(allow file-read-metadata <the native root's intermediate directories, LITERAL each,
                           dirname(native root) up to and including the runtime root>) ; §7.1
(allow file-read* <managed toolchain root, SUBPATH — only when it lies inside the
                   runtime root>)                                                      ; §7.2
(deny file-write* <system prefixes: /usr /opt /Library /Applications /System /bin /sbin /etc /var>)
(allow file-write* <TMPDIR>, /private/tmp)
(deny file-write* <operator real home>)
(allow file-read* file-write* <this run's scoped home>, <this run's worktree>,
                              <native vendor state root>)   ; see §8, one directive
```

SBPL is last-match-wins, so this ORDER IS THE POLICY, not presentation. Three placements carry
weight. The run's own roots come last because they must outrank every deny above them —
including the case where the worktree lives inside the operator's home (`isolation: live`,
which is exactly the delegated shape). The scratch allow deliberately sits ABOVE the
operator-home deny, not below it: a `TMPDIR` configured inside `$HOME` would otherwise re-open
the whole home for writing. And the two read carve-outs sit directly AFTER the read deny they
punch through, BEFORE the write section, so neither can outrank a write deny — see §7.1 and
§7.2.

### 7.1 The metadata traversal carve-out (canonicalize semantics)

codex calls Rust `fs::canonicalize` — libc `realpath(3)` — on its `CODEX_HOME`
(`<runtime root>/v3/native/codex` in the default layout) at startup, which lstat/readlinks every INTERMEDIATE path
component. The own-roots allow re-opens the native root's SUBTREE, but the components between
the runtime root and the native root (`<runtime root>` itself, and any directory between it and
the native root) still matched the read deny. Result, measured live 2026-08-10: EPERM,
`codex exited with code 1: failed to canonicalize CODEX_HOME`, within seconds, on 100% of
mutating delegated codex runs. Readonly/ask runs survived only because they get no confinement
at all, and claude survived because it never canonicalizes its home at startup.

The carve-out is deliberately the narrowest thing that fixes this: `file-read-metadata` on the
LITERAL resolved path of exactly those intermediate directories (`dirname(native root)` walking
up to and including the runtime root — two literals in the default layout, `<runtime root>/v3`
and `<runtime root>`; a `CLAUDEXOR_CONFIG_DIR` override collapses the chain to the runtime root
itself). Metadata means
stat/readlink/getattrlist of the directory entry: enough for `realpath(3)` to walk through. It
does NOT re-open file data anywhere under the runtime root, and it does NOT allow listing the
runtime root's contents — readdir is a data read on the directory, not metadata — both of which
the tests assert under a real `sandbox-exec`. The probe semantics are unchanged: the boundary is
still verified by reading the first denied path (`<runtime root>/daemon`), whose data read and
listing both stay denied.

Stated plainly, because it is the consequence operators actually hit: **a `TMPDIR` inside
`$HOME` is NOT writable under this policy** — the later home deny wins — unless that path also
falls inside one of the run's own roots. The macOS default (`/private/var/folders/…`) is
outside `$HOME` and is unaffected.

### 7.2 The managed-toolchain exec carve-out

In the DEFAULT layout the managed toolchain — the Node distribution Claudexor installs plus
the pinned vendor CLI shims — lives at `~/.claudexor/node`, INSIDE the runtime root the policy
denies. Exec is a read: the kernel must read the binary to execvp it, so the read deny made the
very binaries the spawn layer resolves for the child unrunnable. Measured live in the 3.3.15 VM
battery (default config, phase 13): `sandbox-exec: execvp() of
'<operator home>/.claudexor/node/bin/codex' failed: Operation not permitted`, exit 71, before
the harness ran a single instruction. §7.1's metadata allowance did not cover this — stat of a
path is not read of its bytes — and the development-host smoke missed it because scratch mode
relocates the config root, putting the toolchain outside the denied tree.

What is opened: `file-read*` on the SUBPATH of the managed toolchain root — data, metadata and
listings for the whole subtree, because execvp reads the shim, the `#!/usr/bin/env node`
interpreter line resolves the `node` binary beside it, and the shims are symlinks into
`lib/node_modules/**` payloads the CLI then loads. The subtree holds a Node distribution and
CLI shims; no secrets live there. The path is derived from the same helper the spawn layer's
PATH producer uses (`managedNodeRoot` in `packages/core/src/runtime-env.ts`), anchored on the
operator home, so the profile and the launcher cannot drift apart.

What stays denied: everything else under the runtime root — the daemon directory and token
data, directory listings of the runtime root itself, other projects' state — and WRITES to the
toolchain: the later operator-home write deny still covers it, so a confined child cannot
trojan the shims the operator's own daemon executes. An executable planted anywhere else under
the runtime root stays unrunnable; the tests pin both directions under a real `sandbox-exec`.

When the toolchain lies OUTSIDE the runtime root (the `CLAUDEXOR_CONFIG_DIR` override shape:
the override relocates the runtime root, never the HOME-anchored toolchain), no carve-out is
emitted — nothing denies the toolchain there, and `(allow default)` already covers it,
mirroring the native-root traversal pattern of §7.1.

There is no second policy. On every other platform `confinement_mechanism` is null,
`confinement_verified_denied_path` is null, and `confinement_unavailable_reason` says why.

## 8. What this does NOT cover

Stated plainly, because a boundary described as total is worse than a narrow one:

- **Not the vendor credential root.** `<runtime root>/native` is allowed for read and write:
  the harness authenticates its subscription lane out of that tree. A delegated child can
  therefore read the vendor session it is already running under — and also its SIBLINGS under
  the same root. Narrowing this to the attempt's own profile directory needs the resolved
  `credential_profile` transport threaded onto the confinement input. Named, not silent.
- **Not the network.** A child that obtains a control-API bearer by some other route can still
  reach `127.0.0.1`. The boundary removes the filesystem route to the token; it is not an
  egress control.
- **Not writes outside the operator home and outside the listed system prefixes.** A path such
  as `/Users/Shared` remains writable.
- **Not any platform but macOS.** Off macOS, a delegated MUTATING run is UNCONFINED — it runs on
  the scoped `HOME` alone, and says so in the three places §6.1 lists. It is never silently
  unconfined, and it never names a mechanism it did not prove. A caller that requires a boundary
  reads `proven` and decides for itself; the engine does not decide for it.
- **Not a claim about the harness's own sandbox.** Where Claudexor applies no boundary it also
  does not ask the harness to stand its native one down, so a codex lane keeps its
  `workspace-write` sandbox. That is a real protection and it is deliberately left in place — but
  it is the harness's, the engine cannot prove it, and so it is not reported as a boundary.
- **Not non-delegated runs.** An operator-driven run at a surface is unchanged. The operator
  reading their own home is not this threat.
- **Not `readonly` delegated runs.** They get no shell that can mutate, and they keep the
  harness's own read-only enforcement rather than standing it down.

## 9. Evidence, not intention

Asking for confinement is not evidence that it happened. Every attempt that reaches a harness
spawn records what was APPLIED:

- `harness_home_isolated` / `harness_home_dir` — the HOME the child actually got;
- `access_applied` — the access profile the ADAPTER received (`external_sandbox_full` when the
  external boundary is on), not the one the caller requested;
- `credential_profile_applied` — the resolved profile id, or `null` for the default ladder;
- `confinement_mechanism` + `confinement_profile_digest` + `confinement_verified_denied_path` —
  the policy was executed against a path it denies and the read was refused, on this host, for
  this attempt;
- `confinement_unavailable_reason` — why there was NO boundary, when there was none.

These are written on the SUCCESS path and on the FAILURE path, by one record builder, because
an attempt that crashed still ran a process and the caller still needs to know what that
process could see.

**A mechanism name is a claim; only the verified path discharges it.** `confinement_mechanism`
present WITHOUT `confinement_verified_denied_path` reads as *no boundary*, deliberately, and the
schema makes the pair inseparable so the engine cannot emit one half. `confinementBoundaryProven`
is the single owner of that question, spent by the terminal gate and by the caller-facing
projection alike; neither re-derives it, and neither branches on the mechanism's name or on the
platform.

A terminal MUTATING delegated run whose attempts carry NEITHER a proven confinement NOR a stated
reason there was none is an infrastructure refusal (`delegated_evidence_incomplete`), not a pass.
Missing evidence is unauditable. An honest "no boundary here, and here is why" is complete
evidence and terminalizes normally — that distinction is the whole of the gate.

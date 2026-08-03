# Delegated-run confinement — threat model

Status: **enforced where the kernel offers a boundary (macOS Seatbelt, Linux bubblewrap);
disclosed, not refused, where it does not (Windows today, and any host whose mechanism does not
work).** Owner: `packages/core/src/confinement.ts` (mechanisms) and
`packages/orchestrator/src/delegatedHome.ts` (per-attempt decision + applied facts). This
document is the reason the code exists; change it in the same commit as the code.

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
HOME=/Users/anton
CODEX_HOME=/Users/anton/.claudexor/v3/native/codex
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
`/Users/anton/.claudexor/v3/daemon/token`. Every line of the reproduction above used an
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
| **macOS Seatbelt (`sandbox-exec`)** | **Kernel-enforced per-path read/write denial on the process and every descendant** | **Chosen — macOS** |
| **Linux bubblewrap (`bwrap`)** | **A mount namespace: the host filesystem is bound through, then an empty tmpfs is mounted OVER each denied path, so no spelling reaches the contents. bwrap drops every capability before exec, so the child cannot unmount what the namespace's owner mounted** | **Chosen — Linux** |
| Linux Landlock (direct `landlock_restrict_self`) | The same class of boundary, without a helper binary | Not chosen: needs a native binding or a syscall shim, i.e. a new dependency. bubblewrap is already the packaged, widely-installed spelling of this |
| Windows (job objects, AppContainer, restricted tokens) | Nothing that denies *per path* to an arbitrary child process without re-architecting the launch | **None today.** Stated, not faked — see §6.2 |

### 6.1 Availability is measured, never assumed

"Is the binary installed" is a reliable oracle for Seatbelt and a bad one for bubblewrap: a
distro can ship `bwrap` and disable unprivileged user namespaces, and the binary is still there.
So the engine's availability question is answered by EXECUTING the mechanism against a throwaway
scaffold shaped like the real one, once per process, and requiring both halves:

- a path the policy denies must come back unreadable, and
- a carve-out NESTED INSIDE that denied path (the vendor credential root under the runtime tree)
  must come back readable — a boundary that also severs §2 is a capability regression, and it
  counts as "no boundary here" rather than shipping quietly.

A mechanism that fails either half is reported unavailable WITH THE REASON, and the run proceeds
unconfined and disclosed. This is also what keeps a wrong policy from bricking a platform: the
worst case of a mistake in the bubblewrap argv is a Linux host that runs unconfined and says so,
never one that cannot run a delegated mutating job at all.

### 6.2 A platform with no mechanism is not a refusal

Where no kernel boundary can be applied, the run WORKS and the absence is disclosed in three
places: the attempt record (`confinement_unavailable_reason`), the child's own prompt (an engine
notice stating there is no boundary and what that means for it), and the caller's result
(`candidates[].confinement`, whose `proven` is false and whose `unavailableReason` carries the
same sentence). Refusing instead would make `execution.delegated` a macOS-only feature wearing a
general name.

Two conditions still refuse, because they are Claudexor's fault rather than the platform's: an
allowed root that would swallow a path the policy must deny, and a policy that a *working*
mechanism failed to enforce for one attempt.

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
`external_sandbox_full` — "full access inside an external sandbox". The engine does not branch
on a harness name to say this; it states the access profile, and each adapter already maps that
profile onto its own switch.

## 7. The policy

Every path is realpath-resolved first, because both mechanisms match resolved paths (`/tmp` is
`/private/tmp`). The deny SET is one list (`confinementDeniedReadPaths`) shared by every
mechanism; only the encoding differs.

### macOS (SBPL, `buildConfinementProfile`)

```
(allow default)                       ; nothing is restricted that §3 does not name
(deny file-read*  <claudexor runtime root>)
(deny file-read*  <operator credential stores, from the sensitive-resource owner>)
(deny file-write* <operator real home>)
(deny file-write* <system prefixes: /usr /opt /Library /Applications /System /bin /sbin /etc /var>)
(allow file-read* file-write* <this run's scoped home>)
(allow file-read* file-write* <this run's worktree>)
(allow file-read* file-write* <native vendor state root>)   ; see §8
(allow file-read* file-write* <TMPDIR>, /private/tmp)
```

SBPL is last-match-wins, so the allow carve-outs deliberately follow the denies.

### Linux (bubblewrap argv)

```
bwrap --dev-bind / /                       ; the toolchain lives at absolute paths (§2)
      --tmpfs <each denied path>           ; the same deny set, whether or not it exists yet
      --bind <own root> <own root>         ; ONLY for a root a deny above would swallow
      <bin> <args…>
```

The policy recorded on the attempt is this exact argv prefix, JSON-encoded, and the digest is
taken over it — a mechanism whose policy is not text still records what the process was actually
started under. The `--bind` carve-outs are emitted only for the run's own roots that live INSIDE
a denied path (the scoped `HOME` and the vendor credential root both sit under the runtime tree);
the worktree is outside every deny and needs none.

### Windows

No mechanism. `confinement_mechanism` is null and `confinement_unavailable_reason` says so.

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
  as `/Users/Shared` remains writable. The Linux policy is narrower still: it denies READS of the
  listed paths and takes no position on writes elsewhere.
- **Not Windows, and not every Linux host.** Where no mechanism applies, a delegated MUTATING run
  is UNCONFINED — it runs, and says so in the three places §6.2 lists. It is never silently
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

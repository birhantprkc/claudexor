# Developing Claudexor

This document is for contributors changing Claudexor itself. It is not a guide for
using Claudexor on a target project. User-facing behavior belongs in the README
and the current runtime map belongs in `docs/ARCHITECTURE.md`.

Read these together before changing shared behavior:

- `CLAUDEXOR_BIBLE.md` - product and engineering invariants.
- `docs/ARCHITECTURE.md` - current package map, run flow, artifacts, and
  control API.
- `docs/WHITEPAPER.md` - public rationale and architecture narrative; keep it
  current when runtime, harness, auth/setup, observability, budget, orchestration,
  or permission behavior changes.
- `docs/DESIGN_SYSTEM.md` - macOS visual and interaction contract.
- `docs/CHECKLISTS.md` - human gates for reviews, releases, docs, visual QA,
  and security.

## Repository Shape

- `packages/schema` owns Zod schemas, TypeScript types, and generated JSON
  Schema. Change data contracts here first.
- `packages/util` owns shared helpers (ids, hashing, redaction, config dirs).
- `packages/core` owns adapter contracts, the shared CLI run loop, process
  helpers, typed errors, the doctor runner, and the stream conformance
  validator.
- `packages/orchestrator` owns the three canonical intent pipelines (ask, plan,
  agent) with their strategy flags (ask deep-scan, plan solo/council, agent
  race width, attempt caps, until-clean, create, delegate), plus run telemetry
  and policy gates.
- `packages/gateway` owns harness discovery, doctor output, and capability
  gating.
- `packages/harness-*` translate native CLI/API streams into typed events. They
  do not select winners, manage budgets, or decide review policy. Each has a
  `fixtures/` dir backing its conformance parity test.
- `packages/workspace` owns worktree envelopes, scoped harness homes, diff
  capture, and cleanup.
- `packages/policy` owns typed risk classification, protected-path rules, and
  the workspace path guard.
- `packages/context` owns the scope atlas and lazy ContextPack.
- `packages/config` owns layered config loading (global, project, user trust).
- `packages/review`, `packages/arbitration`, `packages/synthesis`,
  `packages/budget`, `packages/secrets`, and `packages/delivery` own their
  named control-plane subsystems.
- `packages/artifact-store` and `packages/event-log` own run artifact trees and
  the append-only event log.
- `packages/claudexor` is the bare-name bin wrapper over `@claudexor/cli`
  (the only package that installs the global `claudexor`/`claudexord` bins).
- `packages/cli`, `packages/daemon`, `packages/control-api`,
  `packages/mcp-server`, `packages/acp-server`, and `apps/macos` are surfaces.
  Keep them thin.
- `packages/canary` holds the canary golden stories: user-level E2E smokes
  over the built CLI with offline fake harnesses, pinned to Bible invariant
  tags (`pnpm canary`).
- `benchmarks/runner` holds the SWE-bench benchmark runner and is part of the
  pnpm workspace.

## Development Commands

Use the repository package manager and keep generated schema output checked.

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm typecheck:tests   # type-checks *.test.ts, schema scripts, and canary sources
pnpm test
pnpm schema:gen
git diff --exit-code packages/schema/generated
node scripts/validate-generated-schemas.mjs   # ajv-compiles every generated schema (draft-07)
pnpm docs:check    # docs-truth gate (endpoints / mode ids / CLI flags vs source)
pnpm staged:check  # staged-field gate (comments do not count as consumers)
pnpm knip          # dead exports / unused files / unused dependencies gate
node scripts/mcp-cli-parity-check.mjs # MCP tool args <-> CLI run-control flags parity (stale-schema class)
node scripts/artifact-text-parity-check.mjs # server SEMANTIC_TEXT_EXTENSIONS <-> Swift set parity (QA-067)
node scripts/fixture-freshness-check.mjs # fixture provenance manifests + recorded-vs-installed CLI drift
node scripts/complexity-ratchet.mjs   # readability ratchet: tracked files may only shrink
node scripts/model-hints-freshness.mjs # manifest known_models vs installed vendor CLIs (release: --strict)
pnpm canary        # canary golden stories (offline fake harnesses; needs pnpm build first)
```

There is no root `pnpm lint` script at the moment. `pnpm format:check` checks
Prettier formatting when a formatting pass is relevant. Note on Node versions:
`.node-version` pins the DEV toolchain (24.16.0, matching CI); the root
`engines.node >= 20.19.0` is the published-package compatibility floor — the
split is intentional, do not "reconcile" them. CI runs the full Node battery
on both 20.19.0 and 24.16.0; publication repeats a clean installed-package CLI
smoke on both versions before the GitHub Release becomes public.

macOS app checks:

```bash
cd apps/macos/ClaudexorKit && swift test
cd ../ClaudexorApp && swift test && swift build
```

Release verification is wrapped by:

```bash
pnpm release:verify
```

It runs Node/schema checks, Swift build/test checks, and local (unsigned)
app packaging. Public CI artifacts are fail-closed: all Apple signing and
notary secrets must be present, and both the app and DMG are signed,
notarized, stapled, and validated. App packaging also asserts that the separately bundled
setup-login runner exists and can start under the bundled Node; a daemon-only
bundle is incomplete.

The workflow has two explicit manual modes. `candidate` accepts only a full
40-character commit SHA and builds/signs/notarizes/attests without publishing.
After review, `publish` accepts only an annotated stable tag on the exact
`origin/main` commit plus a base64 signed review attestation. The workflow
verifies its Ed25519 signature against the pinned public release-review key
before reading any review claims, then recomputes the commit tree and
validates the current schemaVersion 6 payload. It binds the candidate
SHA/tree/version, exact `pnpm release:verify` receipt, sealed evidence
manifest/diff/wave, and exactly two operator reviewer reports (owner decision
2026-08-06: the pair runs as Cursor operator subagents — slot `fable` = one
slug from the owner-approved tier set {`claude-fable-5-thinking-max`,
`claude-fable-5-thinking-medium`} with the full context, slot `sol` = one slug
from {`gpt-5.6-sol-xhigh`, `gpt-5.6-sol-max`, `gpt-5.6-sol-medium`};
operator decision 2026-08-06 ~08:29 after two subagent-model catalog flaps
within one hour, amended 2026-08-07 when the catalog exposed only the
same-family `xhigh` Sol tier). The sealer
recomputes every evidence and report digest,
requires each slot's metadata to bind the exact packet identity, a model slug
inside the slot's owner-approved tier set (the actually used slug is what gets
sealed and signed; anything outside the set refuses fail-closed), exact ISO
start/finish of at least one second with
genuinely overlapping executions, the mandatory `review_scope: "full"`, and a
non-blocking `pass` or `warn`
verdict. The v6 attestation
seals the final confirmation pair; the initial review and adjudication remain
ledgered evidence. Panel composition and wave discipline
live only in `docs/CHECKLISTS.md`. Historical signed schemas 2 through 5 remain
cryptographically verifiable as archives but fail current semantic publish
validation.
Only after that authority check does the workflow promote the candidate run's
DMG, ZIP, and SBOM byte-for-byte instead of rebuilding the app; publish
generates only the signed runtime manifest, review attestation, and final
checksum set around those accepted bytes.
Missing signing/notary/npm credentials fail; there is no unsigned or
GitHub-only release fallback. npm
packages publish in dependency order with `--provenance`; a retry skips an
already-published package only when npm's signed SLSA provenance proves it was
built by this repository's release workflow on this exact tag and candidate
commit and its subject digest matches the published bytes (builds are not
byte-reproducible across CI runs, so local re-pack identity is required only
for fresh publishes); anything else is a version collision and fails. npm's
post-publish version and attestation endpoints are eventually consistent, so
both are polled with a bounded 10-minute window before failing loudly. The GitHub Release is a draft until macOS and npm complete,
uploads only absent assets, rejects differing same-name bytes, and becomes
public as the final mutation. The workflow never edits a published release and
does not claim platform-enforced immutability. Version bumps still go through
changesets (`pnpm changeset` + `pnpm version-packages`, fixed lockstep group).
The decoded review attestation is an envelope with a `schemaVersion`, pinned
`keyId`, `algorithm: "Ed25519"`, signed `payload`, and base64 `signature`; the
signature covers the schemaVersion, so the two contracts cannot be replayed
into each other. Schema 1, unsigned, unknown-key, and tampered inputs are
rejected.

The `publish` mode also carries a second signed input, the OWNER-SIGNED
runtime-update manifest (D-2), transported the same way as the review
attestation (base64 workflow-dispatch input). The candidate run builds the
engine-runtime closure and an UNSIGNED `runtime-manifest.json`; on a trusted
machine the owner signs it offline against the exact promoted-artifact digest:

```
# The candidate's unsigned manifest and the promoted runtime archive digest:
pnpm sign:runtime-manifest \
  --in       runtime-manifest.json \
  --sha256   <sha256 of the promoted claudexor-runtime-<v>.tar.gz> \
  --private-key ~/.claudexor/keys/runtime-update-ed25519.pem \
  --authority   release/runtime-update-authority.json \
  --out         runtime-manifest.signed.json
```

The private key is a dedicated OFFLINE Ed25519 key (SEPARATE from the
review-attestation key, never on CI); the signer refuses any unstamped/
placeholder field and self-verifies. Publish also takes the `candidate_run_id`
input (the candidate workflow run whose artifact is promoted): it downloads that
run's EXACT closure bytes (never a publish rebuild, A-5), verifies their build
provenance, then runs `scripts/verify-signed-runtime-manifest.mjs`, which ships
the signed manifest ONLY if its signature verifies against the pinned
`release/runtime-update-authority.json`, its `sha256` byte-matches the promoted
tarball, and its non-secret fields equal the candidate's unsigned manifest. A
wrong or expired (14-day artifact retention) run id fails the download.
Candidate runs publish nothing signed; only publish ships the signed manifest.
Rotate the key by minting a new keypair, bumping its `keyId`, and shipping the
new public half in a signed DMG.

The engine closure is also the supported host-embedding payload. Do not add a
second embed archive or trust root: `scripts/build-runtime-closure.mjs`
materializes contained package links from the already-gated app resources and
emits a regular-file/directory-only tarball for extractors without POSIX
symlink semantics. It rejects escaping links, special files, and `.node`
addons. Embedders keep one exact tested Node version plus
protocol/entrypoint/size in their reviewed pin; the npm `engines` range is not
closure-smoke evidence. The existing signed manifest is the publication
authority used to form that pin; runtime consumers may verify it directly or
rely on a review-bound exact URL/`buildSha`/SHA-256/size pin, without a second
manifest or verifier. The focused builder test must cover an internal link's
expected materialized bytes and an escaping-link refusal. A Windows claim also
requires a native extract/exact-Node probe/isolated handshake/graceful-stop
smoke; feature support must not be inferred from portable extraction alone.

The `publish` mode carries a THIRD signed input, `remote_runtime_manifest_b64`:
the OWNER-SIGNED four-target SSH runtime manifest, transported the same way.
The candidate run builds the four remote runtime archives
(`claudexor-remote-runtime-<v>-{linux-x64,linux-arm64,darwin-x64,darwin-arm64}.tar.gz`)
plus an UNSIGNED `remote-runtime-manifest.json`; the owner downloads the
promoted candidate assets and signs offline:

```
pnpm sign:remote-runtime-manifest \
  --in remote-runtime-manifest.json \
  --assets-dir <promoted-assets-dir> \
  --private-key ~/.claudexor/keys/runtime-update-ed25519.pem \
  --authority release/runtime-update-authority.json \
  --out remote-runtime-manifest.signed.json
```

`--in` is the candidate's unsigned manifest; `--assets-dir` is the directory
holding the four promoted
`claudexor-remote-runtime-<v>-<target>.tar.gz` archives.

The same OFFLINE runtime-update key signs both manifest kinds; domain
separation is the signed `kind` field (`claudexor-remote-runtime`), which the
engine manifest's signed bytes never contain. The signer refuses to read the
private key until all four exactly-named archives sit in `--assets-dir` as
nonempty regular files (no symlinks) whose digests match the unsigned
manifest. In the publish run the promoted candidate artifact is an exact
TWELVE-asset set (DMG, ZIP, app SBOM, SHA256SUMS, engine closure + unsigned
runtime manifest, four remote archives, unsigned remote manifest, remote
SBOM); one early `gh attestation verify` loop — the single provenance owner —
verifies every one of them against the candidate run before ANY later step
copies or extracts them. Publish then runs
`scripts/verify-signed-remote-runtime-manifest.mjs` (pinned-authority
signature, per-archive digest match against the promoted bytes, field equality
with the candidate's unsigned manifest), regenerates the remote SBOM
deterministically from the promoted unsigned manifest, `cmp`s it against the
provenance-verified candidate SBOM, and ships the CANDIDATE bytes (A-5).

The review process itself (panel composition, sealed packet contents, the
blocker contract, wave discipline) is defined ONCE, in `docs/CHECKLISTS.md`
(Release review protocol) — this file only covers the attestation transport.
Do not hand-author the attestation JSON. Run
`scripts/seal-owner-review-attestation.mjs` with the gate receipt
(`scripts/run-full-gate-receipt.mjs` runs `pnpm release:verify` and seals
it), the external sealed evidence directory, the external operator review
artifacts directory, the external 0600 private key, the tracked
`release/review-attestation-authority.json`, and a new external output path.
The artifacts directory holds exactly two reviewer directories (`01-fable/`,
`02-sol/`), each written by the Cursor operator after its review subagent
completed: `report.md` (the reviewer's complete markdown report) and an
exact-shape `metadata.json` binding the slot, the actually used model slug
(which must belong to that slot's owner-approved tier set), the
candidate SHA and tree, the packet manifest digest, the review wave UUID, the
`sha256:`-prefixed diff digest, exact ISO start/finish, a `pass|warn`
verdict, the mandatory `review_scope: "full"`, and the report's SHA-256:

```bash
node scripts/run-full-gate-receipt.mjs <external-gate-dir>

node scripts/seal-owner-review-attestation.mjs \
  --full-gate-receipt <external-gate-dir>/full-gate-receipt.json \
  --evidence-dir <sealed-evidence-dir> \
  --review-artifacts <operator-review-artifacts-dir> \
  --private-key ~/.claudexor/release-authority/v2.0.0/review-attestation-private.pem \
  --authority release/review-attestation-authority.json \
  --out <attestation.json> \
  --base64-out <attestation.b64>
```

The signer executes only receipt-bound candidate verifier bytes after the exact
full gate passes. That gate writes a tiny self-contained verifier and a copy of
the packaged app's self-contained `claudexor.bundle.cjs` beside the receipt in
an output directory outside the candidate and evidence/artifact trees, with
both byte digests in the receipt. The operator transport never executes the
copied CLI; it travels only as receipt-bound bytes. The sealer imports only
the verified verifier bytes, recomputes every evidence and artifact digest,
and refuses a missing, extra, malformed, or mismatched metadata field, a
non-overlapping pair, duplicate report bytes, or any verdict outside
`pass|warn`. Verdicts, models, intervals, and scope are operator-attested
metadata (see the owner amendment in `docs/CHECKLISTS.md`); the digest and
packet-identity bindings are what the sealer proves mechanically. A failed
frozen slot is not retried in place: rerun it with fresh artifacts and a
fresh wave. The retired native-harness transport (schema v5, protocol
`native-fable-full-sol-delta-v2`) and the older
packet-split OpenRouter transport and its broad coverage/runtime-bundle tools
are deleted, not fallback paths. Schemas 2-5 stay signature-verifiable only for
already-sealed historical evidence. Never put raw transcripts, the private
key, or secrets in the repository or workflow input.

Release review is cumulative and SHA-bound. First commit a clean candidate,
then freeze its exact tree. The panel reviews that frozen SHA against the
checklists and docs as described in `docs/CHECKLISTS.md` (Release review
protocol). Any tracked mutation makes every result stale and starts a new
freeze. Staged-diff review is not release authority, so the old per-commit
script and hook installer have been removed rather than retained as a
competing workflow.

RESTART `claudexord` AFTER REBUILDING: the daemon loads the engine at start
and serves that build until stopped — a long-lived daemon silently runs
pre-rebuild code (`claudexor daemon stop` and let the next command
auto-start it). This trap has silently invalidated dogfood runs; restart the
daemon after every rebuild.

### Local toolchain notes

The build scripts prefer machine-local toolchains when present and fall back to
the system ones, so CI and other machines work unchanged:

- On macOS, some setups kill ad-hoc-signed Homebrew Node during bundling.
  `apps/macos/scripts/build-app.sh` therefore prefers a notarized Node: set
  `CLAUDEXOR_NODE_BIN`, or place one under `~/.claudexor/node/bin` (probed
  automatically); otherwise it falls back to the `node` on `PATH`. That
  fallback is now a HARD FAIL, not a warning, when the selected Node links
  `libnode` dynamically (an `otool -L` check): a non-self-contained Node
  bundles a dead binary that crashes the packaged app, so the build stops and
  names the `CLAUDEXOR_NODE_BIN` remedy. CI is unaffected — the release
  workflow always sets `CLAUDEXOR_NODE_BIN`.
- If the Xcode Command Line Tools `swift-package` crashes with a dyld llbuild
  symbol error, use a Swiftly-managed toolchain
  (`PATH="$HOME/.swiftly/bin:$PATH" swift build`).
- `claudexor doctor` surfaces a non-gating advisory when the running Node is an
  at-risk Homebrew build on macOS; set `CLAUDEXOR_NODE_BIN` (or put a notarized
  Node first on `PATH`) to silence it. At run time the harness spawn PATH also
  prepends the directory of the Node the daemon itself runs on (the notarized
  app-bundled runtime), so a vendor CLI's inner login shell resolves that same
  working Node instead of an ad-hoc Homebrew one it would otherwise SIGKILL; see
  `docs/ARCHITECTURE.md`. The prepend is skipped when the daemon's own Node is
  the at-risk build.

### Deterministic / hermetic testing

Tests and local smokes must never touch real user state:

- Isolate global config, the daemon (token/socket/jobs/logs), trust files, and
  run artifacts by pointing `CLAUDEXOR_CONFIG_DIR` at a temp dir; isolate host
  plugin files by pointing `HOME` at a temp dir.
- Managed secrets always use the daemon-owned v2 0600 file store, so a
  disposable `CLAUDEXOR_CONFIG_DIR` fully contains test secret I/O. The public
  CLI cannot select a storage backend.
- Setup-job/runner tests inject filesystem, clock, launcher, process identity,
  signal, and timer dependencies and use temp roots only. They checksum the
  legacy registry before/after, exercise PID reuse and symlink/path fences, and
  never open Terminal or write `~/.claudexor`.
- The `fake-*` harnesses are the offline, keyless, deterministic fixtures
  (`--harness fake-success`, etc.); they are only selectable by explicit id and
  never enter automatic or reviewer pools. `fake-implement` additionally writes
  a real worktree file for producing intents, so the Agent write→apply and
  Create chains are exercisable with no real harness.
- Read-only run lookups (`inspect`, `apply`) connect to an already-running daemon
  but never auto-start one (a typo'd run id reports `no such run`); only acting
  paths (`agent`/`best-of`/`create`, `decision`) auto-start it. `daemon start` blocks
  until the daemon is actually ready, so a follow-up `status`/run can't race it.
- Real-harness dogfood lives in `scripts/real-harness-battery.mjs`. Its default
  scratch mode runs disposable repos under `~/.claudexor/dogfood`, with an
  isolated config root. It asserts engine-owned artifacts, quarantines repeated
  host/network transient failures as ENV, and must not target the Claudexor repo
  for harness writes.
- A credentialed disposable VM may opt into the existing default login state:

  ```bash
  CLAUDEXOR_BATTERY_CONFIG_DIR="$HOME/.claudexor/v3" \
  CLAUDEXOR_BATTERY_DIR="$HOME/claudexor-dogfood/repo/battery-$(git rev-parse --short=12 HEAD)-$(date -u +%Y%m%dT%H%M%SZ)" \
    pnpm battery:real
  ```

  This mode accepts only the canonical default config path and requires the
  battery directory outside both `~/.claudexor` and the source checkout. It
  deliberately does not export `CLAUDEXOR_CONFIG_DIR`. The battery entrypoint
  itself first forces every workspace build (no Turbo cache), then dynamically
  loads the resulting dist modules and records the launched daemon entry digest
  beside its exact version/SHA/entry handshake. The
  lane refuses a pre-existing daemon, stops only the identity-bound daemon it
  started, keeps `config.yaml` byte- and mode-identical, and revokes its
  temporary disposable-repo full-access grant. Every Codex and
  Claude task attempt in the daemon's complete new-job inventory must disclose
  `local_session` from `native_session`; an API fallback or undisclosed route
  fails this VM acceptance, while Cursor retains its declared credential
  transport. The lane is strict: FAIL, ENV, or SKIP greater than zero, a phase
  filter, or omission of Codex, Claude, or Cursor makes the acceptance run fail.
  The single-family convergence refusal probe matches its canonical top-level
  failed status/message; nested RunFacts fields or incidental prose cannot
  satisfy that assertion.
  The build proof has no caller-supplied sentinel: every invocation owns and awaits
  the forced build before battery code can load. Never use the lane on the
  credential-free pristine VM or on a config root with live work.
- Runtime retry/review knobs are user-global config (`runtime.transient_retry`
  and `runtime.reviewer_timeout_ms`) with env overrides
  `CLAUDEXOR_TRANSIENT_RETRY_MAX`,
  `CLAUDEXOR_TRANSIENT_RETRY_INITIAL_DELAY_MS`,
  `CLAUDEXOR_TRANSIENT_RETRY_MAX_DELAY_MS`, and
  `CLAUDEXOR_REVIEWER_TIMEOUT_MS`.

## Schema-First Workflow

Any change to modes, DTOs, artifacts, events, config, run control, auth,
routing, review, or delivery must start in `packages/schema`.

1. Update the schema and exported types.
2. Regenerate JSON Schema with `pnpm schema:gen`.
3. Update TypeScript consumers.
4. Update Swift DTOs when the control API payload changes.
5. Update README, Architecture, Integrations, Design System, or app docs when
   behavior changes.
6. Add or update focused tests for the behavior.

Do not fork contracts in UI code, CLI parsing, adapter output, or docs. Run
`pnpm docs:check` in the same change: its small retired-contract inventory is a
ratchet, so removing or replacing a product surface also removes every stale
positive promise instead of relying on a one-time documentation cleanup.

## Boundaries

- Adapters translate I/O only. They never orchestrate.
- Surfaces call the engine/control plane. They do not create app-only semantics.
- Routing and capability decisions come from Gateway/doctor/capability data.
- Discovery can describe static capabilities and auth source availability, but
  readiness comes from doctor status, enabled intents, and smoke/conformance
  checks. Do not route, mark Auth UI ready, or select reviewers from source
  availability alone.
- A native-login success assertion requires the journaled hash-bound vendor
  result, a fresh source-targeted probe, and an isolated same-harness capability
  smoke on the exact native route; process exit, browser confirmation, manifest
  capability, another provider, or an API key alone is insufficient. Readiness
  mapping
  is stable across adapters: absent/logged-out = `unavailable + not_run`, probe
  failure = `unknown + not_run`, and present-but-unusable = `available + failed`.
- Native session transport remains vendor-owned. Codex uses a
  Claudexor-dedicated `CODEX_HOME` with the vendor's file credential store forced,
  never the operator's ordinary Codex home or OS Keychain. Claude uses a
  Claudexor-owned `CLAUDE_CONFIG_DIR`; only its disposable child HOME bridges
  the macOS login Keychain so the vendor can read the item keyed by that dir.
  Cursor uses its Keychain-backed state. Do not read or copy those credential
  files/tokens into Claudexor state or an envelope. API keys and the
  Claude setup-token are separate secret-store/env routes with separate typed
  source evidence.
- Browser MCP is an exact production dependency of `@claudexor/core`. App
  packaging uses `pnpm deploy --legacy --prod` to place that pinned runtime
  beside the daemon and runs its help entrypoint under the app's bundled Node
  with an empty environment. Do not restore runtime `npx`, `@latest`, or a
  package-manager override.
- Diffs come from git in the target workspace or envelope.
- Files and typed artifacts are the source of truth; terminal text and UI rows
  are projections.
- Unknown modes, invalid config, unavailable harnesses, stale reviews, malformed
  artifacts, and missing required context should fail loudly.

## Public Docs Discipline

Public docs describe current product truth, current contributor workflow, or
current integration surfaces. They must not store private planning packets,
review transcripts, local operator notes, local paths, token handling details, or
one-off release scratch.

Use this split:

- `README.md`: product entrypoint and detailed quickstart.
- `docs/AGENT_ONBOARDING.md`: external-agent orientation (machine-readable
  surfaces, decision tree, recovery).
- `docs/FEATURES.md`: status ledger of non-solid features (empty = healthy;
  update or delete a row in the same commit that changes the feature).
- `CLAUDEXOR_BIBLE.md`: compact product constitution.
- `docs/ARCHITECTURE.md`: current runtime and package map.
- `docs/INTEGRATIONS.md`: current external integration surfaces and limitations.
- `docs/DESIGN_SYSTEM.md`: macOS UI/UX contract.
- `docs/WHITEPAPER.md`: public rationale and conceptual model.
- `docs/DEVELOPMENT.md`: developing Claudexor itself.
- `docs/CHECKLISTS.md`: human gates for changes and releases.
- `apps/macos/README.md`: macOS app contributor notes.

Local operator guidance belongs in gitignored local files such as `AGENTS.md`.
Temporary adversarial review packets and release scratch belong outside public
docs. Review gates must be file-backed and diagnosable: persist local/redacted
per-reviewer artifacts and progress events, and point reviewers at evidence
files instead of embedding large diffs in process argv.

## Governance Rules

Do not implement risk, permission, tool success, web-required detection,
winner selection, or tests-passed decisions with regex checks over model prose.
Use typed schema fields, settings/profiles, normalized events, run artifacts,
deterministic gates, and reviewer evidence.

Runtime/harness/auth/setup/observability/budget/orchestration changes must update
the public docs that describe them, including `docs/WHITEPAPER.md` when the
conceptual model or product guarantees change.

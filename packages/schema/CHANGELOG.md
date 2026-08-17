# @claudexor/schema

## 3.5.0

### Patch Changes

- Updated dependencies [2316ef8]
  - @claudexor/util@3.5.0

## 3.4.2

### Patch Changes

- @claudexor/util@3.4.2

## 3.4.1

### Patch Changes

- @claudexor/util@3.4.1

## 3.4.0

### Patch Changes

- @claudexor/util@3.4.0

## 3.3.16

### Patch Changes

- @claudexor/util@3.3.16

## 3.3.15

### Patch Changes

- @claudexor/util@3.3.15

## 3.3.14

### Patch Changes

- @claudexor/util@3.3.14

## 3.3.13

### Patch Changes

- @claudexor/util@3.3.13

## 3.3.12

### Patch Changes

- @claudexor/util@3.3.12

## 3.3.0

### Patch Changes

- @claudexor/util@3.3.0

## 3.2.1

### Patch Changes

- Carry optional model applicability on vendor quota constraints, live rate-limit signals, and budget observations.
- @claudexor/util@3.2.1

## 3.2.0

### Patch Changes

- Add shared contracts for nullable interaction waits, run applicability and Git capability, atomic credential snapshots, durable problems, and canonical run strategy and presentation truth.
- Remove the unproduced `WorkProduct.evidence_dir` placeholder; evidence paths remain owned by concrete run and review receipts.
- Add the optional sealed relative permit window used by deferred client-PTY
  setup runners after a deadline extension.
- Keep frozen plan references server-owned at the thread-turn boundary and carry
  the deciding credential profile in the run auth-route receipt.
- Reject transient device-code projections outside an active Codex login that
  is awaiting the user.
- @claudexor/util@3.2.0

## 3.1.2

### Patch Changes

- Restore Delegate in packaged installs through the exact daemon self-entry; enforce required MCP startup, bounded shared parent/child budget and cancellation authority, typed lineage and degradation receipts, and durable CLI/macOS projections across reload and reconnect.
  - @claudexor/util@3.1.2

## 3.1.1

### Patch Changes

- Effort ladders are per (harness, model) and follow the vendor-advertised order.
  Levels are discovered live from each CLI (with a snapshot fallback when a probe
  is unavailable), the full official vocabularies are supported, and a level the
  run cannot honor is disclosed instead of silently clamped. A profile-scoped run
  is no longer held to the default account's ladder, and hint-less runs resolve
  against the default model's own ladder.
  - @claudexor/util@3.1.1

## 3.1.0

### Minor Changes

- c3b7ece: Support declared JSON Schema draft-07 and draft 2020-12 output contracts, publish the supported dialect catalog, and record the selected dialect plus stable schema hash in structured-output receipts. Local JSON Pointer references are inlined only for native provider transport while the original schema remains the validation authority.

### Patch Changes

- @claudexor/util@3.1.0

## 3.0.3

### Patch Changes

- @claudexor/util@3.0.3

## 3.0.0

### Patch Changes

- @claudexor/util@3.0.0

## 2.1.3

### Patch Changes

- @claudexor/util@2.1.3

## 2.1.2

### Patch Changes

- @claudexor/util@2.1.2

## 2.1.1

### Patch Changes

- @claudexor/util@2.1.1

## 2.1.0

### Minor Changes

- Claudexor 2.1.0: credential profiles (INV-135). Multiple subscriptions per
  harness with isolated vendor config dirs and namespaced secret slots; strict
  per-turn / thread-sticky selection with profile-isolated native-session
  resume; per-profile doctor probes and proactive per-profile subscription
  quota from the vendor oauth/usage endpoint; one typed profile policy per
  harness with provenance-recorded rotation on typed vendor-limit evidence
  only. Includes the unpublished 2.0.1 honest-engine and 2.0.2 simple-UI
  passes.

### Patch Changes

- 0fc050b: Credential profiles (INV-135): durable non-secret `credential_profiles`
  registry in the global config; the orchestrator resolves an explicit per-run
  profile id ONCE and stamps the typed profile on every HarnessRunSpec; adapters
  consume exactly the profile's transport (claude config-dir login / non-bare
  token / key; codex scoped CODEX_HOME / scoped auth.json; cursor, opencode,
  raw-api secret-ref keys) or refuse typed — never a fallback to default
  credentials. Namespaced secret slots (`claude_oauth:<profile>`), per-profile
  doctor probes (`GET /credential-profiles`, `claudexor profiles`), interactive
  `claudexor profiles login`, profile-stamped route evidence, and
  profile-isolated native-session resume.

## 2.0.2

## 2.0.1

## 2.0.0

## 0.15.0

See the root CHANGELOG.md v0.15.0 entry (stabilization program release: concept freeze, model governance, run honesty, routing/output reality, per-commit review gate, MCP/ACP surface upgrade + integration suite).

## 0.14.1

### Patch Changes

- Stabilize the checkpoint release with explicit reviewer-panel hardening, mandatory
  review evidence preflight, scoped Cursor reviewer readiness, frozen SpecPack gate
  merging, protected-path approvals, and thin control/macOS projection parity.
- Add `TaskContract.constraints.auto_protected_paths` so per-run approvals can
  narrow engine-derived gate/test protections without weakening spec/config-owned
  `protected_paths`.

## 0.14.0

## 0.13.3

## 0.12.1

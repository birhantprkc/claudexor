---
"@claudexor/schema": minor
"@claudexor/orchestrator": minor
"@claudexor/cli": minor
"@claudexor/daemon": minor
"@claudexor/control-api": minor
"@claudexor/workspace": minor
"@claudexor/harness-claude": minor
"@claudexor/harness-codex": minor
"@claudexor/harness-cursor": minor
---

Unified account model (INV-135 rewrite, owner-approved). Every account is a
named registry row — the separate "default"/"CLI login" account type is gone.
A detected legacy claude/codex default-store login auto-registers at daemon
start as the ordinary `<harness>-default` row through a crash-recoverable
migration (typed per-harness run refusal while incomplete; rollback command
as the supported downgrade path). Unpinned runs route through a quota-aware
pool of enabled+ready rows with sticky, disclosed thread bindings; explicit
pins are strict (typed `subscription_window_exhausted` refusal, no silent
rotation); pool exhaustion falls to the explicit, disclosed API-key route
under a paid-permitting preference. New wire: additive `accountPools` pool
authority plus `GET /v2/account-pools` (the feature marker) and
`POST /v2/accounts-migration/rollback`; `harnessAccounts` stays on the wire
as `[]` for legacy strict clients. Cursor host-Keychain logins are retired:
every cursor account lives in an isolated vendor file-store row, and
`auth login` becomes bootstrap sugar into the `<harness>-default` row.
Deleting a row is provable (typed retryable error on partial cleanup) and
retires migrated legacy aliases in the same operation.

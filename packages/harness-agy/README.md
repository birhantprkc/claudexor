# @claudexor/harness-agy

Adapter for Google's Antigravity CLI (`agy`): translates
`agy -p --output-format stream-json` into typed `HarnessEvent`s.

Accounts are NAMED credential profiles only (there is no engine-default agy
credential): each profile is a Claudexor-owned HOME whose vendor config root
(`$HOME/.gemini/...`) holds a file-based OAuth token. See
`src/profile.ts` for the mechanism and its constraints (never create a
keychain inside a profile HOME).

Fixtures under `fixtures/` pin the recorded 1.1.13 stream shapes; see
`fixtures/manifest.yaml` for provenance and stream-semantics expectations.

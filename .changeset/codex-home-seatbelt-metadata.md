---
"claudexor": patch
---

Fix the crash that killed every mutating delegated codex run on macOS: codex
canonicalizes its CODEX_HOME at startup (`realpath(3)` lstat/readlinks every
intermediate path component), and the Seatbelt profile's runtime-root read deny
covered the components between the runtime root and the allowed native state
root — EPERM, `failed to canonicalize CODEX_HOME`, `route.transient.exhausted:
process_crash` within seconds. The profile now carries a literal, metadata-only
(`file-read-metadata`) allowance for exactly that ancestor chain, placed after
the deny it punches through. File data under the runtime root and directory
listings (readdir is a data read) stay denied, and the boundary probe semantics
are unchanged; two-sided sandbox-exec tests and a real-harness battery phase
(13: delegated mutating codex under the boundary) pin both directions.

---
"claudexor": patch
---

Fix the crash that killed every mutating delegated cursor run on macOS: cursor-agent
keeps its chat store in SQLite under the scoped HOME, SQLite canonicalizes the database
path on open (`realpath(3)` lstat/readlinks every intermediate path component), and the
Seatbelt profile's runtime-root read deny covered the components between the runtime
root and the allowed scoped home — SQLITE_CANTOPEN, `RetriableError: [internal] unable
to open database file`, within seconds. This is the same class the CODEX_HOME fix
closed for the native state root, so the metadata traversal carve-out now covers the
union of EVERY own root's denied ancestors (scoped home, worktree, native state root):
literal, metadata-only (`file-read-metadata`), placed after the deny it punches
through. File data under the runtime root, sibling projects, and directory listings
(readdir is a data read) stay denied, and the boundary probe semantics are unchanged;
two-sided sandbox-exec tests — including a cursor-shaped SQLite open+WAL write and its
pre-fix reproduction with the carve-out stripped — and a second real-harness battery
phase-13 case (delegated mutating cursor under the boundary, capability-checked against
the real repo mutation and its green test gate) pin both directions.

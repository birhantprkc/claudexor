---
"@claudexor/journal": patch
"@claudexor/daemon": patch
---

Reduce journal startup work by selecting projection record types before copying payloads and validating run-event projections once during creation. Stop compression at the existing frame output limit while preserving full history, recovery checks, and compaction maintenance.

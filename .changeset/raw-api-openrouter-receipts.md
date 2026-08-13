---
"claudexor": patch
---

Preserve the built-in OpenRouter instance's finite non-negative `usage.cost`,
including zero, as an exact USD account charge receipt while keeping generic
raw-api cost unknown. Treat explicit terminal provider-error completions as
failures with safe typed error, usage, and completion evidence, never as
deliverable messages or patches; ordinary stop and length completions remain
successful.

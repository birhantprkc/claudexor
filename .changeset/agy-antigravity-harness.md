---
"@claudexor/harness-agy": minor
"@claudexor/schema": minor
"@claudexor/util": minor
"@claudexor/cli": minor
---

Add the Antigravity CLI (`agy`) as a harness, so a Google AI Pro/Ultra
subscription runs through Claudexor like the other vendor CLIs.

Named Google identities are Claudexor-owned profile HOMEs (`config_dir_login`),
so several subscriptions stay signed in side by side without touching the
operator's real home or login keychain. `claudexor quota` reads each profile's
own `/quota` windows, and the windows are model-scoped: exhausting the Gemini
budget does not block the account's Claude/GPT slugs. `claudexor harness
install agy` downloads Google's official installer in full, prints its size and
sha256, and runs the file you were shown — it is never piped into a shell.

The vendor exposes no config-dir environment variable, so the profile HOME also
holds its conversation and cache state, and it publishes no machine-readable
account identity — both are disclosed rather than papered over. Windows support
is best effort in this release.

---
"claudexor": minor
---

Add remote SSH execution: a thread can bind to a concrete `~/.ssh/config` host, where the app installs a signed remote runtime (Ed25519 manifest binding four platform archives with pinned Node digests, atomic activate/rollback, no sudo) and drives the complete engine through a loopback SSH forward. Authentication stays with the system `/usr/bin/ssh`; interactive auth runs in an ephemeral PTY and nothing is persisted. Remote browsing lists only visible home-contained directories, remote image links serve magic-byte-validated raster images scoped to a registered project, and both endpoints are served only by the remote runtime (a local daemon leaves them unwired and answers 501). The release pipeline builds, attests, and publishes the remote-runtime archives, manifest, and SBOM as first-class release assets.

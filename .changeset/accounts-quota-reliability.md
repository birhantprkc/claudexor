---
"claudexor": patch
---

Make Accounts usable at scale: keep the header fixed above a bounded scroller,
show Cursor email identities, separate cached account hydration from explicit
provider refresh, retain last-known quota with honest stale/error state, and
render server-owned model-scoped availability without promoting a scoped limit
to account-wide exhaustion. Stabilize daemon quota demand and pacing, recover
large compacted journals without unbounded argument spreads, pin inline-secret
ingress coverage, and confine browser artifacts to marker-owned run subtrees.

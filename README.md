# Cairn Gateway (provisional internal name)

The independently accepted Stage 0 fixture is exact commit
`25ee6526f683fbd4aa1e955b93c3eb3adf53211d`. It remains an immutable 90-test, offline-only provenance
base, not a deployable or rollback revision.

Stage 1A adds only adapter-neutral durable-authority contracts and an offline file-backed reference
conformance harness. The reference adapter qualifies the 24-scenario contract; it is not a selected
production database. `deno task check:stage0` preserves the exact Stage 0 denominator and coverage
floors (84.0% branch, 96.3% function, 90.6% line). `deno task check:stage1` runs exactly 24 durable
scenarios. `deno task check` is the exact 114-case offline gate with zero skips.

No listener, live adapter, credential or environment access, remote import, vendor request,
deployment, UI, Git remote, or provider resource exists. Storage, production key custody, MCP SDK
and named clients, callback topology, revocation promise, and retention remain unresolved activation
blockers. Stage 1A proves at-most-once dispatch authorization, not external exactly-once execution;
`unknown_commit` and `dispatch_unknown` are durable ambiguity states and are never automatically
retried.

Requires exact Deno 2.9.0. No network or package changes are needed.

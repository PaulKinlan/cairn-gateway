# Cairn Gateway (provisional internal name)

The independently accepted Stage 0 fixture is exact commit
`25ee6526f683fbd4aa1e955b93c3eb3adf53211d`. It remains an immutable 90-test, offline-only provenance
base, not a deployable or rollback revision.

Stage 1A adds only adapter-neutral durable-authority contracts and an offline file-backed reference
conformance harness. The reference adapter qualifies the 24-scenario contract; it is not a selected
production database. `deno task check:stage0` preserves the exact Stage 0 denominator and coverage
floors (84.0% branch, 96.3% function, 90.6% line). `deno task check:stage1` runs exactly 24 durable
scenarios. The Stage 1 denominator consumes actual JUnit execution names and rejects missing,
duplicate, skipped, ignored, filtered, or failed events. `deno task check` is the exact 114-case
offline gate with zero skips.

No listener, live adapter, credential or environment access, remote import, vendor request,
deployment, UI, Git remote, or provider resource exists. Storage, production key custody, MCP SDK
and named clients, callback topology, revocation promise, and retention remain unresolved activation
blockers. Stage 1A qualifies an opaque durable `reserved` → `dispatching` permit claim followed by
adapter-neutral atomic `startDispatch` consumption; only that one-use result authorizes dispatch.
The same neutral envelope and maintenance interface cover export, inspection, restore, migration,
and recovery behind explicit privileged maintenance context. The candidate-factory conformance path
also exercises abrupt worker death while holding the logical file lock and bounded stale-lock
recovery. This remains test-only logical commit evidence, not filesystem fsync/power-loss durability
or external exactly-once execution; `unknown_commit` and `dispatch_unknown` are durable ambiguity
states and are never automatically retried. Concrete seed/view helpers are isolated behind the
fixture driver.

Requires exact Deno 2.9.0. No network or package changes are needed.

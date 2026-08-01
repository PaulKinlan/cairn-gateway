# Activation gates

## Frozen evidence

- Accepted Stage 0 base: `25ee6526f683fbd4aa1e955b93c3eb3adf53211d`.
- Stage 0 denominator: exactly 90 unchanged tests, zero skipped.
- Stage 0 coverage floors: 84.0% branch, 96.3% function, 90.6% line.
- Stage 1A denominator: exactly 24 IDs (`DUR-01`…`DUR-24`), zero skipped.
- Combined offline gate: exactly 114 cases.

## Stage 1A qualified boundary

The offline reference adapter demonstrates the contract across independent Deno processes and disk
restarts. It uses atomic lock/write/rename only as test machinery and is not production storage
evidence. Invocation authorization validates tenant/owner, subject status and monotonic versions,
consumes both nonces and JTI, and reserves one attempt in one commit. Only `reserved` grants a
single dispatch permit. `unknown_commit` and `dispatch_unknown` never trigger automatic retry.
Challenges, enrollment mutation, revocation, replay, reservation, and attempt transitions are
atomic. Schema, migration, record, authority, replay, and revocation generations are monotonic;
stale restore and clock rollback fail closed.

## Still blocked

No live activation until separately selected and reviewed: durable database semantics/limits/region,
backup and restore, capability/device key custody, named MCP clients and official transport,
callback authority, vendor custody/key scope, revocation promise, receipt retention/deletion, and
incident hold. Stage 1A adds no listener, vendor, credential, environment, fetch, remote import, UI,
deploy configuration, or Git remote. It makes no external exactly-once claim.

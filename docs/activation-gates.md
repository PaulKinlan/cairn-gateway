# Activation gates

## Frozen evidence

- Accepted Stage 0 base: `25ee6526f683fbd4aa1e955b93c3eb3adf53211d`.
- Stage 0 denominator: exactly 90 unchanged tests, zero skipped.
- Stage 0 coverage floors: 84.0% branch, 96.3% function, 90.6% line.
- Stage 1A denominator: exactly 24 executed names (`DUR-01`…`DUR-24`), zero duplicate, skipped,
  ignored, filtered, failed, or unregistered events.
- Combined offline gate: exactly 114 cases.

## Stage 1A qualified boundary

The offline reference adapter demonstrates the contract across independent Deno processes and disk
restarts. It uses atomic lock/write/rename only as test machinery and is not production storage
evidence. Invocation authorization validates tenant/owner, device-agent and complete
grant/connection metadata bindings, durable grant/replay expiry, subject status, and monotonic
versions; it consumes both nonces and JTI and reserves one attempt in one commit. Reservation does
not dispatch; only a subsequent atomic `reserved` → `dispatching` claim returns an opaque permit,
and only adapter-neutral atomic `startDispatch` consumption returns connector dispatch
authorization. The permit hash/binding and one dispatch-start marker/count are part of the neutral
envelope. Both claim and start revalidate the graph and expiry so later revocation/expiry denies
dispatch. `unknown_commit` and `dispatch_unknown` never trigger automatic retry. Purpose-bound
bootstrap, enrollment, approval, and removal ceremonies recompute the canonical mutation hash,
derive JWK thumbprints, enforce epoch/namespace continuity, consume challenges once, and atomically
preserve cross-record enrollment history through later device revocation. The persisted effective
clock governs replay and every challenge. Snapshot, inspection, initialization, restore, migration,
and recovery scenarios use the adapter-neutral maintenance interface and the same persisted
`DurableAuthorityEnvelope`. Schema, migration, record, authority, replay, revocation,
subject/identity, attempt, enrollment, ceremony, and ownership state is monotonic; partial
migration, higher-outer-version logical rollback, stale restore, per-record deletion/rollback,
nested corruption, and clock rollback fail closed. The unchanged conformance path uses a candidate
adapter factory; concrete seed/view helpers remain behind its explicitly fixture-only driver. Crash
scenarios use abrupt worker exit while holding the lock and bounded stale lock recovery. They
qualify logical commit boundaries only: there is still no fsync or power-loss claim. Whole-authority
maintenance carries explicit tenant audit and closed privilege context.

## Still blocked

No live activation until separately selected and reviewed: durable database semantics/limits/region,
backup and restore, capability/device key custody, named MCP clients and official transport,
callback authority, vendor custody/key scope, revocation promise, receipt retention/deletion, and
incident hold. Stage 1A adds no listener, vendor, credential, environment, fetch, remote import, UI,
deploy configuration, or Git remote. It makes no external exactly-once claim.

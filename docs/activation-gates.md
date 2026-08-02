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
derive JWK thumbprints, enforce the 600-second enrollment-request bound and initial epoch-1
continuity, consume challenges once, and atomically preserve immutable enrollment linkage through
later agent/device revocation. Disabled or revoked authority may reactivate only at its exact next
logical version. The persisted effective clock governs replay and every challenge. Snapshot,
inspection, initialization, restore, migration, and recovery scenarios use the adapter-neutral
maintenance interface and the same persisted `DurableAuthorityEnvelope`. Schema, migration, record,
authority, replay, revocation, subject/identity, attempt, enrollment, ceremony, and ownership state
is monotonic; partial migration, higher-outer-version logical rollback, stale restore, per-record
deletion/rollback, nested corruption, and clock rollback fail closed. The unchanged conformance path
uses a candidate adapter factory; concrete seed/view/issuer helpers remain behind its explicitly
fixture-only driver. Crash scenarios use abrupt worker exit while holding a lock acquired by an
atomic hard link whose complete owner record was prepared first, plus bounded dead-owner recovery.
They qualify logical commit boundaries only: there is still no fsync or power-loss claim.
Maintenance uses opaque issuer identity bound to actor and exact operation purpose. Tenant-scoped
capabilities export, inspect, or restore only one owner partition in the global envelope; they
cannot observe another tenant, initialize the global store, or enter schema migration. A separately
issued unforgeable authority scope performs schema-wide migration/recovery and may maintain a whole
envelope; no forgeable tenant sentinel grants that scope. Captured authority primordials preserve
capability identity, tenant isolation, canonical decisions, and recursive snapshot freezing after
post-import intrinsic replacement. Active connection subjects and grant bindings require inverse
standalone connection/custody linkage matching owner, agent, device, and workload. Unsupported
migration targets are rejected before any preparing/committing transition is persisted.

## Still blocked

Deno KV was selected for M2 on 2026-08-02, but selection is not qualification. No live activation
until the exact adapter/topology passes the unchanged 24 scenarios and proves atomic/value limits,
strong-read/CAS behavior, ambiguity handling, hosted US storage/transit acceptance, backup and
restore, and receipt retention/deletion. Capability/device key custody, named MCP clients and
official transport, callback authority, vendor custody/key scope, revocation promise, and incident
hold also remain blocked. Stage 1A adds no listener, vendor, credential, environment, fetch, remote
import, UI, deploy configuration, or Git remote. It makes no external exactly-once claim.

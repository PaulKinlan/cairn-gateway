# ADR 0003: Durable authority contract (adapter not selected)

- **Status:** Contract accepted for offline qualification; production adapter unresolved

## Decision

Production authority implements `DurableAuthorityTransactions` and `DurableAuthorityMaintenance`;
the Stage 0 `MetadataStore` remains fixture-only. Every tenant transaction requires `TenantContext`.
Whole-authority export, inspection, migration, initialization, and restore require an explicit
`AuthorityMaintenanceContext` containing both a tenant audit context and the closed
`offline_authority_maintenance` privilege; they are never ambient zero-context operations. Each
transaction must atomically validate owner, subject status/epoch/version, device-agent linkage,
grant agent/device/connection/operation/expiry, and connection provider/adapter/custody linkage,
then mutate all affected challenge, identity, revocation, replay, reservation, or finalization
records. Production composition may not assemble authorization from separate check and consume
calls.

A reservation result is exactly `reserved`, `denied`, `already_consumed`, or `unknown_commit`.
Reservation alone never authorizes a connector. The adapter atomically writes both proof nonces,
capability JTI, and a metadata-only attempt reservation, then a separate one-time atomic `reserved`
→ `dispatching` claim returns an opaque durable dispatch permit. A separate atomic `startDispatch`
validates its attempt/claim/token/authority-generation binding, revalidates the complete current
authority graph and durable expiries, persists its one use and dispatch-start marker, and returns
the only connector dispatch authorization. Claim performs the same graph/expiry revalidation.
Finalization validates the same binding; restart recovery terminally marks unresolved dispatch as
`dispatch_unknown`. Neither ambiguity state is automatically retried. This is at-most-once dispatch
authorization, not external exactly-once execution.

Durable envelopes carry schema version, migration state/generation, authority generation, effective
durable time, independent replay/revocation/schema high-watermarks, permit hashes and bindings,
dispatch-start state/count, terminal results, and record versions. The neutral maintenance interface
exports, inspects, initializes, restores, prepares/advances/fails, and recovers these same
envelopes. Preparing, committing, failed, and recovered migration states are separate adapter-atomic
CAS commits. Restore and migration must preserve every current record and non-decrease both outer
and nested subject/identity versions, attempt state/start/finalization, replay
ownership/generations, ceremony use, enrollment history, effective time, and every watermark; a
larger outer record version never permits logical rollback. Equal-version payload changes are
denied. Older/unavailable schemas, corrupt records, stale snapshots, record deletion/rollback,
partial migrations, and rolled-back clocks deny authority. Canonical UTF-8 JSON sorts object keys,
permits only plain data and safe integers, and rejects undefined, exotic objects, accessors,
symbols, sparse arrays, extra array properties, cycles, and non-finite numbers independently of
adapter prototypes. Caller inputs are detached once into recursively frozen null-prototype snapshots
before semantic/asynchronous reads; Proxy and adversarial reflective inputs fail closed. Export and
inspection snapshots have the same recursive freeze/detachment boundary.

## Storage decision deferred

The offline file reference is test machinery only. No Deno KV or external database is chosen. A
production adapter requires separately authorized current documentation evidence for atomicity,
ambiguous commit behavior, transaction/value limits, isolation, TTL, region, retention, export,
backup, and restore. Unsupported semantics block selection rather than weakening this contract.

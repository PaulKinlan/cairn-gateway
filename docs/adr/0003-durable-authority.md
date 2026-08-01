# ADR 0003: Durable authority contract (adapter not selected)

- **Status:** Contract accepted for offline qualification; production adapter unresolved

## Decision

Production authority implements `DurableAuthorityTransactions` and `DurableAuthorityMaintenance`;
the Stage 0 `MetadataStore` remains fixture-only. Every tenant transaction requires `TenantContext`.
Maintenance always requires an opaque, issuer-identity-checked `AuthorityMaintenanceContext` bound
to one actor, exact operation purpose, and either one tenant owner or a separately issued
schema-wide authority scope. No public literal, tenant sentinel (including `"*"`), or structurally
reproducible object grants either scope. The custody-neutral tenant and authority issuers are held
outside the ordinary maintenance interface. Tenant export and inspection return only that owner
partition, and tenant restore rejects foreign records and can mutate only that partition.
Schema-wide initialization, migration, and recovery require the distinct authority scope; that scope
may also perform whole-envelope export, inspection, and restore. This permits a global multi-tenant
envelope without allowing one tenant capability to observe another tenant or control schema state.
Each transaction must atomically validate owner, subject status/epoch/version, device-agent linkage,
grant agent/device/connection/operation/expiry, and the inverse standalone connection plus custody
owner/agent/device/workload linkage, then mutate all affected challenge, identity, revocation,
replay, reservation, or finalization records. Enrollment requests expire within 600 seconds of
commit, approvals create epoch-1 devices, and immutable approved-enrollment linkage survives later
agent/device revocation. Authority may be reactivated only at the exact next logical version; stale
or same-version activation is denied. Production composition may not assemble authorization from
separate check and consume calls.

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
inspection snapshots have the same recursive freeze/detachment boundary. Authority-critical
primordials are captured before use: later replacement of WeakMap, Object, Function, Reflect,
structured-clone, JSON, descriptor, prototype, iteration, or freeze operations cannot mint a
capability, change ownership/schema decisions, or make returned snapshots mutable. Only the
supported schema 1 to 2 transition may enter preparing/committing; unsupported targets are denied
before a transition is persisted, and recovery returns every admitted transition to a valid state.

## Storage decision deferred

The offline file reference is test machinery only. No Deno KV or external database is chosen. A
production adapter requires separately authorized current documentation evidence for atomicity,
ambiguous commit behavior, transaction/value limits, isolation, TTL, region, retention, export,
backup, and restore. Unsupported semantics block selection rather than weakening this contract.

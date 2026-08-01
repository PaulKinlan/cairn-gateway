# ADR 0003: Durable authority contract (adapter not selected)

- **Status:** Contract accepted for offline qualification; production adapter unresolved

## Decision

Production authority implements `DurableAuthorityTransactions`; the Stage 0 `MetadataStore` remains
fixture-only. Every operation requires `TenantContext` and must atomically validate owner, subject
status/epoch/version and mutate all affected challenge, identity, revocation, replay, reservation,
or finalization records. Production composition may not assemble authorization from separate check
and consume calls.

A reservation result is exactly `reserved`, `denied`, `already_consumed`, or `unknown_commit`. Only
`reserved` may reach a connector. The adapter atomically writes both proof nonces, capability JTI,
and a metadata-only attempt reservation. Dispatch has one durable permit. A crash during dispatch
finalizes to `dispatch_unknown`; neither ambiguity state is automatically retried. This is
at-most-once dispatch authorization, not external exactly-once execution.

Durable envelopes carry schema version, migration state/generation, authority generation,
independent replay/revocation/schema high-watermarks, and record versions. Migrations and restores
must preserve or increase every watermark. Older/unavailable schemas, corrupt records, stale
snapshots, partial migrations, and rolled-back clocks deny authority. Canonical UTF-8 JSON sorts
object keys, permits only plain data and safe integers, and rejects undefined, exotic objects,
accessors, symbols, cycles, and non-finite numbers independently of adapter prototypes.

## Storage decision deferred

The offline file reference is test machinery only. No Deno KV or external database is chosen. A
production adapter requires separately authorized current documentation evidence for atomicity,
ambiguous commit behavior, transaction/value limits, isolation, TTL, region, retention, export,
backup, and restore. Unsupported semantics block selection rather than weakening this contract.

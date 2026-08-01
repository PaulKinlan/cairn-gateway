# ADR 0002: Stage 1 activation boundary

- **Status:** Accepted for Stage 1A qualification
- **Accepted fixture base:** `25ee6526f683fbd4aa1e955b93c3eb3adf53211d`

## Decision

The accepted base is immutable fixture provenance. It is not deployable and cannot be a live
rollback image because its authority is process-local. Stage 1A is limited to Tasks 1–3 of the
activation plan: frozen provenance/denominators, adapter-neutral durable
transaction/schema/migration contracts, canonical serialization, and a 24-ID offline reference
harness.

Stage 1A does not select a database and does not authorize a listener, HTTP transport, vendor
adapter, provider request, credential or environment access, remote import, dependency change,
deployment, UI, Git remote, push, or publication. Existing forbidden-surface scans remain unchanged.

## Gates

`check:stage0` rejects a non-descendant HEAD, any modification to the seven accepted test files, any
Git remote, denominator drift from 90, or coverage below 84.0% branch, 96.3% function, or 90.6%
line. `check:stage1` requires the ordered manifest `DUR-01` through `DUR-24`. The combined gate is
exactly 114 stable tests with no ignored/skipped case.

Passing this offline gate does not activate Cairn. Production storage, key custody, MCP SDK/named
clients, callback behavior, revocation promise, retention, backup/restore operations, and vendor
contracts require later explicit decisions and independent review.

# ADR 0007: Private single-owner control plane with tenant-safe foundations

- **Status:** Accepted product direction, 2026-08-09
- **Supersedes:** ADR 0006's public fixture-first sequence and ADR 0003's global Deno KV envelope
  selection as an implementation direction

## Context

Cairn's accepted fixture core is security-rich but does not do its original job. The complete path
is local, credential-free, and returns fixture GitHub data; the deployed preview cannot invoke. The
old sequence put a public fake-provider deployment, global-envelope durability, and extensive
identity/recovery work before a real provider connection and real client handoff. The Deno KV
candidate also has a hard 64 KiB global-envelope ceiling, and the latest direct candidate run passed
27/28: `DUR-24` cross-tenant custody-reference uniqueness remains unresolved despite older retained
28/28 evidence.

Paul's immediate need is one private service used by all of his agent sessions: connect GitHub and X
through OAuth and one API-key LLM, then give independently revocable clients narrow access without
sharing credentials.

## Decision

Cairn's immediate product target is a privately hosted, single-owner control plane, while storing
all authority and custody metadata in tenant-partitioned contracts from day one. The current
implementation is still the historical fixture/regression harness. The canonical milestones are R0
reset, R1 real GitHub vertical slice with hosted owner UI and two-client handoff, R2 X, R3 one
API-key LLM, R4 fleet rollout, and R5 multiuser readiness/beta.

DeepSeek is the initial API-key LLM because the credential inventory confirms a verified standard
DeepSeek Platform API key. R3 adds only `deepseek.chat.complete@v1`; its endpoint and model are
fixed in reviewed code and reverified against current documentation before promotion. Kimi is a
possible later connector, not initial scope.

Nango is the first custody/proxy candidate. R0/R1 performs a credential-free, two-working-day static
capability/security review that produces a sandbox plan but makes no behavioral claim. Only after
explicit approval, a bounded sandbox with dedicated test credentials proves callback binding,
deletion/revocation, proxy restrictions, audit behavior, tenant tags, and denial of agent token-read
or admin access. Missing evidence moves design to dedicated KMS-backed custody without blocking
unrelated R1 implementation or weakening the credential boundary.

Owner authentication for R1 is a pending choice between an allowlisted immutable GitHub numeric
identity and an external access layer. Login OAuth and provider-connection OAuth remain distinct,
purpose-bound flows. No callback bootstraps an owner.

The global single-value Deno KV envelope is rejected. Durable authority will use tenant-partitioned
records or bounded tenant envelopes with separate schema metadata while preserving atomic replay,
permits, revocation, ambiguity handling, and the fixture regression suite.

## Preserved constraints

- Fixed typed operations and the four-tool MCP front door; never a generic proxy.
- P-256 proof of possession, revocation, replay protection, and one-use dispatch permits.
- Provider credentials only in dedicated custody. API-key intake uses a short-lived custodian-hosted
  top-level session: the value exists transiently only in Paul's browser and custodian ingestion
  memory, never in Cairn HTML/DOM/process/storage/logs or redisplay. Client private keys remain only
  on the client.
- Secret-free receipts, including no LLM prompt or output.
- Historical fixtures, acceptance documents, and tests as regression assets, not current product
  acceptance.
- Tenant derived only from authenticated session or verified client proof; one tenant connection may
  be shared through multiple client grants.

## Consequences

R1, not a public fixture deployment, is the next product proof. Passkeys/recovery, separate workload
identities, catalogue expansion, writes, generic proxying, billing, and public SaaS are deferred. R5
adds tenant-scoped owner/admin/member roles, invitations, recovery/second factor, tenant switching,
isolation review, and quotas without re-keying authority or moving credentials because tenancy
exists from R1. Membership removal revokes its client grants without deleting tenant-owned
connections; tenant context is never caller-selected.

No credential access, provider call, provisioning, deployment, or runtime change is authorized by
this ADR.

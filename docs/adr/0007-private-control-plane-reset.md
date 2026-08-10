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

Cairn becomes a privately hosted, single-owner control plane now, while storing all authority and
custody metadata in tenant-partitioned contracts from day one. The canonical milestones are R0
reset, R1 real GitHub vertical slice with hosted owner UI and two-client handoff, R2 X, R3 one
API-key LLM, R4 fleet rollout, and R5 multiuser readiness/beta.

Kimi is provisional only because the credential inventory confirms a configured Kimi Code key.
Activation requires confirmation that its terms and API permit privately hosted agent proxy use. If
not, Paul must separately configure a standard Kimi Platform key or another selected provider key.
No other LLM credential is assumed.

Nango is the first custody/proxy candidate, subject to a focused proof of exact GitHub, X, and
API-key support; tenant namespacing/tags; callback ownership; deletion/revocation; fixed-operation
proxying; and denial of all agent token-read/admin access. Failure selects dedicated KMS-backed
custody, not a weaker credential surface.

Owner authentication for R1 is a pending choice between an allowlisted immutable GitHub numeric
identity and an external access layer. Login OAuth and provider-connection OAuth remain distinct,
purpose-bound flows. No callback bootstraps an owner.

The global single-value Deno KV envelope is rejected. Durable authority will use tenant-partitioned
records or bounded tenant envelopes with separate schema metadata while preserving atomic replay,
permits, revocation, ambiguity handling, and the fixture regression suite.

## Preserved constraints

- Fixed typed operations and the four-tool MCP front door; never a generic proxy.
- P-256 proof of possession, revocation, replay protection, and one-use dispatch permits.
- Provider credentials only in dedicated custody; client private keys only on the client.
- Secret-free receipts, including no LLM prompt or output.
- Historical fixtures, acceptance documents, and tests as regression assets, not current product
  acceptance.
- Tenant derived only from authenticated session or verified client proof; one tenant connection may
  be shared through multiple client grants.

## Consequences

R1, not a public fixture deployment, is the next product proof. Passkeys/recovery, separate workload
identities, catalogue expansion, writes, generic proxying, billing, and public SaaS are deferred. R5
adds invitations, memberships, recovery/second factor, tenant switching, isolation review, and
quotas without re-keying authority or moving credentials because tenancy exists from R1.

No credential access, provider call, provisioning, deployment, or runtime change is authorized by
this ADR.

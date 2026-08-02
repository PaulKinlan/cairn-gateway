# ADR 0006: Public authenticated MCP with fixture custody precedes live custody

- **Status:** Selected by Paul on 2026-08-02; implementation and hosted qualification pending

## Decision

Cairn's primary product shape is a **public, authenticated HTTP MCP server**: enrolled agents on any
machine call one hosted authority, and provider tokens never leave hosted custody. The loopback-only
form was a proving ground, not a product. Paul re-sequenced public exposure on 2026-08-02 after
concluding the local-only direction did not deliver the product.

Public exposure is pulled forward to the M2/M3 goal, strictly under these conditions:

- **Fixture custody only.** No real provider credential, signing material, or production custody is
  exposed or authorized. `github.user.read@v1` continues to return fixture projections. Live
  provider custody remains gated at M4 under the unchanged activation gates.
- **Real cryptographic enrollment.** The accepted Stage 0 core (P-256 request proofs, one-call
  capabilities, atomic replay defense, revocation) is wired into the product path. No self-asserted
  identity, display-label mapping, or fixed test authority appears on any hosted surface. Owner
  passkey administration UX remains M3.
- **Deno KV durability first** per ADR 0003: the unchanged 24 scenarios must pass against the exact
  adapter/topology before the deployment carries authority state.

Consequences for milestones: M2 becomes the durable public fixture-custody deployment; M3 becomes
owner administration (passkeys, recovery, sessions) on the deployed service; M6 is no longer the
first deployment and becomes the real-custody private alpha after M4/M5.

## Gates (unchanged in strength)

- The hosted listener must satisfy the existing PLAN.md hosted-listener security gates before
  exposure: host/origin validation, client authentication on every request, bounded sessions and
  streaming bodies, safe rate limiting, no debug state.
- Hosted US storage/transit acknowledgement, backup/restore proof, receipt retention/deletion
  policy, and measured cost remain pre-private-data gates.
- Public deployment requires independent review acceptance, like every prior exposure change.
- This ADR authorizes the direction only. It does not authorize hosted provisioning, real
  credentials, production custody, or private data.

# Cairn product plan

## Product

Cairn lets a person connect a provider once, keep its credential in dedicated custody, and give
agents narrow access to named operations. An enrolled agent can use the grant from approved devices
over MCP. It receives typed results and receipts, never a provider token, raw credential, generic
request primitive, or caller-selected destination. The owner can inspect and revoke that access.

The first provider operation is `github.user.read@v1`: read the connected GitHub user's allowlisted
profile fields. More operations must be added individually with fixed provider routes, input and
output schemas, policy cost, and projection rules.

## Users

- **Owner/admin:** connects providers, enrolls devices and agents, issues grants, reviews use,
  revokes access, and recovers the account.
- **Agent operator:** connects an MCP client to Cairn and selects an enrolled agent and approved
  connection.
- **Operator:** deploys Cairn, manages custody and signing systems, monitors failures, performs
  recovery, and audits changes without gaining routine access to provider credentials.

## Journeys

### Admin journey

1. Create or recover an owner identity.
2. Enroll an admin device and verify its key.
3. Connect GitHub through an exact callback and PKCE flow; Cairn stores the resulting credential in
   custody rather than in the application database.
4. Enroll an agent, name the devices that may act for it, and review their keys.
5. Grant that agent `github.user.read@v1` on the chosen connection with an expiry and usage limit.
6. See connection, device, agent, and grant status; inspect invocation receipts and usage.
7. Revoke or replace a grant, agent, device, connection, or owner epoch and see later calls fail.
8. Export, restore, rotate, and recover authority state through a separate privileged maintenance
   path.

### Agent journey

1. Add Cairn's MCP URL to a supported client.
2. Initialize a session and list the operations exposed to the enrolled agent.
3. Call `invoke_operation` with a fixed operation ID, connection ID, and schema-checked arguments.
4. Receive projected provider data and a policy receipt, without access to credentials or provider
   request controls.
5. Receive a typed denial when a grant expires, is revoked, exceeds policy, or the provider fails.

## Architecture

- **Admin application:** onboarding, connection setup, enrollment, grant/revocation, receipt, usage,
  and recovery screens. Its mutations require authenticated, CSRF-protected requests.
- **MCP transport:** named-client-compatible Streamable HTTP lifecycle, session handling, bounded
  method adapter, and typed tool envelopes.
- **Authority service:** owner, agent, device, grant, connection, replay, permit, and revocation
  decisions. Dispatch requires an atomically consumed permit.
- **Operation registry:** versioned operation definitions with fixed provider routes, schemas,
  projection, cost, and error mapping. It cannot express arbitrary HTTP.
- **Credential custody:** provider authorization and token use behind an opaque connection
  reference. Tokens never enter MCP, admin HTML, logs, receipts, or the authority store.
- **Provider adapters:** one reviewed adapter per provider and operation family. Adapters accept
  typed arguments and return bounded outcomes.
- **Durable authority store:** tenant-scoped compare-and-swap transactions, replay records, permit
  state, migrations, backup, restore, and explicit ambiguous-commit handling.
- **Receipts and operations:** sanitized decision records, usage accounting, health, alerting, key
  rotation, and deployment runbooks.

## Local and hosted paths

The local path is credential-free and uses the accepted in-memory fixture, fixture signers, and
fixture GitHub response. It exists so a developer can connect a real MCP client, exercise the whole
wire lifecycle, test revocation, and understand the product before custody or hosting is enabled. It
binds `127.0.0.1` and does not make provider requests.

The hosted path will replace fixtures only at explicit component boundaries: durable storage,
production key custody, authenticated admin identity, provider OAuth/custody, and deployed MCP
transport. The public Deno preview remains a static setup surface until those pieces pass their
activation gates. It must not become an authority service by implication.

## Security gates

These are release gates, not the product description.

- No API, tool, log, export, or UI returns provider tokens, signing material, or raw custody
  records.
- No generic proxy, generic request, arbitrary header, arbitrary URL, base-URL override, or
  caller-selected destination exists.
- Every operation has closed input/output schemas, a fixed provider route, bounded projection, and
  explicit cost.
- Tenant, owner, agent, device, grant, connection, operation, body, route, audience, nonce, time,
  and capability are bound before dispatch.
- Revocation and expiry are checked at use time. One successful atomic permit consumption is the
  only dispatch authority; ambiguous commits are not retried automatically.
- Admin mutations are authenticated, POST-only, same-origin, CSRF-protected, audited, and separated
  from maintenance authority.
- Hosted listeners validate origin/host, authenticate MCP clients as designed, limit sessions and
  request size, and expose no debug state.
- Durable migrations, backup, restore, recovery, key rotation, retention, and incident procedures
  pass destructive and failure-injection tests before production data is accepted.

## Milestones

### Milestone 1 — usable local MCP fixture (current)

Deliver a loopback-only Streamable HTTP server backed by `createFixtureGatewayHarness`, plus a local
setup page. VS Code can initialize, send `notifications/initialized`, list tools, and invoke the
fixture operation. The page shows the endpoint, fixture connection/grant state, operation, matching
VS Code configuration, and POST-only CSRF-protected controls to test, revoke, and reactivate the
grant. Include listener-level lifecycle tests, a smoke command, and direct setup documentation.

**Acceptance:** a clean checkout on Deno 2.9.0 can run one command, connect with the documented VS
Code configuration, call `invoke_operation`, observe the fixture GitHub user, revoke the grant in
the browser, observe denial, reactivate it, and call again. The 90 Stage 0 cases, 24 Stage 1 cases,
and public preview gate remain unchanged and passing.

### Milestone 2 — admin identity and enrollment

Build owner onboarding and recovery, hardware-backed or OS-backed admin device enrollment, agent
creation, device-to-agent enrollment, key replacement, and authenticated admin sessions. Replace
fixture-only management actions with audited tenant-scoped commands.

**Acceptance:** two owners cannot observe or mutate each other's graph; lost-device and compromised-
agent recovery work from written runbooks; every enrollment and revocation is visible in the audit
view.

### Milestone 3 — durable authority and operations

Select and implement the production authority store against the accepted 24-scenario contract. Add
production migrations, backup/restore, replay retention, atomic dispatch permits, receipt storage,
usage views, limits, and recovery tooling.

**Acceptance:** concurrency, crash, stale-lock, ambiguous-commit, migration, restore, and tenant-
isolation tests pass against the selected store, with measured recovery objectives and an operator
runbook.

### Milestone 4 — GitHub custody and provider integration

Implement GitHub connection onboarding, exact OAuth callback handling, production custody, token
rotation/revocation, and the fixed `github.user.read@v1` provider call. Keep credential use inside
the custody/provider boundary.

**Acceptance:** a test GitHub account can connect, invoke the typed operation, rotate and revoke its
credential, and disconnect; sentinel tests prove credentials never cross into MCP, storage, logs,
receipts, or the browser.

### Milestone 5 — hosted MCP and administration

Deploy the authenticated admin app and named-client-compatible MCP service with durable sessions,
rate limits, monitoring, secure configuration, and separate maintenance access. Publish exact setup
for supported MCP clients.

**Acceptance:** a new owner can complete onboarding and use the documented client from a clean
machine; revoke-to-denial latency, availability, audit coverage, backup restore, and incident drills
meet documented targets.

### Milestone 6 — production readiness and operation expansion

Complete external security review, privacy/retention controls, support and incident procedures,
capacity testing, and staged rollout. Add further provider operations only through the reviewed
operation model.

**Definition of done:** invited users can connect a real provider, enroll an agent and devices,
grant and revoke typed operations, use them from supported MCP clients, inspect receipts and usage,
and recover safely. Operators can deploy, monitor, rotate, restore, and respond to incidents from
tested documentation. No production credential or arbitrary proxy surface is exposed.

## Current status and gaps

The repository has an accepted 90-case fixture core, a 24-scenario durable-authority contract, and a
separate credential-free public preview gate. The fixture composition root binds policy, proof,
revocation, projection, and a fixed GitHub user response without network or credential access.

Milestone 1 is the active delivery. Production storage, authenticated admin identity, device/agent
enrollment UX, real grants, credential custody, GitHub authorization, provider calls, hosted MCP
authentication, receipt persistence, usage, recovery, deployment, and operations documentation do
not yet exist.

## Prioritized worklist

1. Finish and independently review Milestone 1: local transport, setup UI, named-client guide, wire
   tests, revocation exercise, and full existing gates.
2. Design admin onboarding, recovery, device/agent enrollment, and grant/revocation screens and
   APIs.
3. Select durable storage and qualify it against all 24 scenarios, backup/restore, and migrations.
4. Select production signing and credential custody; document rotation and recovery
   responsibilities.
5. Implement GitHub connection onboarding and the real `github.user.read@v1` adapter with sentinel
   leak tests.
6. Persist receipts and usage; add owner views, limits, retention, and audit export.
7. Define hosted MCP authentication, session limits, supported client matrix, and revocation
   latency.
8. Write and test deploy, operate, backup, restore, recovery, key rotation, and incident runbooks.
9. Run external security review and a restricted hosted pilot before adding operations or providers.

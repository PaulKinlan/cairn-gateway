# Cairn product plan

`PLAN.md` is the canonical product and delivery plan. If another document conflicts with this one,
this file wins and the conflict must be corrected with the next related change.

## Product now

Cairn is Paul's privately hosted, single-owner control plane for all of his agent sessions. Paul
connects each provider once; separately enrolled clients receive narrow grants to fixed operations
through MCP without receiving provider credentials. One provider connection may serve grants for
many clients.

The first provider set is:

1. GitHub through OAuth;
2. X through OAuth; and
3. one API-key LLM provider.

Kimi is the provisional LLM because the credential inventory confirms only Kimi is configured. R3
activation is blocked until the provider confirms that the existing **Kimi Code** key may be used by
a privately hosted agent proxy. If it may not, Paul must separately configure a standard Kimi
Platform key or another selected LLM key. Cairn must not infer that Anthropic, Gemini, or any other
LLM provider is configured.

## Permanent boundaries

- The MCP front door remains four tools: `search_capabilities`, `describe_operation`,
  `connection_status`, and `invoke_operation`.
- Operations are typed, versioned, and fixed in code. There is no generic proxy, arbitrary URL,
  method, header, base URL, model, or raw provider response surface.
- Preserve the accepted P-256 proof-of-possession, revocation, atomic replay, one-use permit, and
  ambiguous-dispatch core. Authority is rechecked at use time.
- Provider credentials are visible only to the selected custodian. They never appear in HTML,
  clipboard data, command arguments, client config, logs, receipts, analytics, support output, or
  the journal. Client private keys remain local and are never uploaded.
- Receipts contain allowlisted metadata only. LLM prompts and outputs and provider request/response
  bodies are never receipt fields.
- The 90 Stage 0 tests, 24 Stage 1 scenarios, local fixture journey, acceptance records, and fixture
  adapters remain regression and historical assets. They are not the current product, milestone
  sequence, deployment prerequisite, or evidence of a live provider.

## Tenant-safe model from day one

Single owner does not mean global or owner-inferred records. These are the target contracts:

- **Tenant:** the isolation, custody, quota, and retention boundary.
- **User:** an authenticated human identity independent of a tenant.
- **Membership:** a user's role in one tenant. The private alpha has one active owner membership.
- **ProviderConnection:** tenant-owned provider authorization and opaque custody reference. It has
  no client ownership and may be referenced by multiple grants.
- **ClientPrincipal:** a named agent-session/client identity with a P-256 public key, thumbprint,
  status, and key epoch. Its private key is local-only.
- **Grant:** tenant-owned authority joining one client principal, one provider connection, and one
  operation with version, status, expiry, and bounded usage/cost policy.
- **OAuthFlow:** one-use, purpose-bound state for either login or provider connection. It binds
  tenant, initiating authenticated user/session, provider, purpose, redirect, state, PKCE where
  supported, expiry, and completion status.
- **Attempt:** durable invocation reservation/dispatch state used for replay and ambiguity control.
- **Receipt:** secret-free metadata describing a policy/result category and its attempt; it is not a
  request or response archive.

Every record key, lookup, mutation, custody identifier/tag, receipt, and attempt is tenant
partitioned. Tenant is derived only from an authenticated owner session or verified client proof; it
is never accepted from a form field, callback parameter, MCP argument, header, opaque object ID, or
“first callback” behavior. Login OAuth and provider-connection OAuth are separate, purpose-bound
flows. This model must let R5 add users without re-keying records or moving provider credentials.

## Fixed initial operations

| Operation                | Provider call                                                                           | Closed behavior                                                                                                                                                                                            |
| ------------------------ | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `github.user.read@v1`    | `GET https://api.github.com/user`                                                       | Empty input; return only reviewed user fields. No repository or write access.                                                                                                                              |
| `x.user.me.read@v1`      | `GET https://api.x.com/2/users/me` (verify the current canonical host and scopes in R2) | Empty input; current least-privilege scopes must be verified before activation. No writes, DMs, search, timeline, or arbitrary fields.                                                                     |
| `kimi.message.create@v1` | Exact Kimi endpoint and model selected by the owner and fixed in deployed configuration | Bounded message schema, message count/size, output tokens, timeout, and cost. No caller-selected model/base URL/headers/tools/files and no arbitrary provider options. Prompt/output absent from receipts. |

A new operation requires its own fixed route, closed input/output schemas, projection, scope, cost,
failure mapping, revocation behavior, and security review.

## Custody

Nango is the first candidate for GitHub, X, and API-key connection custody and proxying. R1 starts
with a focused, credential-free vendor-capability spike. It must prove exact support for each
connection type, tenant tags/namespacing, callback ownership, deletion and provider revocation
semantics, fixed-operation proxy restrictions, audit behavior, and that agent-facing credentials
cannot read tokens or access Nango administration. Marketing claims or an interface are not proof.

If Nango fails any required property, use dedicated KMS-backed custody with a narrowly privileged
provider worker. Rejection never permits agent-visible credentials, operator token inspection, or a
weaker generic proxy.

## Owner authentication

Private-alpha owner authentication is an R1 blocking decision between:

- an allowlisted, immutable GitHub numeric user identity (not login name or email); or
- an external access layer that supplies an equally immutable verified identity.

The decision requires session/CSRF, logout, allowlist-change, identity-recovery, and callback
separation evidence. The first successful OAuth callback must never create or select the owner.
Passkeys, second-factor recovery, and full account recovery are deferred to R5.

## Owner UI

The hosted owner UI has only:

1. **Setup / Home** — authentication, required setup, service health summary, and next safe action;
2. **Connections** — connect, health-check, reconnect, disconnect, and delete provider connections;
3. **Agents** — named client principals, enrollment, keys/fingerprints, status, and nested grants;
4. **Activity** — secret-free receipts/attempt outcomes and bounded usage/cost metadata; and
5. **Security** — sessions, client/key revocation, security events, and destructive confirmations.

Provider lifecycle is
`not_configured → pending → connected → reconnect_required → disconnected →
deleted`, with `error`
as a recoverable diagnostic state. **Configured** records that a custody binding exists; **healthy**
is a separately timestamped, bounded provider/custodian check. Neither implies the other. Disconnect
immediately disables Cairn dispatch and then reports upstream revoke as confirmed, pending,
unsupported, or failed. Delete removes custody according to verified vendor semantics and tombstones
authority so stale grants cannot revive it. Reconnect creates fresh connection authority rather than
relabeling dead authority active.

API-key intake is a purpose-built, authenticated, same-origin, CSRF-protected, rate-limited form
posted directly to custody or a single-use custody intake endpoint. The browser never receives the
stored value again. Cairn shows provider, label, creation/rotation time, last health check, and last
four fingerprint characters only when the custodian can derive them safely. There is no reveal,
copy, download, debug, receipt, or log path for the value.

## Client handoff

1. The owner creates a named client and selects its connection/operation grants.
2. The UI issues a short-lived, one-use enrollment reference. It carries no invocation authority and
   cannot be exchanged without owner approval.
3. A local helper consumes only that reference, generates a non-exported P-256 key locally, stores
   it with mode/OS-keychain protections, submits the public key and proof of possession, and
   displays the key fingerprint.
4. The owner compares and approves the fingerprint in the authenticated UI. Approval atomically
   binds the client key and grants; expiry, replay, mismatch, or cancellation fails closed.
5. The helper writes non-secret Pi/MCP configuration and, where needed, a local signing bridge. The
   configuration contains the Cairn URL, client ID, public metadata, and local key reference only.

No enrollment artifact can invoke. No provider token or client private key enters HTML, clipboard,
command arguments, generated config, logs, receipts, or the journal.

## Durable authority reset

The current Deno KV candidate's global single-value `DurableAuthorityEnvelope` is rejected. Its 64
KiB ceiling cannot be Cairn's authority boundary, and the latest direct run is **27/28 with `DUR-24`
cross-tenant custody-reference uniqueness unresolved**. Earlier retained 28/28 evidence is
historical and does not override that result.

The replacement uses tenant-partitioned records or bounded tenant-partitioned envelopes, explicit
indexes, strong reads and atomic compare-and-set transactions. Global schema/migration metadata is
separate from tenant authority. Transaction design must preserve replay consumption, one-use
permits, revocation, ambiguous outcomes, inverse connection/custody linkage, and the unchanged
regression scenarios without relying on a global blob. Storage selection/qualification, remote
contention, limits, backup/restore, retention/deletion, and cost remain activation gates.

## Delivery milestones

### R0 — reset and model (current)

- Canonical plan, pivot ADR, README, UI IA, historical labels, tenancy model, and decision gates
  agree.
- No credentials, provider calls, provisioning, deployment, or runtime changes.
- **Accept:** documentation checks and full existing gate pass; independent review finds no
  contradiction or widened scope.

### R1 — real GitHub vertical slice

- Decide owner authentication and custody after focused spikes.
- Implement tenant-partitioned authority, hosted owner UI, GitHub connect/disconnect/reconnect,
  `github.user.read@v1`, exact client handoff, and two independently revocable clients.
- **Accept:** owner connects GitHub; two separately enrolled Pi/MCP clients invoke; revoking one
  denies it at use time while the other continues; receipts are secret-free; disconnect denies and
  reconnect creates fresh authority. Record callback, deletion, restart, replay, and sentinel tests.

### R2 — X

- Verify current OAuth flow, exact minimal scopes, endpoint host, projection, revoke/deletion, and
  Nango support before activation.
- Add only `x.user.me.read@v1` and repeat the two-client isolation/revocation journey.

### R3 — Kimi / API-key LLM

- Resolve whether the configured Kimi Code key permits hosted proxy use; otherwise require a
  separately configured standard Kimi Platform or selected alternative key.
- Add secure API-key intake and only `kimi.message.create@v1` with enforced message/token/cost
  bounds and receipt exclusion tests.

### R4 — fleet rollout

- Enroll Paul's active agent sessions, issue least-privilege per-client grants, publish the
  non-secret helper/config path, measure health/cost/revocation, and exercise incident rollback.
- No shared client principal and no copied private key across sessions.

### R5 — multiuser readiness and beta

- Add invitations, membership roles, tenant creation/switching, recovery plus second factor,
  isolation review, and per-tenant quotas.
- Prove cross-tenant UI/API/custody/receipt/backup isolation. Existing records and custody bindings
  stay in place because tenancy was present from R1.

## Deferred

Passkeys and recovery before R5, separate workload identities, catalogue expansion, provider writes,
DMs/search, generic proxying, billing, public SaaS, enterprise federation, arbitrary tools or files,
owner-configurable base URLs/models/headers, and public fake-provider deployment are not
prerequisites for R1–R4. They require a later same-commit plan decision and security review.

## Immediate R1 decision checklist

1. Spike Nango without credentials: GitHub/X/API-key support, tenant tags, callbacks, deletion,
   revoke, proxy restriction, token-read/admin isolation, pricing, and self-host/private topology.
2. Compare immutable GitHub numeric allowlist authentication with an external access layer and
   record the selection in an ADR.
3. Design tenant-partitioned durable records and rerun all durability scenarios, keeping DUR-24
   visibly unresolved until it passes for the correct reason.
4. Specify the hosted URL/callback topology and the two-client helper acceptance run without
   provisioning it.

No R1 activation occurs until those decisions are recorded and independently reviewed.

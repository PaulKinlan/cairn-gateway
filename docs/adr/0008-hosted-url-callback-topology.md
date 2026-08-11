# ADR 0008: R1 hosted URL/callback topology and two-client helper acceptance run

- **Status:** Recorded specification, 2026-08-12 — `PLAN.md` Immediate R1 decision checklist item 4
- **Depends on:** ADR 0007; reconciles `docs/ui-later.md`, `docs/threat-model.md`,
  `docs/security-invariants.md`, `docs/verification-ledger.md`, and the `packages/core/src/r1`
  model. Nothing in this ADR is provisioned, deployed, or authorized for credential use.

## Context

Checklist item 4 requires the hosted URL/callback topology and the exact two-client local-helper
acceptance run to be specified without provisioning. Existing documents fix the constraints —
purpose-bound flows, tenant derivation, secret boundaries, the enrollment ceremony, and the
connection lifecycle — but no document named the exact origins, routes, redirect allowlist, or the
planned acceptance procedure. This ADR records them as one canonical artifact so later
implementation cannot drift between documents.

## Decision: origins and routes

Planned canonical owner origin: **`https://cairn.paul.kinlan.me`**, a private Deno Deploy app in the
existing org behind that exact custom hostname. The value is a planning constant: DNS, TLS, and app
provisioning remain activation gates, and substituting any other hostname requires updating this
ADR, the GitHub OAuth app registration, and the redirect allowlist in one commit. The
deploy-assigned `*.deno.net` hostname is infrastructure only; it is never advertised and is never
accepted by exact-origin checks. The historical invocation-disabled public preview
(`cairn-gateway.paulkinlan-ea.deno.net`) is unchanged and is not part of this topology.

All Cairn routes live on the single owner origin. One origin is deliberate: it removes cross-origin
cookie and redirect questions while route classes enforce the trust separations below.

Owner UI routes (authenticated owner session; server-rendered; native POST forms; no client scripts,
matching the accepted R1 foundation views):

- `GET /owner/setup`, `/owner/connections`, `/owner/agents`, `/owner/activity`, `/owner/security` —
  the five `docs/ui-later.md` destinations, and nothing else.
- `POST /owner/connections/github/connect`, `/owner/connections/github/disconnect`,
  `/owner/connections/github/reconnect`, `/owner/connections/github/delete`, and the client/grant
  mutations under `/owner/agents` — the only mutating owner actions.

Owner login flow (OAuthFlow purpose `owner_login`):

- `POST /auth/login/github` starts the flow; `GET /auth/login/github/callback` is its only callback.

Provider connection flow (OAuthFlow purpose `provider_connection`):

- `POST /owner/connections/github/connect` (authenticated) creates the flow record and redirects to
  GitHub; `GET /oauth/github/callback` is its only callback. The path preserves the accepted fixture
  convention `https://fixture.cairn.invalid/oauth/github/callback` with the fixture origin replaced
  by the canonical origin.

Unauthenticated, cookie-free routes:

- `POST /mcp` — the four-tool MCP front door (`search_capabilities`, `describe_operation`,
  `connection_status`, `invoke_operation`). Authorization is only a verified client P-256 proof over
  the received bytes; no session cookie is read and a cookie never authorizes MCP.
- `POST /enroll` — enrollment submission carrying the one-use reference, the client public key, and
  proof of possession. No session cookie; the reference alone never authorizes invocation.

External origins:

- `github.com` — authorization redirect target only. `api.github.com` — contacted only by the
  custodian for the fixed `GET /user` operation; Cairn never calls a provider directly.
- Custodian origin(s) — the selected custodian's backend API plus, for R3 only, the custodian's
  top-level API-key intake origin. Exact custodian hostnames are recorded by the custody decision
  (checklist item 1), not here; Nango remains an unverified candidate under ledger blockers 4–6.

Trust boundaries (extending `docs/threat-model.md`): owner browser ↔ owner-origin session; local
helper/signing bridge ↔ `POST /mcp` proof; owner-origin backend ↔ custodian (least-privilege keys,
no credential read); custodian ↔ GitHub; owner browser ↔ custodian top-level intake origin (R3
transient secret only, never traversing Cairn); owner browser ↔ `github.com` authorize redirect.
Compromise of one route class must not yield credential retrieval, tenant selection, or a generic
request primitive.

## Login versus provider-connection callback separation

Two purpose-bound OAuthFlow kinds (model `purpose: "owner_login" | "provider_connection"`), two
distinct exact callback routes, and two distinct registered GitHub redirect URIs. State, PKCE
verifier, and flow records never cross purposes: a login callback can only complete a login flow and
can only authenticate; a connection callback can only complete a pending `provider_connection` flow
belonging to the authenticated session's tenant. Neither callback creates an owner, selects a
tenant, or creates client authority; the first callback never wins ownership (invariants 8, 18, 20).
Owner authorization after login requires the immutable identity selected by checklist item 2's ADR.
Whether one GitHub OAuth app registers both callback URIs or two apps are used is decided there
together with GitHub app-settings verification (ledger blocker 7). Connection completion authority
is the backend custodian/token-exchange confirmation, never the browser return: the browser callback
only resumes the flow, and the connection becomes `connected` solely after server-side custody
binding succeeds.

## Tenant derivation

Tenant context comes only from: (a) the authenticated owner session's active membership on
`/owner/*` and `/auth/*` routes; (b) the verified client proof's client principal on `/mcp`; and (c)
the consumed one-use OAuthFlow or enrollment record on the callback and `/enroll` routes. Tenant is
never accepted from a form field, callback parameter, MCP argument, header, opaque object ID, or
first-callback behavior (invariant 1). Callback routes derive tenant from the flow record keyed by
the consumed state, never from any provider-supplied parameter.

## State, PKCE, session, and CSRF boundaries

- OAuthFlow records are one-use and purpose-bound: tenant, initiating user/membership/session,
  provider, purpose, exact redirect URI, expiry of at most 600 seconds (matching the
  enrollment-request bound), and completion status. Raw state and the PKCE verifier exist only
  server-side and in the single authorize redirect; stored forms are hashed.
- PKCE (S256) is required where the provider supports it for the web flow. Exact current GitHub
  behavior is ledger blocker 7 and is verified before activation; if PKCE support cannot be
  confirmed, one exact compiled provider/integration with verified state-only behavior compensates,
  and no `iss` response parameter is assumed.
- Callback processing atomically consumes state, binds the provider response to the exact flow and
  redirect URI, expires or cancels competing flows, and fails closed on mismatch, replay, or expiry.
  Browser return is never completion authority (invariant 8).
- Owner sessions are server-side records referenced by an opaque `__Host-` cookie (`Secure`,
  `HttpOnly`, `SameSite=Lax`, exact path). The session binds the authenticated user and the active
  membership. Logout is a POST that destroys the record server-side.
- Every mutating `/owner/*` route is POST-only and requires (a) an exact `Origin` header match
  against the canonical origin — the check the R1 foundation owner views already enforce — and (b) a
  per-session synchronizer CSRF token. `SameSite=Lax` is defense-in-depth, never the control. Stale
  forms, duplicate submissions, and concurrent revokes return a safe next action.
- `/mcp` and `/enroll` read and emit no cookies; cross-site browser posting cannot mint authority
  because authorization is proof of possession, not ambient credentials.

## Redirect allowlist

Outbound redirects emitted by Cairn are exactly:

1. the GitHub authorize URL with the fixed client ID and the exact registered callback URI for the
   flow's purpose — never caller-influenced; and
2. the custodian-created, purpose-bound connect/intake session URL (custody decision scope; the R3
   API-key intake only ever navigates to the custodian's top-level origin).

Post-callback navigations go only to fixed same-origin owner UI paths (`/owner/setup`,
`/owner/connections`); there is no `next`/`return` parameter anywhere. The registered GitHub
redirect URIs are exactly the two callback URLs above with exact host/port: GitHub's documented path
matching is not relied on — Cairn requires single exact URIs. There is no open redirect, no dynamic
`redirect_uri`, and no callback URL inside any enrollment artifact.

## Enrollment-reference flow (topology view)

1. The authenticated owner creates a named client and selects its connection/operation grants.
2. The UI displays a short-lived (≤ 600 seconds), one-use enrollment reference — opaque, stored
   hashed, carrying no invocation authority and no client or provider secret.
3. The local helper receives the reference by non-secret manual entry, generates a non-exported
   P-256 key locally, and POSTs the reference, the public key, and proof of possession to `/enroll`.
   The helper displays the key fingerprint.
4. The owner compares the fingerprint in the authenticated UI and approves; approval atomically
   binds tenant, named client, key epoch, and grants. Expiry, replay, mismatch, cancellation, or
   reuse fails closed.
5. The helper writes only the non-secret configuration below.

## Local-key and configuration constraints

- The client private key is generated locally, non-exported, and stored under OS-keychain protection
  or a mode-0600 file. It is never uploaded, logged, printed, or placed in command arguments,
  config, receipts, HTML, clipboard data, or the journal.
- Helper-written configuration contains only the canonical origin URL, the MCP path, the client ID,
  public metadata, and a local key reference. It contains no provider token, no consumed enrollment
  reference, and no owner session material.
- Any local signing bridge listens on loopback only, is optional, and holds no authority of its own;
  it signs what the local MCP client sends under the same proof rules as the accepted fixture
  bridge.

## Two-client local-helper acceptance run (planned, not authorized)

Preconditions, all gated elsewhere: checklist items 1–3 recorded and independently reviewed; the
replacement durable store qualified with `DUR-24` resolved for the correct reason; ledger blockers
1–7 closed for this exact topology; and explicit approval for provisioning, dedicated credentials,
and deployment. Two independent client environments (separate machines or OS accounts) run helper
builds from the exact recorded commit.

1. **Owner setup.** The owner completes login on the canonical origin; session, CSRF, and logout
   behavior are confirmed. The owner connects GitHub through the `provider_connection` flow; the
   connection shows configured, with health separately checked and timestamped.
2. **Enroll A and B.** The full enrollment ceremony runs for client A on environment 1 and client B
   on environment 2: distinct non-exported keys, distinct fingerprints displayed by the helpers and
   matched by the owner in the UI, and grants on the one shared connection.
3. **Invoke.** Each client independently runs all four tools; `invoke_operation` for
   `github.user.read@v1` returns only the projected fields. Receipts record allowlisted metadata
   with bounded request units.
4. **Restart.** The hosted service is redeployed/restarted; authority survives the restart and both
   clients invoke again without re-enrollment.
5. **Replay.** A captured signed MCP request from each client is re-sent; each is denied once with a
   `replay_denied` receipt while fresh requests still succeed.
6. **Revoke A at use time.** The owner revokes client A; A is denied on all four tools while B
   continues unchanged.
7. **Disconnect and reconnect.** Disconnect denies both clients immediately; the upstream GitHub
   revoke is reported separately as confirmed, pending, unsupported, or failed; stale grants stay
   visibly dead. Reconnect creates a fresh connection ID; old grants never revive; new grants
   restore continued clients.
8. **Sentinels.** Throughout the run: no provider token, client private key, session value, state,
   verifier, or reference appears in any receipt, log, URL/history, HTML, configuration, command
   line, clipboard, or journal; a synthetic second tenant's probes are denied; receipts remain
   metadata-only.
9. **Cleanup.** Both client principals are revoked; the connection is disconnected and deleted with
   custody deletion verified against vendor semantics and a tenant tombstone recorded; the GitHub
   OAuth grant is revoked upstream; test records are removed; and the secret-free evidence pack
   (exact commit, runbook, receipts, review decision, residual blockers) is retained per
   `AGENTS.md`.

## Blockers (unchanged, fail closed)

Checklist items 1–3; `DUR-24` and durable-store qualification; verification-ledger blockers 1–7
(official SDK/named-client conformance, Nango state/PKCE/redirect, Nango least-privilege key scopes,
Nango proxy redirect behavior, GitHub issuer and app settings); DNS/TLS/app provisioning approval;
dedicated-credential and deployment approvals; and independent review of the built implementation
against this topology.

## Non-authorization

This ADR is documentation only. It authorizes no credential access, no provider call, no browser
authorization flow, no provisioning, no deployment, no production mutation, no private-data
handling, and no weakening of any gate. R1 acceptance is not claimed.

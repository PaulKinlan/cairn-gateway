# Security invariants

These invariants combine the preserved fixture security core with the R1 target model in `PLAN.md`.
Fixture names such as agent/device remain regression terminology; new product authority uses
Tenant/User/Membership/ClientPrincipal/Grant without weakening the proof or replay rules.

1. Every record lookup and mutation includes tenant context derived only from an authenticated owner
   session or verified client proof; caller tenant values and opaque IDs never authorize.
2. Device and agent nonces are independently single-use in shared authoritative state and are
   consumed together atomically; capability JTIs are consumed atomically before dispatch. An
   isolate-local replay cache or composite nonce-pair key is never sufficient.
3. Capabilities are strict ES256, exact issuer/audience/type/key, at most 300 seconds and one call.
4. Principal, agent, device, grant, and connection status, relationship, or epoch/version mismatch
   blocks at call time.
5. Connector method, destination, integration, path, headers, empty input, size, and projection are
   code-defined.
6. Custody cannot return provider credentials or accept arbitrary destinations/headers/methods.
7. Logs and receipts are constructed from metadata allowlists; no arbitrary objects or raw errors.
8. Browser return is never OAuth completion authority; state and PKCE are one-time and atomically
   bound to tenant, principal, connection, integration, redirect URI, and flow.
9. Private device material stays local; fixture material is test-only and cannot be serialized by
   APIs.
10. Unknown vendor/API behavior blocks live activation; interfaces are not evidence of production
    support.
11. Principal creation and device approval require no email. Passkey and recovery remain real
    interfaces, not simulated production recovery.
12. MCP discovery is not authorization. Every MCP request is parsed exactly once from the signed
    received bytes, bound to exact authority and route, consumed once, and rechecks policy/epochs
    using operation-time rather than authentication-time. No independent parsed-body input exists.
13. Device and agent signed requests bind method, configured authority, exact path, an explicitly
    empty query, a digest recomputed from received bytes, gateway audience, grant, both identities,
    nonce, timestamp, and (when present) the independently hashed capability.
14. Reusable bearer values are never carried in URLs or WebSockets. No public-key reclaim occurs
    without a fresh challenge and proof of possession; agent and device keys remain distinct.
15. Bootstrap, enrollment request, approval, and removal commits reconstruct and hash the complete
    canonical transaction inside the authoritative critical section. They never accept a
    caller-computed hash; they recompute every stored RFC 7638 thumbprint, enforce exact
    IDs/expiry/epochs and distinct agent/admin/candidate roles, then consume the matching challenge
    immediately before mutation. Device role and agent relationship are immutable in Stage 0, and
    every owner-wide agent/device key pairing remains distinct.
16. The policy-core trust brand and mint are private to a zero-argument composition root that
    creates and closes over one store, invocation service, signer set, custody fixture, and captured
    system clock. A frozen null-prototype closure facade composes authorization and MCP handling in
    one dispatch; no authority, core, mint, constructor, or mutable clock handle crosses the public
    boundary.
17. The committed MCP contract gate consumes every immutable fixture leaf and validates the actual
    lifecycle and call-result envelope rules; any new or mutated unconsumed constraint fails CI.
18. User identity is independent from tenancy. Membership supplies the tenant role, and every
    ProviderConnection, ClientPrincipal, Grant, OAuthFlow, Receipt, and Attempt is tenant-owned.
19. One ProviderConnection may serve multiple client grants. A connection is never owned by or
    inferred from the first client, grant, callback, or opaque custody reference.
20. Login OAuth and provider-connection OAuth are distinct purpose-bound flows. Neither the first
    callback nor a provider identity bootstraps the owner.
21. Enrollment references are short-lived, one-use, and non-invoking. Only explicit owner approval
    of a locally generated P-256 public-key fingerprint creates client authority.
22. Configured and healthy are separate connection facts. Local denial is immediate on disconnect;
    upstream revoke/deletion certainty is reported separately and stale authority cannot reactivate.
23. API-key intake uses a short-lived, purpose-bound, top-level custodian session with a masked,
    empty-on-render field posting directly over HTTPS. The value exists transiently only in Paul's
    browser and custodian ingestion memory, is cleared from the DOM after submission, and never
    enters Cairn HTML/DOM/process/storage/logs, framework state, URL/history, analytics, clipboard,
    commands, config, receipts, or redisplay. If custody cannot provide this, R3 remains blocked.
24. R5 roles are tenant-scoped: owner controls ownership/membership/security, admin manages
    connections/clients/grants without ownership powers, and member uses only explicitly assigned
    authority. Membership removal denies all of its client grants without deleting tenant-owned
    connections; tenant switching requires an authenticated membership and never trusts a caller
    tenant value.

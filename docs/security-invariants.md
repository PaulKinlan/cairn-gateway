# Security invariants

1. Every record lookup and mutation includes tenant and owner context; opaque IDs never authorize.
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
15. Bootstrap, enrollment request, and approval commits reconstruct and hash the complete canonical
    transaction inside the authoritative critical section. They never accept a caller-computed hash;
    they recompute every stored RFC 7638 thumbprint, enforce exact IDs/expiry/epochs and distinct
    agent/admin/candidate roles, then consume the matching challenge immediately before mutation.
    Raw identity puts validate JWK/thumbprint equality and updates cannot rotate keys in Stage 0.
16. The policy-core trust brand and mint are private to a zero-argument composition root that
    creates and closes over one store, invocation service, signer set, custody fixture, and system
    clock. Public fixture operations can revoke/query that authority but cannot supply, replace, or
    switch stores, clocks, signers, services, authentication time, or trust mints.
17. The committed MCP contract gate consumes every immutable fixture leaf and validates the actual
    lifecycle and call-result envelope rules; any new or mutated unconsumed constraint fails CI.

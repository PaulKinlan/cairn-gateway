# Security invariants

1. Every record lookup and mutation includes tenant and owner context; opaque IDs never authorize.
2. Device nonce and capability JTI are single-use in shared authoritative state and consumed
   atomically before dispatch; an isolate-local replay cache is never sufficient.
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
12. MCP discovery is not authorization. Every MCP request is bound to exact authority, route and
    received bytes, consumed once, and rechecks policy/epochs using operation-time rather than
    authentication-time.
13. Device and agent signed requests bind method, configured authority, exact path, an explicitly
    empty query, a digest recomputed from received bytes, gateway audience, grant, both identities,
    nonce, timestamp, and (when present) the independently hashed capability.
14. Reusable bearer values are never carried in URLs or WebSockets. No public-key reclaim occurs
    without a fresh challenge and proof of possession; agent and device keys remain distinct.
15. Enrollment request and approval commits atomically recheck active principal, agent, approving
    admin, epochs, key thumbprints, and the exact candidate transaction before creating state.

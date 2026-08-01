# Security invariants

1. Every record lookup and mutation includes tenant and owner context; opaque IDs never authorize.
2. Device nonce and capability JTI are single-use in shared authoritative state and consumed
   atomically before dispatch; an isolate-local replay cache is never sufficient.
3. Capabilities are strict ES256, exact issuer/audience/type/key, at most 300 seconds and one call.
4. Device removal, grant revoke, connection disable, epoch mismatch, or global deny blocks at call
   time.
5. Connector method, destination, integration, path, headers, empty input, size, and projection are
   code-defined.
6. Custody cannot return provider credentials or accept arbitrary destinations/headers/methods.
7. Logs and receipts are constructed from metadata allowlists; no arbitrary objects or raw errors.
8. Browser return is never OAuth completion authority; state and PKCE are one-time and exact-bound.
9. Private device material stays local; fixture material is test-only and cannot be serialized by
   APIs.
10. Unknown vendor/API behavior blocks live activation; interfaces are not evidence of production
    support.
11. Principal creation and device approval require no email. Passkey and recovery remain real
    interfaces, not simulated production recovery.
12. MCP discovery is not authorization. Every invocation independently authenticates and checks
    policy.
13. Signed requests bind method, configured authority, exact path, an explicitly empty query,
    content digest, gateway audience, grant, device, nonce, timestamp, and capability hash.
14. Reusable bearer values are never carried in URLs or WebSockets. No public-key reclaim occurs
    without a fresh challenge and proof of possession; agent and device keys remain distinct.

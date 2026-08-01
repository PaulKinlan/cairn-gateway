# Stage 0 threat model

Assets: custodian-held provider tokens, signing/device private keys, flow material,
ownership/grants, connection state, provider response, and receipt integrity. Treat models,
MCP/browser inputs, IDs, callback fields, provider strings, stolen capabilities, stale catalogs,
redirects and a second tenant as hostile.

Controls: composite ownership keys; proof of possession; nonce/JTI CAS; strict short capabilities;
call-time epochs/revocation; fixed connector; bounded projection; narrow custody; metadata-only
logs; one-time state/PKCE; independent per-request MCP authentication; global emergency deny.

Trust boundaries are model→local bridge→gateway→custodian→GitHub and control callback→custodian
status. Compromise of one route must not create credential retrieval. Residual centralization,
software key copyability, provider revoke semantics, and vendor redirect/key-scope behavior block
production review.

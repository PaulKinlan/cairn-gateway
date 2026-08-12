# Cairn threat model

The Stage 0 model remains a regression baseline; this document adds the R1 private-control-plane
boundaries from `PLAN.md`.

Assets are custodian-held OAuth/API-key credentials, client P-256 private keys, owner sessions,
membership and grant authority, OAuth/enrollment flow material, connection state, provider and LLM
content, attempt integrity, and secret-free receipts. Treat models, local helpers, MCP/browser
inputs, IDs, callback fields, provider strings, stolen capabilities/references, stale catalogs,
redirects, vendor administration, and a second tenant as hostile.

Controls are tenant-partitioned records; tenant derived only from authenticated session/client
proof; purpose-bound login, provider, and enrollment flows; explicit fingerprint approval; proof of
possession; nonce/JTI CAS; strict short capabilities; call-time expiry/revocation; one-use dispatch
permits; fixed connectors and projections; bounded LLM input/output/cost; exclusive custody;
metadata-only logs/receipts; and global emergency deny. One connection may back many grants without
becoming client-owned.

Trust boundaries are owner browser→owner session→control UI, local helper/key store→MCP signing
bridge→gateway, gateway→authority/receipt store, gateway→custodian→GitHub/X/DeepSeek, and OAuth
callback→purpose-bound flow→custody status. API-key intake adds owner browser→top-level custodian
origin→custodian ingestion: the secret is necessarily transient in the browser but never traverses
Cairn. Login callbacks cannot complete connection flows or bootstrap ownership. Agent credentials
cannot read provider tokens or access custodian administration. Compromise of one route must not
create credential retrieval, tenant selection, or a generic request primitive.

Residual centralization, software key copyability, owner recovery before R5, provider revoke/delete
semantics, DeepSeek endpoint/model current-documentation verification, Nango static and approved
sandbox findings, X scopes, and the replacement durable-store topology block the relevant activation
gate.

## L1 local DeepSeek custody (2026-08-12)

The DeepSeek key is accepted only by the distinct top-level custodian origin and stored only through
Secret Service. Gateway/MCP authority can request the one typed operation using a random
process-lifetime dispatch credential, but cannot select URL, model, headers, tools, files, or raw
provider options and cannot read a credential. Provider errors and raw bodies are projected away;
receipts omit prompts and answers. Intake uses a masked input, bounded form, session, CSRF,
same-origin POST, no-store policy, and bodyless redirect. Custody enforces timeout, response
ceiling, concurrency, and daily request/token counters.

This reduces accidental/normal-surface disclosure, SSRF, generic proxy, log/receipt disclosure,
model override, unbounded cost, and stale-authority risks. Root, a hostile same-user process,
browser compromise, keyring compromise, and custodian memory inspection remain outside the local
isolation claim. Hosted promotion remains gated by R1/R3.

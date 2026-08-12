# ADR 0009: Local-first DeepSeek custody

- **Status:** Accepted
- **Date:** 2026-08-12

## Decision

L1 is the active product milestone. A separate loopback custodian on port 8788 owns the only API-key
form and uses `/usr/bin/secret-tool` with the secret on stdin. The gateway on port 8787 retains only
non-secret local metadata and uses a random process-lifetime dispatch credential for three closed
custodian routes: status, invoke the one fixed operation, and delete. The provider request is pinned
to `POST https://api.deepseek.com/chat/completions`, model `deepseek-v4-flash`, `stream: false`, and
thinking disabled. Official sources retrieved 2026-08-12:

- <https://api-docs.deepseek.com/api/create-chat-completion>
- <https://api-docs.deepseek.com/quick_start/pricing>

The verified exact endpoint/model are `https://api.deepseek.com/chat/completions` and
`deepseek-v4-flash`. This is documentation/configuration verification, not a live-call claim.

The browser intake is top-level, masked, session/CSRF protected, separately originated, and
redirects without a response body after success. MCP retains exactly four tools. No generic proxy is
added.

## Security boundary

This local same-user design prevents extraction through normal Cairn gateway, control, MCP, config,
URL, logs, receipts, and repository surfaces. It does **not** isolate the key from root, a hostile
same-user process, browser compromise, Secret Service compromise, or memory inspection of the
custodian during intake/invocation. Hosted protection is deferred to R1/R3 gates.

## Persistence

Secret Service is the sole durable credential store. Non-secret connection, grant-version, and
sanitized receipt metadata is stored at `~/.local/state/cairn/gateway/deepseek.json`. Conservative
daily request/token reservations are non-secret and stored separately at
`~/.local/state/cairn/custodian/deepseek-usage.json`. Each child receives read/write permission only
to its exact state directory. Both stores use validated bounded schemas and atomic restrictive-mode
replacement; missing/corrupt state fails closed rather than restoring authority or resetting quota.
On restart, the custodian rechecks Secret Service; no key re-entry is required when Secret Service
is available. The random dispatch credential is intentionally regenerated and never persisted.

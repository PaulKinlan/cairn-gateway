# Owner UI information architecture

This document defines the R1 private owner UI. [`PLAN.md`](../PLAN.md) is canonical.

## Navigation

The UI has five destinations only:

1. **Setup / Home** — authentication state, incomplete setup, configured-versus-healthy summary, and
   the next safe action.
2. **Connections** — GitHub, X, and the selected API-key LLM connection lifecycle.
3. **Agents** — named client principals; enrollment, key fingerprint/status, and grants are nested
   under each client rather than separate top-level areas.
4. **Activity** — allowlisted receipt/attempt outcomes and bounded usage/cost metadata.
5. **Security** — owner sessions, client/key revocation, security events, and destructive actions.

Do not add dashboards, marketplaces, provider catalogues, developer consoles, billing, or operator
administration to the private-alpha navigation.

## Connection presentation

Lifecycle states are:

`not_configured → pending → connected → reconnect_required → disconnected → deleted`

`error` is a recoverable diagnostic state with a bounded, non-secret reason and next action.

- **Configured** means a tenant-owned custody binding exists.
- **Healthy** is a separate value (`unknown`, `checking`, `healthy`, `unhealthy`) with a checked-at
  time and bounded reason. “Connected” must not be rendered as “healthy” without a check.
- **Disconnect** disables Cairn dispatch immediately, then reports provider-side revocation as
  `confirmed`, `pending`, `unsupported`, or `failed`. Stale grants remain visibly dead.
- **Reconnect** creates fresh connection authority. It never relabels revoked authority active.
- **Delete** requires confirmation, invokes verified custody deletion, and leaves a tenant-scoped
  tombstone/audit event so stale references cannot revive the connection.

A single connection page may list grants belonging to several clients. Connections are tenant-owned,
not client-owned.

## Secure API-key intake

The key form is authenticated, same-origin, CSRF-protected, rate-limited, and purpose-bound to one
pending connection. Submission goes directly to the approved custodian or one-use custody intake
endpoint. The stored value is never returned to the browser.

After submission show only provider, owner label, connection state, created/rotated time, last
health check, and—only if safely derived by custody—the last four fingerprint characters. Never
provide reveal, copy, download, debug, support-export, receipt, or log controls for a key. Do not
put the key in a URL, HTML, client state, analytics, command, config, or journal.

## Exact client enrollment handoff

1. Owner creates a named client and chooses grants nested under it.
2. UI displays a short-lived one-use enrollment reference. It cannot invoke and contains no client
   or provider secret.
3. A local helper accepts the reference through a non-secret prompt, generates and stores a P-256
   private key locally, submits only the public key plus proof of possession, and displays the
   thumbprint/fingerprint.
4. UI displays the same fingerprint and requires explicit owner approval. Approval binds the
   authenticated tenant, named client, key epoch, and selected grants atomically.
5. Helper writes non-secret Pi/MCP config and, if required, a local proof-signing bridge. Config may
   include service URL, client ID, public metadata, and a local key reference only.

Expiry, replay, fingerprint mismatch, cancellation, or an already-approved reference fails closed.
No enrollment reference grants invocation. No provider token or private key appears in HTML,
clipboard content, command arguments, config, logs, receipts, or the journal.

## Owner authentication

R1 must record one selection before implementation: an allowlisted immutable GitHub numeric user ID
or an external access layer with an immutable verified identity. Login and provider connection use
separate, purpose-bound OAuth flows and callback routes. A provider callback never establishes the
owner, and the first callback never wins ownership.

## Accessibility and safety

- All states have text labels; color is supplemental.
- Status, checked-at time, scope/operation, client, expiry, and revocation effect are keyboard and
  screen-reader accessible.
- Destructive controls name what stops locally and what is known about upstream revoke/deletion.
- Stale form, expired session/reference, duplicate submission, and concurrent revoke return a safe
  next action without exposing internal/provider errors.
- Secrets have no redisplay path, including error pages, browser history, retained form values, or
  support diagnostics.

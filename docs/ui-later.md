# Owner UI information architecture

This document defines the R1 private owner UI. [`PLAN.md`](../PLAN.md) is canonical.

## Navigation

The UI has five destinations only:

1. **Setup / Home** — authentication state, incomplete setup, configured-versus-healthy summary, and
   the next safe action.
2. **Connections** — GitHub, X, and the initial DeepSeek API-key connection lifecycle.
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

1. The authenticated Connections UI asks the selected custodian to create a short-lived,
   purpose-bound intake session for the pending tenant connection.
2. Cairn navigates Paul to a top-level page on the custodian origin. This is not an embedded or
   Cairn-hosted form.
3. The custodian page renders a masked input that is empty on every render. The value necessarily
   exists transiently in Paul's browser while he types/submits it, then posts directly to the
   custodian over HTTPS.
4. On submission the custodian clears/replaces the secret-bearing DOM and retains the value only in
   approved custody; ingestion memory is bounded and not logged. Cairn receives only an opaque
   connection reference and bounded status.

The value may exist transiently only in Paul's browser and custodian ingestion memory. It must never
enter Cairn HTML or DOM, Cairn application process/storage/logs, client framework state, URL or
history, analytics, clipboard, receipts, support output, config, commands, journal, or redisplay.
After submission show only provider, owner label, connection state, created/rotated time, last
health check, and—only if safely derived by custody—a short fingerprint suffix.

If the selected custodian cannot provide this exact flow, R3 remains blocked until the dedicated
custody service provides the equivalent. A normal Cairn form, including a server-rendered or
client-framework secret field posting through Cairn, is forbidden.

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

# Run Cairn locally

This path runs entirely on your machine. It uses a fixed GitHub user fixture, so no provider account
or credential is needed.

## Start

Use Deno 2.9.0 from the repository root:

```sh
deno task local:run
```

Open <http://127.0.0.1:8787/>. Cairn listens only on `127.0.0.1`; the MCP endpoint is
`http://127.0.0.1:8787/mcp`.

To choose another loopback port:

```sh
deno task local:run --port 8790
```

## Build fixture authority

Use the browser page in order:

1. **Create fixture owner.** This creates an empty local owner context and makes the fixed GitHub
   connection available.
2. **Label the agent.** Give the fixed fixture agent a short display label.
3. **Label the device and workload.** Use distinct labels. These labels map to Cairn's fixed,
   non-exported cryptographic test authority; this is not real key or workload enrollment.
4. **Create grant.** The closed policy allows `github.user.read@v1` for 24 hours and five successful
   calls. The page shows status, version, exact expiry, limit, and use.
5. **Invoke.** Use the local admin button or MCP. The page shows the projected fixture user, a
   sanitized receipt, and bounded recent usage. Refresh after an MCP call.
6. **Revoke.** Search, describe, connection status, and invoke all deny immediately.
7. **Create replacement grant.** Cairn creates a new version, expiry, and five-call usage window; it
   does not relabel the revoked grant as active.
8. **Reset fixture owner** when you want to erase all in-memory authority, receipts, and usage.

Admin mutations require a bounded local admin session and use POST, exact same-origin checks,
streaming body limits, and a rotating CSRF token. Stale forms fail closed; reload the page before
retrying. State resets when the process exits.

## Exact wire journey

The listener implements the wire-level Streamable HTTP lifecycle for MCP protocol version
`2025-06-18`. Requests use `POST /mcp` with `Content-Type: application/json` and an `Accept` header
containing both `application/json` and `text/event-stream`. Initialization returns an
`Mcp-Session-Id`; later requests send it with `MCP-Protocol-Version: 2025-06-18`.

After `initialize` and `notifications/initialized`, call the four stable tools in this order.

### 1. Search

```json
{
  "name": "search_capabilities",
  "arguments": { "query": "github user" }
}
```

### 2. Describe

```json
{
  "name": "describe_operation",
  "arguments": { "operation": "github.user.read@v1" }
}
```

### 3. Check the connection

```json
{
  "name": "connection_status",
  "arguments": { "connection": "connection_a" }
}
```

### 4. Invoke

```json
{
  "name": "invoke_operation",
  "arguments": {
    "operation": "github.user.read@v1",
    "connection": "connection_a",
    "arguments": {}
  }
}
```

The result contains only the fixed projected `fixture` GitHub user and a bounded receipt. No proof,
capability, signer, store, raw authority state, provider body, token, generic request input, or
caller-selected network destination is returned.

## Candidate VS Code configuration

The configuration below matches the endpoint. **VS Code candidate, not yet tested.**

```json
{
  "servers": {
    "cairn-local": {
      "type": "http",
      "url": "http://127.0.0.1:8787/mcp"
    }
  }
}
```

## Run the focused demo

```sh
deno task local:demo
```

It starts an actual loopback listener and proves onboarding, all four tools, visible receipt
creation, revoke-to-denial across all four tools, replacement version and expiry, reuse from the
first transport session, and a new-session reconnect.

Run all local checks or the complete regression gate with:

```sh
deno task check:local
deno task check
```

## Boundary

M1 passed independent review and the parent-run browser journey. It uses display labels mapped to
fixed test authority; real cryptographic enrollment and workload identity are M3 work. M1 does not
prove a named client, durable restart, real owner identity, real GitHub OAuth, credential custody,
hosted authority, or multi-user support. The public Deno preview remains a non-authority setup page.

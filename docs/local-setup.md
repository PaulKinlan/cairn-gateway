# Run Cairn locally

This path runs entirely on your machine. It uses the accepted fixture authority and a fixed GitHub
user response, so no provider account or credential is needed.

## Start the server

Use Deno 2.9.0 from the repository root:

```sh
deno task local:run
```

Open <http://127.0.0.1:8787/>. Cairn listens only on `127.0.0.1`; the MCP Streamable HTTP endpoint
is `http://127.0.0.1:8787/mcp`.

To choose another loopback port:

```sh
deno task local:run --port 8790
```

## Candidate VS Code configuration

Named-client validation belongs to Milestone 5. The configuration below matches the implemented HTTP
endpoint but has not completed a disposable VS Code initialize/list/call/reconnect acceptance run,
so it is a candidate rather than a support claim:

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

The endpoint implements the wire-level Streamable HTTP lifecycle for MCP protocol version
`2025-06-18`: JSON-RPC requests use `POST /mcp` with `Content-Type: application/json` and an
`Accept` header containing both `application/json` and `text/event-stream`. Initialization returns
an `Mcp-Session-Id`; later requests send that session ID and `MCP-Protocol-Version: 2025-06-18`. The
server returns JSON responses and does not offer a standalone SSE stream.

The included wire smoke lists tools and calls `invoke_operation` with:

```json
{
  "operation": "github.user.read@v1",
  "connection": "connection_a",
  "arguments": {}
}
```

The result contains the fixed `fixture` GitHub user. Use the browser page to test the same
operation, revoke the fixture grant, and reactivate it with a fresh usable expiry/version. The
default fixture grant lasts 24 hours; state is in memory and resets when the process exits.

## Verify the listener

Run the focused local checks and actual-listener smoke test:

```sh
deno task check:local
deno task local:smoke
```

The smoke test performs `initialize` → `notifications/initialized` → `tools/list` →
`invoke_operation` through a real loopback listener.

## Current boundary

This M1 submilestone proves a usable wire-level MCP and admin path over the fixture core. It does
not prove named-client compatibility or complete M1. Responses are fixtures; GitHub authorization,
production credential custody, authenticated remote administration, durable storage, and hosted MCP
authentication are not connected yet. The public Deno preview remains a non-authority setup page.

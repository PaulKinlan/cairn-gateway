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

## Connect VS Code

Create `.vscode/mcp.json` in the project you open with VS Code:

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

Start the `cairn-local` server from VS Code's MCP servers view. The endpoint implements Streamable
HTTP for MCP protocol version `2025-06-18`: JSON-RPC requests use `POST /mcp` with
`Content-Type: application/json` and an `Accept` header containing both `application/json` and
`text/event-stream`. Initialization returns an `Mcp-Session-Id`; later requests send that session ID
and `MCP-Protocol-Version: 2025-06-18`. The server returns JSON responses and does not offer a
standalone SSE stream.

Ask VS Code to list the tools, then call `invoke_operation` with:

```json
{
  "operation": "github.user.read@v1",
  "connection": "connection_a",
  "arguments": {}
}
```

The result contains the fixed `fixture` GitHub user. Use the browser page to test the same
operation, revoke the fixture grant, and reactivate it. State is in memory and resets when the
process exits.

## Verify the listener

Run the focused local checks and actual-listener smoke test:

```sh
deno task check:local
deno task local:smoke
```

The smoke test performs `initialize` → `notifications/initialized` → `tools/list` →
`invoke_operation` through a real loopback listener.

## Current boundary

This milestone proves a usable MCP and admin path over the fixture core. Responses are fixtures;
GitHub authorization, production credential custody, authenticated remote administration, durable
storage, and hosted MCP authentication are not connected yet. The public Deno preview remains a
non-authority setup page.

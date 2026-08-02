# Cairn Gateway

Cairn lets agents call revocable, typed provider operations without receiving provider credentials
or an arbitrary request surface. The current usable path is local and credential-free: a real MCP
client talks to the accepted fixture authority over Streamable HTTP.

## Run and connect

Requires Deno 2.9.0.

```sh
deno task local:run
```

Open <http://127.0.0.1:8787/>. The page shows the MCP endpoint, live fixture connection and grant
state, a VS Code configuration, and controls to invoke, revoke, and reactivate the fixture grant.

For VS Code, create `.vscode/mcp.json` in the project that will use Cairn:

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

Start `cairn-local` from VS Code's MCP servers view. Call `invoke_operation` with:

```json
{
  "operation": "github.user.read@v1",
  "connection": "connection_a",
  "arguments": {}
}
```

The response is the fixed `fixture` GitHub user. No GitHub authorization or production credential is
connected yet. See [the local setup guide](docs/local-setup.md) for the transport details, alternate
port command, and verification steps.

## Verify

```sh
deno task check:local
deno task check
```

`deno task local:smoke` starts an actual loopback listener and proves `initialize` →
`notifications/initialized` → `tools/list` → `invoke_operation`.

The full gate preserves the accepted 90 Stage 0 cases and coverage floors, the exact 24-scenario
Stage 1 durable-authority contract, and the separate public preview gate. It needs no package or
network changes.

## Product direction

[PLAN.md](PLAN.md) is the source of truth for the product, journeys, architecture, milestones,
acceptance criteria, current gaps, and prioritized work. Milestone 1 is this usable local fixture.
Production still needs admin identity and enrollment, durable storage, provider credential custody,
GitHub connection onboarding, hosted MCP authentication, receipts and usage, recovery, and operating
documentation.

## Public preview

The Deno deployment remains a credential-free setup page. `GET /` explains how to run the local
product, and `GET /healthz` returns its stable preview health document. Every method on `/mcp` and
`/mcp/legacy` remains permanently disabled with `403`; the deployment does not start an authority
service.

Run its dedicated gate with:

```sh
deno task check:preview
```

# Cairn Gateway

Cairn lets agents call revocable, typed provider operations without receiving provider credentials
or an arbitrary request surface. The current usable path is local and credential-free: an owner
builds fixture authority in the browser, then a real MCP wire client uses it over Streamable HTTP.

## Run the local product

Requires Deno 2.9.0.

```sh
deno task local:run
```

Open <http://127.0.0.1:8787/>. In the local admin page you can:

1. create or reset the fixture owner;
2. name an agent;
3. enroll a distinct device and workload;
4. create the fixed `github.user.read@v1` grant;
5. inspect its authority graph, 24-hour expiry, five-call limit, version, receipts, and recent use;
6. invoke through local admin or MCP; and
7. revoke the grant, observe denial, then create a usable replacement version.

The GitHub result is a fixed fixture. No provider account, OAuth flow, network request, or
production credential is used. All authority, receipts, usage, and admin sessions are bounded in
memory and are lost when the process stops.

## Connect over MCP

The endpoint is `http://127.0.0.1:8787/mcp`. Cairn keeps a stable four-tool front door:
`search_capabilities`, `describe_operation`, `connection_status`, and `invoke_operation`.

The following `.vscode/mcp.json` matches the endpoint, but remains a Milestone 5 candidate. The wire
demo is not a supported-client or VS Code acceptance claim.

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

See [the local setup guide](docs/local-setup.md) for the exact lifecycle and call bodies.

## Demo and verification

```sh
deno task local:demo
deno task check:local
deno task check
```

`deno task local:demo` starts an actual loopback listener and proves fixture onboarding, then:

```text
initialize → notifications/initialized
  → search_capabilities → describe_operation → connection_status → invoke_operation
  → visible receipt → revoke → all four deny
  → replacement grant version → invoke → reconnect → invoke
```

The full gate preserves the accepted 90 Stage 0 cases and coverage floors, the exact 24-scenario
Stage 1 durable-authority contract, and the separate public preview gate. It needs no package or
network changes.

## Product direction

[PLAN.md](PLAN.md) is canonical. M1 implementation is ready for independent review and browser
validation, but is not accepted from implementation or wire evidence alone. Production still needs
real admin identity and recovery, durable storage, provider credential custody, GitHub OAuth, hosted
MCP authentication, retention and deletion, named-client validation, and operating runbooks.

## Public preview

The Deno deployment remains a credential-free setup page. `GET /` explains how to run the local
product, and `GET /healthz` returns its stable preview health document. Every method on `/mcp` and
`/mcp/legacy` remains permanently disabled with `403`; the deployment does not start an authority
service.

Run its dedicated gate with:

```sh
deno task check:preview
```

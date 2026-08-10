# Cairn Gateway

Cairn's immediate product target is Paul's privately hosted control plane for agent sessions. It
will connect each provider once, keep credentials in dedicated custody, and let independently
enrolled clients invoke only fixed, typed operations through four MCP tools. Clients will never
receive provider tokens, and Cairn will never provide an arbitrary request surface. The current
implementation is the historical fixture/regression harness described below.

[PLAN.md](PLAN.md) is the canonical product plan. The active sequence is R0 documentation/model
reset, R1 real GitHub vertical slice, R2 X, R3 one API-key LLM, R4 fleet rollout, and R5 multiuser
readiness. A public fake-provider deployment is not a prerequisite.

## Target provider set

- GitHub OAuth: `github.user.read@v1`, fixed `GET /user`.
- X OAuth: `x.user.me.read@v1`, fixed `GET /2/users/me`; exact current scopes and host must be
  verified before R2 activation.
- DeepSeek API key: `deepseek.chat.complete@v1`, bounded messages/tokens/cost against an exact
  endpoint/model that the owner selects and pins only after current DeepSeek documentation is
  verified. The inventory confirms a verified standard DeepSeek Platform key. Kimi is a possible
  later connector, not initial scope; Cairn does not claim only one LLM credential is configured.

The MCP front door remains `search_capabilities`, `describe_operation`, `connection_status`, and
`invoke_operation`. There is no generic proxy, token export, caller-selected URL/method/header/base
URL/model, or raw provider response.

## Current repository state

The usable implementation remains a **historical local fixture/regression harness**, not the target
private control plane. It proves the four-tool wire lifecycle, P-256 proof/revocation/replay
invariants, fixed GitHub projection, and secret-free receipts without credentials or provider calls.
It uses in-memory authority and fixed GitHub data; state is lost on restart.

The existing public deployment is likewise a historical credential-free preview. Its MCP routes are
intentionally disabled. It is not R1 acceptance and need not be expanded before the real GitHub
slice.

Branch `feat/r1-foundation` adds an in-memory, credential-free executable R1 model and
server-rendered Connections/Agents views. Its focused journey proves two named P-256 clients sharing
one tenant-owned fixture connection, independent client revocation, disconnect/fresh reconnect, and
a synthetic second tenant. It does not add a provider call, hosted persistence, owner
authentication, OAuth, custody, deployment, or live GitHub. Run it with `deno task test:r1`.

The Stage 0 90-case suite, Stage 1 24-scenario contract, fixtures, and `docs/acceptance/` records
are preserved regression/historical assets. They do not prove hosted custody, a real provider, a
named client, or current milestone completion. The Deno KV global 64 KiB envelope candidate is
rejected; the latest direct candidate result is 27/28 with `DUR-24` unresolved.

## Run the historical local fixture

Requires Deno 2.9.0.

```sh
deno task local:run
```

Open <http://127.0.0.1:8787/>. The local page can create fixture authority, label the fixed fixture
agent/device/workload, grant `github.user.read@v1`, invoke over MCP, inspect metadata-only receipts,
revoke, replace, and reconnect.

The fixture endpoint is `http://127.0.0.1:8787/mcp`. The following is illustrative wire
configuration only; VS Code compatibility has not been accepted:

```json
{
  "servers": {
    "cairn-local-fixture": {
      "type": "http",
      "url": "http://127.0.0.1:8787/mcp"
    }
  }
}
```

See [docs/local-setup.md](docs/local-setup.md) for the historical fixture lifecycle.

## Verification

```sh
deno task local:demo
deno task check:local
deno task check
```

`deno task check` retains the fixture, durability-contract, preview, and local-product gates as
regressions. The opt-in Deno KV candidate task is not part of the canonical full gate and is not a
supported storage path.

## Security and delivery

- Read [PLAN.md](PLAN.md), [the pivot ADR](docs/adr/0007-private-control-plane-reset.md),
  [security invariants](docs/security-invariants.md), and [the threat model](docs/threat-model.md).
- R1 must decide owner authentication and custody before any real activation.
- Nango receives a time-boxed credential-free static review first. A behavioral sandbox uses only
  dedicated test credentials and requires explicit approval; rejection falls back to dedicated
  KMS-backed custody without blocking unrelated R1 implementation.
- API-key intake is a top-level, short-lived custodian-hosted session. The value exists transiently
  only in Paul's browser and custodian ingestion memory and never passes through Cairn.
- Enrollment emits only non-secret Pi/MCP configuration. Provider tokens and local P-256 private
  keys never enter HTML, clipboard data, command arguments, config, logs, receipts, or the journal.
- This reset authorizes documentation only: no credentials, providers, provisioning, deployment, or
  runtime changes.

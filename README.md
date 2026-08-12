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

## Current implementation

Cairn has substantial durability code, but **no durable adapter is connected to the served product
yet**. Do not confuse “not wired into the runtime” with “not implemented in the repository.”

| Surface                                       | Storage today                                                             | What it proves                                                                                                                                                                                                        |
| --------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local fixture (`deno task local:run`)         | `MemoryStore`                                                             | Four-tool MCP lifecycle, P-256 enrollment/revocation/replay, fixed GitHub projection, and secret-free receipts. State is lost when the process stops.                                                                 |
| R1 foundation on `main` (`deno task test:r1`) | In-memory tenant-partitioned maps                                         | Two named P-256 clients sharing one tenant-owned connection, independent revocation, disconnect/fresh reconnect, and synthetic second-tenant isolation. State is lost when the process stops.                         |
| Stage 1 durability reference adapter          | Atomic disk-backed `authority.json` behind `DurableAuthorityTransactions` | The unchanged 24-scenario restart, concurrency, replay, migration, restore, and crash-boundary contract across independent Deno processes. This is deliberately test-only reference machinery, not the product store. |
| Deno KV candidate                             | Real local file-backed `Deno.openKv()` with strong reads and CAS          | A production-store experiment. It is not used by the runtime and is rejected in its current global single-value form: the complete graph hits a 64 KiB ceiling and the latest run is 27/28 with `DUR-24` unresolved.  |
| Public deployment                             | None                                                                      | Credential-free historical preview only. `/mcp` is intentionally disabled.                                                                                                                                            |

The missing implementation is therefore specific: a **tenant-partitioned durable adapter must be
connected to the R1 authority service, owner UI, receipts, and hosted MCP runtime**. It must satisfy
the existing durability contract without the rejected global 64 KiB envelope. Until that is done,
Cairn is not restart-safe or usable as the hosted control plane.

The accepted Stage 0 base had 90 cases. The current Stage 0 denominator is 96: that historical base
plus six cases in the two pinned enrollment-wiring test files. The Stage 1 24-scenario contract,
fixtures, and `docs/acceptance/` records are preserved regression/historical assets. They prove real
durability behavior at the contract/reference-adapter boundary, but not hosted product persistence,
provider custody, OAuth, or a live provider.

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
- The credential-free R1 authority/UI foundation is implemented on `main`; real credentials,
  provider calls, provisioning, deployment, and production mutation remain unactivated.

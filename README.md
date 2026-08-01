# Cairn Gateway (provisional internal name)

The independently accepted Stage 0 fixture is exact commit
`25ee6526f683fbd4aa1e955b93c3eb3adf53211d`. It remains an immutable 90-test, offline-only provenance
base, not a deployable or rollback revision.

Stage 1A adds only adapter-neutral durable-authority contracts and an offline file-backed reference
conformance harness. The reference adapter qualifies the 24-scenario contract; it is not a selected
production database. `deno task check:stage0` preserves the exact Stage 0 denominator and coverage
floors (84.0% branch, 96.3% function, 90.6% line). `deno task check:stage1` runs exactly 24 durable
scenarios. The Stage 1 denominator consumes actual JUnit execution names and rejects missing,
duplicate, skipped, ignored, filtered, or failed events. The accepted authority foundation remains
exactly 114 cases with zero skips; `deno task check` additionally runs the separate 12-test preview
gate.

No live invocation listener, live adapter, credential or environment access, remote import, vendor
request, mutable management UI, or production provider resource exists. Storage, production key
custody, MCP SDK and named clients, callback topology, revocation promise, and retention remain
unresolved activation blockers. Stage 1A qualifies an opaque durable `reserved` → `dispatching`
permit claim followed by adapter-neutral atomic `startDispatch` consumption; only that one-use
result authorizes dispatch. The same neutral envelope and maintenance interface cover export,
inspection, restore, migration, and recovery behind explicit privileged maintenance context. The
candidate-factory conformance path also exercises abrupt worker death while holding the logical file
lock and bounded stale-lock recovery. This remains test-only logical commit evidence, not filesystem
fsync/power-loss durability or external exactly-once execution; `unknown_commit` and
`dispatch_unknown` are durable ambiguity states and are never automatically retried. Concrete
seed/view helpers are isolated behind the fixture driver.

Requires exact Deno 2.9.0. No network or package changes are needed.

## Credential-free public preview

`preview/main.ts` is an isolated Deno Deploy status and architecture surface with a default exported
fetch handler. It does not start a listener or access environment variables, credentials, storage,
vendors, remote assets, or package dependencies. Integration invocation is disabled. The page
identifies accepted public revision `08dc01a03ef229e40ff356da2eb03c3f01cf7a96` and its 114-case
offline gate without representing the fixture as production-ready or MCP-conformant.

Routes are exact: `GET /` serves the status page, `GET /healthz` serves canonical JSON, and every
method on `/mcp` or `/mcp/legacy` returns a permanent `403` disabled response. Other known-route
methods return `405`; unknown paths and paths with query strings return `404`.

Run the permission-free local handler smoke check with `deno task preview:run`, its tests with
`deno task test:preview`, or the dedicated format/lint/type/test gate with
`deno task check:preview`. Deno Deploy is configured at the repository root with the exact runtime
entrypoint `preview/main.ts`; it consumes the default export and requires no environment setup.

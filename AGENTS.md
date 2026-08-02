# Cairn Gateway agent rules

Read `PLAN.md` before planning or changing Cairn. It is canonical. Map every task to one active
milestone and one end-to-end journey; update plan scope/status in the same commit when either
changes. The 90 Stage 0 cases and 24 Stage 1 scenarios are regression gates, not the product or a
measure of progress. Tests, status/health pages, prose, and security findings alone do not complete
a milestone.

Build the user-visible deliverable for the active milestone and publish a safe testable preview by
default when that milestone's gate permits it. Planned admin UI, OAuth callback, fixed provider
adapter, credential custody, durable store, named-client, and private deployment work are allowed
only in their PLAN milestone and only after its listed decisions and security gates are satisfied.
Obey any task-specific no-push/no-deploy restriction. Get explicit approval before credential use,
production changes, destructive actions, private-data exposure, or material cost.

Never print, return, log, journal, transmit, or commit provider credentials, tokens, signing
material, or secret values. Never add a generic proxy/request/token/credential export, arbitrary
URL/header/ method, base URL override, caller-selected destination, raw provider response, or
credential-reveal surface. Only the selected custodian/provider adapter may read provider
credentials for a fixed, typed, reviewed operation.

Keep acceptance evidence with the change: exact commit, milestone/journey, owner and agent actions,
demo/runbook, URL or N/A, tests, review decision, and residual blocker. Run `deno task check` before
a local commit.

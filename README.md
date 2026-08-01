# Cairn Gateway (provisional internal name)

Stage 0 is a fixture-complete offline security core for one immutable GitHub identity read
operation. It models multi-tenant ownership, signed devices, strict one-call capabilities, atomic
replay and revocation checks, a narrow custody boundary, safe projection/receipts, and stable MCP
semantics. It contains no live adapter, secrets, deployment code, UI, provider token surface, or
remote.

Requires Deno 2.9.0. Run `deno task check`. Live activation is blocked by the verification ledger
and independent review gates.

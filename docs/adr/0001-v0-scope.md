# ADR 0001: Stage 0 is an offline, proxy-only fixed operation core

**Status:** Accepted for Stage 0 — 2026-08-01

Use cryptographic principals, two separately revocable device keys, five-minute one-call ES256
capabilities, composite tenant ownership, and a custody adapter that can only execute compiled
operations. Implement only `github.user.read@v1`. Keep all provider and deployment integration
behind blocked interfaces until official behavior and independent reviews are complete.

Deferred: Nango adapter, live callback, Deno KV/Deploy, extra catalog entries, passkey UI,
production recovery, enterprise identity, setup copilot, billing, management UI, token export, and
generic HTTP.

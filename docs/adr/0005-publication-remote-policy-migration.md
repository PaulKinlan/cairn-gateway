# ADR 0005: Exact public-origin publication policy migration

- **Status:** User-authorized policy migration; independent review required before push
- **Accepted Stage 1A parent:** `08dc01a03ef229e40ff356da2eb03c3f01cf7a96`

## Context

Paul corrected the former no-remote policy and authorized public, testable publication by default.
The shared repository now has the expected public origin. This change does not authorize a push
before independent review and does not authorize credentials, vendors, production authority
activation, production custody, or network use by authority runtime/tests. The isolated
credential-free status preview has its own review and deployment boundary.

## Decision

The repository must have exactly one remote named `origin`, exactly URL
`https://github.com/PaulKinlan/cairn-gateway.git`, exactly fetch refspec
`+refs/heads/*:refs/remotes/origin/*`, and no explicit push URL. Any wrong name, wrong URL, changed
refspec, explicit push URL, additional remote, or configured/effective fetch or push URL altered by
Git URL rewriting fails closed.

The sole obsolete Stage 0 assertion was migrated without changing its test count or any other Stage
0 test file/assertion:

- before SHA-256: `6ab9888d577cf70ef3f468b3443700eb311048961771d79c8d13bb8a4091b71f`
- after SHA-256: `d0d71c6fc284aa2564015e908675da343c33c5522ceb2dda74adeb13f11adfd6`

`stage0_denominator.ts` now requires descent from both the original Stage 0 base and accepted Stage
1A, permits exactly that one-file/hash migration, and preserves exactly 90 tests. The security gate
and regression inputs enforce the same exact-origin policy. This is publication metadata policy, not
an authority/runtime relaxation: fetch, listeners, credentials, environment access, provider calls,
production authority deployment and production adapters remain forbidden in this public-preview
release.

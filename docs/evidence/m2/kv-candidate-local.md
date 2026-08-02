# M2 evidence: Deno KV candidate adapter (local, offline-only)

- **Status:** local candidate evidence only. Not production storage evidence, not hosted-topology
  qualification, and not M2 acceptance. ADR 0003's selection remains "implementation and hosted
  qualification pending".
- **Code commit:** `5cd99d0` on `feature/m2-kv-adapter` (base `bfcd09c`).
- **Runtime:** Deno 2.8.1 (stable, release, x86_64-unknown-linux-gnu; v8 14.9.207.2-rusty). No
  network access was used; no credentials, hosted KV, or Deno Deploy provisioning of any kind.
- **Run command:** `deno task test:stage1:kv-candidate` (= `deno check --unstable-kv` of the
  candidate files, then
  `CAIRN_STAGE1_CANDIDATE=deno-kv deno test --unstable-kv
  --allow-env=CAIRN_STAGE1_CANDIDATE --allow-read --allow-write --allow-run
  tests/stage1/durability_contract.test.ts tests/stage1/kv_candidate_limits.test.ts`).

## Scenario results

- **All 24 unchanged scenarios DUR-01..DUR-24 pass** against the Deno KV candidate (plus 4 KV-CAND
  limit/guard tests: 28 passed, 0 failed total). Repeated full-suite runs passed consecutively (3/3
  after the contention fixes described below).
- Scenario names, counts, seeds, scenario JSON, and the conformance assertions are untouched. The
  canonical denominator gate (`deno task stage1:denominator`) still reports exactly 24 executed pass
  events against the offline file reference and was re-run green at this commit, as were `fmt`,
  `lint`, `typecheck`, `stage0:preflight`, and `test`.
- Candidate selection is opt-in via `CAIRN_STAGE1_CANDIDATE=deno-kv`; canonical tasks grant no env
  access, so the factory's default is byte-for-byte the previous offline-reference behavior. The KV
  candidate is not part of the canonical denominator run.

## Adapter mapping (tests/stage1/fixtures/deno_kv_candidate_adapter.ts)

- **Storage:** local file-backed `Deno.openKv("<root>/authority.kv")` only. KV-CAND-01 proves the
  durable state lives in the KV database and that no `authority.json` file-reference store exists.
- **Envelope mapping:** the whole `DurableAuthorityEnvelope` is stored as canonical
  `serializeDurableAuthority` bytes under the single fixed key
  `["cairn", "m2_kv_candidate", "authority_envelope"]`. A single-envelope key was chosen because the
  contract's smallest CAS transitions mutate more distinct records (seed writes 7, an invocation
  reservation writes 4) than the published 10-check atomic budget would let a per-record-key mapping
  CAS independently; one envelope value keeps every multi-record mutation atomic by construction.
- **CAS:** every transition is exactly one
  `atomic().check({ key, versionstamp }).set(key, bytes).commit()`; conflicts re-read and re-run the
  pure operation (bounded at 128 attempts, then fail closed).
- **Reads:** every authority read uses `{ consistency: "strong" }` (local file-backed KV cannot
  actually differentiate strong vs eventual — see gaps).
- **Logic reuse:** the candidate subclasses `OfflineReferenceAuthority` and overrides only
  `initialize`/`read`/`locked`, so the 24 scenarios exercise the identical validation and mutation
  logic as the accepted reference; visibility of `locked`/`injectedFault` was widened
  private→protected and the lock acquisition extracted (behavior-neutral).
- **Crash scenarios:** the shared file-lock protocol (atomic hard-link acquisition with complete
  owner metadata prepared first, bounded dead-owner recovery via pid probe) is retained around the
  KV critical section so the unchanged DUR-08..DUR-12 assertions on lock metadata and recovery hold
  verbatim. Crash faults exit the worker process immediately before/after the KV commit, bounding
  the same logical commit point. As with the reference, this qualifies logical commit boundaries
  only: there is no fsync or power-loss claim.

## Published limits encoded and measured guard behavior

Named constants in `deno_kv_candidate_adapter.ts` (per Deno KV manual limits documentation, from
offline documentation knowledge of the Deno 2.8.x era — this task ran offline-only, so these MUST be
re-verified against the live published limits before any hosted qualification):

| Limit                         | Published | Guarded as                            |
| ----------------------------- | --------- | ------------------------------------- |
| Encoded key size              | 2 KiB     | `DENO_KV_MAX_KEY_BYTES = 2048`        |
| Value size                    | 64 KiB    | `DENO_KV_MAX_VALUE_BYTES = 65536`     |
| Atomic checks                 | 10        | `DENO_KV_MAX_ATOMIC_CHECKS = 10`      |
| Atomic mutations              | 1000      | `DENO_KV_MAX_ATOMIC_MUTATIONS = 1000` |
| Atomic mutation payload (sum) | 800 KiB   | `DENO_KV_MAX_ATOMIC_MUTATION_BYTES`   |

The commit guard fires strictly BEFORE the value ceiling: a value may commit only if
`bytes + 64 (encoding headroom) <= 65536`, i.e. at most 65472 serialized bytes. Guard breaches raise
`DenoKvLimitError` before any KV write is attempted.

- **KV-CAND-02 (boundary):** exact-limit values pass; one unit past each limit throws
  `DenoKvLimitError` naming the breached limit.
- **KV-CAND-03 (real commit path):** growing the envelope with valid replay records, the guard fired
  on the 294th growth commit (293 committed); the stored value reached **65299 of 65536 published
  bytes (guarded ceiling 65472)** and the rejected transaction left zero partial state (record count
  and authority generation unchanged, failed replay key absent, store still exports/validates).
- **KV-CAND-04:** corruption injected straight into the KV value denies on the next strong read;
  KV-layer snapshot install restores; oversized/missing snapshots fail closed.
- Every commit in the 24 scenarios uses 1 check + 1 mutation, far inside the atomic budgets.

## Contention behavior observed while qualifying

- Cross-process concurrent atomic writes and `Deno.openKv` against one local database surface
  `database is locked` (SQLITE_BUSY) as a hard error, not a versionstamp conflict. Mitigations in
  the candidate: the shared file lock serializes local writers before any KV write (so cooperating
  processes never contend), and `openKv` busy errors get bounded retries (500 attempts, ~1–7 ms
  backoff, then fail closed). DUR-02/03/04/05/07/16/24 then pass consistently.
- This means the local run does NOT evidence KV-native CAS contention behavior: with the lock, the
  versionstamp check is defense-in-depth rather than the primary exclusion mechanism.

## Honest gap list for the later hosted topology (all remain M2 blockers)

1. **US storage/transit:** per ADR 0003, hosted KV data is stored in and transits through the United
   States per current Deno documentation; explicit owner acknowledgement is a pre-private-data gate.
   Nothing here addresses it.
2. **Strong-read semantics hosted:** local file-backed KV cannot differentiate
   `{ consistency: "strong" }` from `"eventual"`; strong-read behavior and its latency cost must be
   re-evidenced against the exact hosted topology.
3. **KV-native CAS contention:** the local lock serializes writers; a hosted deployment has no file
   lock. Remote races, CAS retry behavior under real contention, and ambiguous commit/dispatch must
   be re-proven without it (ADR 0003 already requires remote races).
4. **Backup/restore:** Deno documents customer-controlled backup streaming but, per ADR 0003, not
   yet a complete managed restore procedure, retention, or measured RPO/RTO. The KV-layer snapshot
   install used here is fixture machinery, not a restore drill; export/restore proof and
   stale/corrupt rejection against the hosted store remain open (M2 decision "Backup and recovery").
5. **Unstable API:** `Deno.openKv` requires `--unstable-kv` under Deno 2.8.1. The flag is wired only
   into `test:stage1:kv-candidate`; hosted use depends on an unstable API whose surface may change,
   and the structural typing used here must be re-checked on upgrade.
6. **Published limits drift:** the encoded limits come from offline documentation knowledge;
   re-verify against live docs (and any hosted-specific atomic/throughput limits) before
   qualification.
7. **64 KiB envelope ceiling:** the single-envelope mapping makes the published value limit a hard
   capacity ceiling for the whole authority graph (observed guard trip at ~293 growth records on top
   of a seeded owner graph in this fixture). Before production data, decide: chunked/multi-key
   envelope mapping with its own atomicity analysis, or an explicit documented capacity bound with
   the fail-closed guard as the enforcement point.
8. **Latency and cost:** no latency distribution or hosted cost was measured locally; the decision
   register requires measured latency and cost for the exact topology.
9. **Durability claim scope:** local sqlite commits without an fsync/power-loss drill; hosted
   durability semantics (FoundationDB-backed) differ and must be evidenced separately, including
   crash/restart drills against the exact deployment.
10. **Receipt retention/deletion:** still an open M2 policy decision; this adapter evidence does not
    cover receipt deletion scenarios beyond the unchanged contract suite.

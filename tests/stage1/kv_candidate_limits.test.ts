import { assert, equals, rejects } from "../assert.ts";
import { ids, type TenantContext } from "../../packages/core/src/domain/types.ts";
import { replayKey } from "../../packages/core/src/store/keys.ts";
import { serializeDurableAuthority } from "../../packages/core/src/store/schema.ts";
import {
  assertDenoKvCommitWithinLimits,
  DENO_KV_MAX_ATOMIC_CHECKS,
  DENO_KV_MAX_ATOMIC_MUTATION_BYTES,
  DENO_KV_MAX_ATOMIC_MUTATIONS,
  DENO_KV_MAX_KEY_BYTES,
  DENO_KV_MAX_VALUE_BYTES,
  DENO_KV_VALUE_GUARD_HEADROOM_BYTES,
  DenoKvCandidateAuthority,
  DenoKvLimitError,
} from "./fixtures/deno_kv_candidate_adapter.ts";
import {
  candidateAdapterKind,
  createCandidateAdapter,
} from "./fixtures/candidate_adapter_factory.ts";

const alice = { tenantId: "tenant_a", userId: "user" };
const ctx = (): TenantContext => ({
  tenantId: ids.tenant(alice.tenantId),
  userId: ids.user(alice.userId),
});
const guardedValueCeiling = DENO_KV_MAX_VALUE_BYTES - DENO_KV_VALUE_GUARD_HEADROOM_BYTES;
const limitError = async (fn: () => unknown): Promise<DenoKvLimitError> => {
  try {
    await fn();
  } catch (error) {
    assert(error instanceof DenoKvLimitError, `expected DenoKvLimitError, got ${error}`);
    return error;
  }
  throw new Error("expected DenoKvLimitError");
};

// These tests are candidate evidence only. They run solely under `deno task
// test:stage1:kv-candidate` and are never part of the canonical Stage 1A denominator.

Deno.test("KV-CAND-01: kv-candidate task drives the factory to a real Deno KV store", async () => {
  // Evidence-integrity guard: a run that silently fell back to the file reference fails here.
  equals(candidateAdapterKind(), "deno-kv");
  const root = await Deno.makeTempDir({ prefix: "cairn_kv_cand01_" });
  try {
    const candidate = createCandidateAdapter(root);
    const fixture = candidate.fixture as DenoKvCandidateAuthority;
    assert(fixture instanceof DenoKvCandidateAuthority, "factory did not select the KV candidate");
    equals(await candidate.fixture.seed(alice), true);
    const view = await candidate.fixture.inspect(alice);
    equals(view.exists, true);
    // Durable state lives in the KV database file; the file-reference JSON store must not exist.
    await Deno.stat(fixture.kvPath);
    let referenceStoreExists = true;
    try {
      await Deno.stat(fixture.statePath);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      referenceStoreExists = false;
    }
    equals(referenceStoreExists, false);
    await fixture.close();
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("KV-CAND-02: commit guard enforces every published Deno KV limit boundary", () => {
  const base = { keyBytes: 128, valueBytes: 1024, checks: 1, mutations: 1, mutationBytes: 1024 };
  assertDenoKvCommitWithinLimits(base);
  // Boundary values pass; one unit past each published limit fails closed.
  assertDenoKvCommitWithinLimits({ ...base, keyBytes: DENO_KV_MAX_KEY_BYTES });
  assertDenoKvCommitWithinLimits({ ...base, valueBytes: guardedValueCeiling });
  assertDenoKvCommitWithinLimits({ ...base, checks: DENO_KV_MAX_ATOMIC_CHECKS });
  assertDenoKvCommitWithinLimits({ ...base, mutations: DENO_KV_MAX_ATOMIC_MUTATIONS });
  assertDenoKvCommitWithinLimits({ ...base, mutationBytes: DENO_KV_MAX_ATOMIC_MUTATION_BYTES });
  return Promise.all([
    limitError(() =>
      assertDenoKvCommitWithinLimits({ ...base, keyBytes: DENO_KV_MAX_KEY_BYTES + 1 })
    ),
    limitError(() =>
      assertDenoKvCommitWithinLimits({ ...base, valueBytes: guardedValueCeiling + 1 })
    ),
    limitError(() =>
      assertDenoKvCommitWithinLimits({ ...base, checks: DENO_KV_MAX_ATOMIC_CHECKS + 1 })
    ),
    limitError(() =>
      assertDenoKvCommitWithinLimits({ ...base, mutations: DENO_KV_MAX_ATOMIC_MUTATIONS + 1 })
    ),
    limitError(() =>
      assertDenoKvCommitWithinLimits({
        ...base,
        mutationBytes: DENO_KV_MAX_ATOMIC_MUTATION_BYTES + 1,
      })
    ),
  ]).then((errors) => {
    assert(
      errors.every((error) => /deno kv .*exceeds/.test(error.message)),
      "limit errors must name the breached published limit",
    );
  });
});

Deno.test("KV-CAND-03: real commit path fails closed before the 64 KiB value limit", async () => {
  const root = await Deno.makeTempDir({ prefix: "cairn_kv_cand03_" });
  const adapter = new DenoKvCandidateAuthority(root);
  try {
    equals(await adapter.seed(alice), true);
    const exportContext = adapter.issueAuthorityMaintenanceContext({
      actorId: "kv_limits_operator",
      purpose: "export",
    });
    const before = await adapter.exportAuthority(exportContext);
    const baseRecords = Object.keys(before.records).length;
    let committed = 0;
    let guardFailure: DenoKvLimitError | null = null;
    // Grow the single-envelope value with valid replay records until the guard denies a commit.
    for (let index = 0; index < 2000; index++) {
      try {
        const result = await adapter.consumeReplay(ctx(), {
          records: [{ kind: "nonce", hash: `pad_${index}` }],
          expiresAt: 1_000_000,
          now: 10,
        });
        equals(result.outcome, "committed");
        committed++;
      } catch (error) {
        assert(error instanceof DenoKvLimitError, `expected DenoKvLimitError, got ${error}`);
        guardFailure = error;
        break;
      }
    }
    assert(guardFailure !== null, "guard never fired within 2000 growing commits");
    assert(
      guardFailure.message.includes(`${DENO_KV_MAX_VALUE_BYTES}`),
      "guard error must cite the published 64 KiB value limit",
    );
    const after = await adapter.exportAuthority(exportContext);
    // Fail-closed: the denied transaction committed nothing — no partial record, no generation bump.
    equals(Object.keys(after.records).length, baseRecords + committed);
    equals(after.authorityGeneration, before.authorityGeneration + committed);
    equals(after.records[replayKey(ctx(), "nonce", `pad_${committed}`)], undefined);
    const storedBytes = serializeDurableAuthority(after).length;
    // The store never exceeded the guarded ceiling, and the guard genuinely approached the
    // published limit rather than firing implausibly early.
    assert(
      storedBytes <= guardedValueCeiling,
      `stored value ${storedBytes} bytes exceeds guarded ceiling ${guardedValueCeiling}`,
    );
    assert(
      storedBytes > DENO_KV_MAX_VALUE_BYTES / 2,
      `guard fired implausibly early at ${storedBytes} bytes`,
    );
    console.log(
      `kv-candidate-limit: guard fired after ${committed} growth commits; ` +
        `stored ${storedBytes}/${DENO_KV_MAX_VALUE_BYTES} bytes (ceiling ${guardedValueCeiling})`,
    );
    await adapter.close();
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("KV-CAND-04: kv-layer corruption denies; kv-layer snapshot install restores", async () => {
  const root = await Deno.makeTempDir({ prefix: "cairn_kv_cand04_" });
  const adapter = new DenoKvCandidateAuthority(root);
  try {
    equals(await adapter.seed(alice), true);
    const exportContext = adapter.issueAuthorityMaintenanceContext({
      actorId: "kv_limits_operator",
      purpose: "export",
    });
    // Mirror the worker's snapshot action: canonical bytes of the exported envelope.
    const snapshot = `${root}/snapshot.json`;
    await Deno.writeFile(
      snapshot,
      serializeDurableAuthority(await adapter.exportAuthority(exportContext)),
    );
    // Corruption injected straight into the KV value fails validation on the next strong read.
    await adapter.injectRawMutation({ path: "effectiveNow", value: -1 });
    await rejects(() => adapter.inspect(alice));
    // KV-layer snapshot install restores the last known-good envelope verbatim.
    await adapter.installSnapshot(snapshot);
    const restored = await adapter.inspect(alice);
    equals(restored.exists, true);
    // Oversized or missing snapshots fail closed before any write.
    const oversized = `${root}/oversized.json`;
    await Deno.writeFile(oversized, new Uint8Array(DENO_KV_MAX_VALUE_BYTES + 1));
    await limitError(() => adapter.installSnapshot(oversized));
    await rejects(() => adapter.installSnapshot(`${root}/missing.json`));
    const after = await adapter.inspect(alice);
    equals(after.exists, true);
    await adapter.close();
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  }
});

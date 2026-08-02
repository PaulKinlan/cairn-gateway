import type { DurableAuthorityEnvelope } from "../../../packages/core/src/store/schema.ts";
import {
  assertAuthorityCryptography,
  assertAuthorityEnvelope,
  serializeDurableAuthority,
} from "../../../packages/core/src/store/schema.ts";
import {
  authorityDecodeText,
  authorityJsonParse,
} from "../../../packages/core/src/store/intrinsics.ts";
import {
  emptyEnvelope,
  type FaultPoint,
  OfflineReferenceAuthority,
} from "./offline_reference_adapter.ts";

/**
 * M2 Deno KV candidate durable-authority adapter (ADR 0003). Local file-backed `Deno.openKv()`
 * only: no network, no hosted KV, no credentials. This is candidate qualification evidence, not
 * production storage evidence and not hosted-topology acceptance.
 *
 * Envelope mapping: the whole `DurableAuthorityEnvelope` is stored as canonical
 * `serializeDurableAuthority` bytes under one fixed key. Every CAS transition is exactly one
 * versionstamp-checked `atomic().check(...).set(...).commit()`; every authority read uses
 * `{ consistency: "strong" }`. A single-envelope key is deliberate: the contract's smallest CAS
 * transitions already mutate more distinct records (seed writes 7, reservation writes 4) than the
 * published 10-check atomic budget would allow a per-record-key mapping to CAS independently, and
 * one envelope value keeps every multi-record mutation atomic by construction. Local
 * cross-process writers are additionally serialized by the reference adapter's shared
 * crash-recovery file lock so the unchanged crash scenarios keep their exact lock-metadata and
 * bounded dead-owner recovery assertions; the lock is local test topology, not a KV claim.
 *
 * `Deno.openKv` is unstable under the repo's Deno (2.8.1), so the API is reached through a narrow
 * structural type: canonical gates type-check this file without `--unstable-kv`, and only the
 * dedicated `test:stage1:kv-candidate` task enables the flag.
 */

// Published Deno KV limits, per the Deno KV manual (docs.deno.com KV "Limits" / atomic-operation
// documentation) as known at implementation time. This task ran offline-only, so these values are
// from documentation knowledge current for the Deno 2.8.x era and MUST be re-verified against the
// live published limits before any hosted qualification. The guard below fails closed strictly
// before any of these ceilings can be reached by a commit.
/** Published: a single encoded KV key may not exceed 2 KiB. */
export const DENO_KV_MAX_KEY_BYTES = 2048;
/** Published: a single KV value may not exceed 64 KiB. */
export const DENO_KV_MAX_VALUE_BYTES = 65536;
/** Published: one atomic operation may check at most 10 keys. */
export const DENO_KV_MAX_ATOMIC_CHECKS = 10;
/** Published: one atomic operation may contain at most 1000 mutations. */
export const DENO_KV_MAX_ATOMIC_MUTATIONS = 1000;
/** Published: the summed size of all mutations in one atomic operation may not exceed 800 KiB. */
export const DENO_KV_MAX_ATOMIC_MUTATION_BYTES = 800 * 1024;
/**
 * Conservative allowance for KV's structured-clone encoding overhead around the stored
 * Uint8Array, so the guard trips strictly BEFORE the published 64 KiB value ceiling rather than
 * at it. The adapter never lets a value within this headroom of the published limit commit.
 */
export const DENO_KV_VALUE_GUARD_HEADROOM_BYTES = 64;

/** Fail-closed error raised before any commit that would exceed a published Deno KV limit. */
export class DenoKvLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DenoKvLimitError";
  }
}

/** Guard evaluated before every KV write; any breach denies the commit before it is attempted. */
export function assertDenoKvCommitWithinLimits(input: {
  keyBytes: number;
  valueBytes: number;
  checks: number;
  mutations: number;
  mutationBytes: number;
}): void {
  if (!(input.keyBytes > 0 && input.keyBytes <= DENO_KV_MAX_KEY_BYTES)) {
    throw new DenoKvLimitError(
      `deno kv key ${input.keyBytes} bytes exceeds published ${DENO_KV_MAX_KEY_BYTES}-byte limit`,
    );
  }
  if (
    !(input.valueBytes >= 0 &&
      input.valueBytes + DENO_KV_VALUE_GUARD_HEADROOM_BYTES <= DENO_KV_MAX_VALUE_BYTES)
  ) {
    throw new DenoKvLimitError(
      `deno kv value ${input.valueBytes} bytes exceeds guarded ceiling ${
        DENO_KV_MAX_VALUE_BYTES - DENO_KV_VALUE_GUARD_HEADROOM_BYTES
      } (published ${DENO_KV_MAX_VALUE_BYTES}-byte limit minus headroom)`,
    );
  }
  if (!(input.checks >= 0 && input.checks <= DENO_KV_MAX_ATOMIC_CHECKS)) {
    throw new DenoKvLimitError(
      `deno kv atomic checks ${input.checks} exceeds published ${DENO_KV_MAX_ATOMIC_CHECKS}-check limit`,
    );
  }
  if (!(input.mutations >= 0 && input.mutations <= DENO_KV_MAX_ATOMIC_MUTATIONS)) {
    throw new DenoKvLimitError(
      `deno kv atomic mutations ${input.mutations} exceeds published ${DENO_KV_MAX_ATOMIC_MUTATIONS}-mutation limit`,
    );
  }
  if (!(input.mutationBytes >= 0 && input.mutationBytes <= DENO_KV_MAX_ATOMIC_MUTATION_BYTES)) {
    throw new DenoKvLimitError(
      `deno kv atomic mutation payload ${input.mutationBytes} bytes exceeds published ${DENO_KV_MAX_ATOMIC_MUTATION_BYTES}-byte limit`,
    );
  }
}

/** Minimal structural view of the unstable `Deno.Kv` subset this candidate uses. */
interface DenoKvEntry {
  readonly value: unknown;
  readonly versionstamp: string | null;
}
interface DenoKvAtomicOperation {
  check(input: {
    key: readonly unknown[];
    versionstamp: string | null;
  }): DenoKvAtomicOperation;
  set(key: readonly unknown[], value: unknown): DenoKvAtomicOperation;
  commit(): Promise<{ ok: boolean }>;
}
interface DenoKvStore {
  get(
    key: readonly unknown[],
    options?: { consistency?: "strong" | "eventual" },
  ): Promise<DenoKvEntry>;
  set(key: readonly unknown[], value: unknown): Promise<unknown>;
  atomic(): DenoKvAtomicOperation;
  close(): void;
}
type DenoKvOpen = (path: string) => Promise<DenoKvStore>;

const denoOpenKv: DenoKvOpen | undefined = (Deno as unknown as { openKv?: DenoKvOpen }).openKv;

/** Fixed single-envelope key; record keys stay inside the envelope, never in the KV key space. */
const ENVELOPE_KEY = Object.freeze(["cairn", "m2_kv_candidate", "authority_envelope"]);
/** Conservative encoded-size estimate for ENVELOPE_KEY (part bytes plus per-part overhead). */
const ENVELOPE_KEY_BYTES = ENVELOPE_KEY.reduce(
  (total, part) => total + new TextEncoder().encode(part).length + 8,
  8,
);
/** Bounded optimistic-CAS retries; exhaustion fails closed instead of committing blindly. */
const MAX_CAS_ATTEMPTS = 128;
/**
 * Bounded `Deno.openKv` retries. Local KV performs setup writes while opening a database, which
 * surfaces a transient "database is locked" error when another process commits concurrently;
 * retry is bounded and any non-busy error or exhaustion fails closed.
 */
const MAX_OPEN_ATTEMPTS = 500;

async function openKvWithBusyRetry(path: string): Promise<DenoKvStore> {
  for (let attempt = 0;; attempt++) {
    try {
      return await denoOpenKv!(path);
    } catch (error) {
      const busy = error instanceof Error && error.message.includes("database is locked");
      if (!busy || attempt + 1 >= MAX_OPEN_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1 + (attempt % 7)));
    }
  }
}

export class DenoKvCandidateAuthority extends OfflineReferenceAuthority {
  readonly kvPath: string;
  private storePromise: Promise<DenoKvStore> | null = null;
  constructor(root: string, injectedFault?: FaultPoint) {
    super(root, injectedFault);
    this.kvPath = `${root}/authority.kv`;
  }

  private async store(): Promise<DenoKvStore> {
    if (!this.storePromise) {
      if (typeof denoOpenKv !== "function") {
        throw new Error(
          "deno kv unavailable: --unstable-kv is wired only into the kv-candidate task",
        );
      }
      this.storePromise = (async () => {
        await Deno.mkdir(this.root, { recursive: true });
        return await openKvWithBusyRetry(this.kvPath);
      })();
    }
    return await this.storePromise;
  }

  /** Test-only handle cleanup; worker processes exit instead of closing explicitly. */
  async close(): Promise<void> {
    if (this.storePromise) (await this.storePromise).close();
    this.storePromise = null;
  }

  override async initialize(): Promise<void> {
    const kv = await this.store();
    const bytes = serializeDurableAuthority(emptyEnvelope());
    assertDenoKvCommitWithinLimits({
      keyBytes: ENVELOPE_KEY_BYTES,
      valueBytes: bytes.length,
      checks: 1,
      mutations: 1,
      mutationBytes: bytes.length,
    });
    // create-if-absent: a lost race only means another process installed the pristine envelope.
    await kv.atomic()
      .check({ key: ENVELOPE_KEY, versionstamp: null })
      .set(ENVELOPE_KEY, bytes)
      .commit();
  }

  /** Every authority decision reads the envelope with strong consistency. */
  override async read(requireCurrent = true): Promise<DurableAuthorityEnvelope> {
    const kv = await this.store();
    const entry = await kv.get(ENVELOPE_KEY, { consistency: "strong" });
    if (entry.versionstamp === null) throw new Error("record denied");
    let value: unknown;
    try {
      value = authorityJsonParse(authorityDecodeText(entry.value as Uint8Array));
    } catch {
      throw new Error("record denied");
    }
    assertAuthorityEnvelope(value, requireCurrent);
    await assertAuthorityCryptography(value);
    return value;
  }

  /**
   * Persistence core swap: strong-read the envelope, run the unchanged transaction operation,
   * then publish the result through one versionstamp-checked atomic commit. The shared
   * crash-recovery file-lock protocol (identical to the reference adapter, including dead-owner
   * recovery) serializes local cross-process writers and preserves the shared crash scenarios'
   * lock-metadata assertions; the versionstamp check still guards every commit against any
   * non-cooperating writer, with bounded optimistic retry that fails closed on exhaustion. Crash
   * faults bound the logical commit exactly like the file reference adapter: no fsync or
   * power-loss claim is made here either. A hosted topology would drop the local lock and rely on
   * KV-native CAS alone; that re-qualification remains an explicit M2 gap.
   */
  protected override async locked<T>(
    operation: (state: DurableAuthorityEnvelope) => T | Promise<T>,
    requireCurrent = true,
    fault?: FaultPoint,
  ): Promise<T> {
    const kv = await this.store();
    await this.acquireLock();
    try {
      // Inside the lock: the create-if-absent atomic cannot race a concurrent writer (Deno KV
      // surfaces cross-process write contention as a hard error, not a versionstamp conflict).
      await this.initialize();
      for (let attempt = 0;; attempt++) {
        const entry = await kv.get(ENVELOPE_KEY, { consistency: "strong" });
        if (entry.versionstamp === null) throw new Error("record denied");
        let parsed: unknown;
        try {
          parsed = authorityJsonParse(authorityDecodeText(entry.value as Uint8Array));
        } catch {
          throw new Error("record denied");
        }
        assertAuthorityEnvelope(parsed, requireCurrent);
        await assertAuthorityCryptography(parsed);
        const state = parsed as DurableAuthorityEnvelope;
        const result = await operation(state);
        assertAuthorityEnvelope(state, requireCurrent);
        const bytes = serializeDurableAuthority(state);
        assertDenoKvCommitWithinLimits({
          keyBytes: ENVELOPE_KEY_BYTES,
          valueBytes: bytes.length,
          checks: 1,
          mutations: 1,
          mutationBytes: bytes.length,
        });
        const activeFault = fault ?? this.injectedFault;
        if (activeFault === "abrupt_before_commit") Deno.exit(75);
        const commit = await kv.atomic()
          .check({ key: ENVELOPE_KEY, versionstamp: entry.versionstamp })
          .set(ENVELOPE_KEY, bytes)
          .commit();
        if (!commit.ok) {
          if (attempt + 1 >= MAX_CAS_ATTEMPTS) {
            throw new Error("durable commit contention denied");
          }
          await new Promise((resolve) => setTimeout(resolve, 1 + (attempt % 7)));
          continue;
        }
        if (activeFault === "abrupt_after_commit") Deno.exit(75);
        return result;
      }
    } finally {
      await this.releaseLock();
    }
  }

  /**
   * Fixture-only corruption injection at the KV layer (worker's `mutate` action). Applies the
   * same dotted-path mutation the file reference worker applies to its JSON store, then stores
   * the tampered bytes raw; the next authority read fails schema validation closed.
   */
  async injectRawMutation(
    mutation: { path: string; value?: unknown; deletion?: boolean },
  ): Promise<void> {
    const kv = await this.store();
    const entry = await kv.get(ENVELOPE_KEY, { consistency: "strong" });
    if (entry.versionstamp === null) throw new Error("record denied");
    const state = authorityJsonParse(
      authorityDecodeText(entry.value as Uint8Array),
    ) as Record<string, unknown>;
    const segments = mutation.path.split(".");
    let target = state;
    for (const segment of segments.slice(0, -1)) {
      target = target[segment] as Record<string, unknown>;
    }
    const last = segments.at(-1)!;
    if (mutation.deletion) delete target[last];
    else target[last] = mutation.value;
    const bytes = serializeDurableAuthority(state);
    assertDenoKvCommitWithinLimits({
      keyBytes: ENVELOPE_KEY_BYTES,
      valueBytes: bytes.length,
      checks: 0,
      mutations: 1,
      mutationBytes: bytes.length,
    });
    await kv.set(ENVELOPE_KEY, bytes);
  }

  /**
   * Fixture-only snapshot install (worker's `replace` action): stores the exported canonical
   * envelope bytes into KV verbatim; the next authority read performs full validation.
   */
  async installSnapshot(path: string): Promise<void> {
    const kv = await this.store();
    const bytes = await Deno.readFile(path);
    assertDenoKvCommitWithinLimits({
      keyBytes: ENVELOPE_KEY_BYTES,
      valueBytes: bytes.length,
      checks: 0,
      mutations: 1,
      mutationBytes: bytes.length,
    });
    await kv.set(ENVELOPE_KEY, bytes);
  }
}

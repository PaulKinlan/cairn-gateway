import { assert, equals, rejects } from "../assert.ts";
import type {
  DispatchPermitClaim,
  DurableAuthorityTransactions,
  InvocationReservationTransaction,
} from "../../packages/core/src/store/authority_transaction.ts";
import {
  automaticRetryAllowed,
  grantsDispatch,
} from "../../packages/core/src/store/authority_transaction.ts";
import { ids, type TenantContext } from "../../packages/core/src/domain/types.ts";
import { DURABLE_KEY_LAYOUT, entityKey, replayKey } from "../../packages/core/src/store/keys.ts";
import {
  assertRestoreNotStale,
  migrateAuthorityEnvelope,
} from "../../packages/core/src/store/migrations.ts";
import {
  assertCurrentEnvelope,
  type DurableAuthorityEnvelope,
  serializeDurableAuthority,
} from "../../packages/core/src/store/schema.ts";
import { OfflineReferenceAuthority } from "./fixtures/offline_reference_adapter.ts";

interface Scenario {
  id: string;
  title: string;
}
interface WorkerInput {
  action: string;
  root: string;
  owner?: { tenantId: string; userId: string };
  transaction?: unknown;
  claim?: DispatchPermitClaim;
  custodyRef?: string;
  path?: string;
  fault?: string;
  mutation?: { path: string; value?: unknown; deletion?: boolean };
}
interface WorkerResult {
  code: number;
  outcome?: string;
  value?: unknown;
}
const scenarios = JSON.parse(
  await Deno.readTextFile("tests/stage1/fixtures/durability-scenarios.json"),
) as Scenario[];
const worker = new URL("./workers/authority_worker.ts", import.meta.url);
const alice = { tenantId: "tenant_a", userId: "user" };
const bob = { tenantId: "tenant_b", userId: "user" };
const ctx = (owner = alice): TenantContext => ({
  tenantId: ids.tenant(owner.tenantId),
  userId: ids.user(owner.userId),
});

async function run(input: WorkerInput): Promise<WorkerResult> {
  const output = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--no-config",
      "--allow-read",
      "--allow-write",
      worker.pathname,
      JSON.stringify(input),
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder().decode(output.stdout).trim();
  return text ? { code: output.code, ...JSON.parse(text) } : { code: output.code };
}
const ok = async (input: WorkerInput): Promise<unknown> => {
  const result = await run(input);
  equals({ code: result.code, outcome: result.outcome }, { code: 0, outcome: "ok" });
  return result.value;
};
const outcome = (value: unknown): string => (value as { outcome: string }).outcome;
const inspect = async (root: string, owner = alice): Promise<Record<string, unknown>> =>
  await ok({ action: "inspect", root, owner }) as Record<string, unknown>;
const tenantOf = (view: Record<string, unknown>): Record<string, unknown> =>
  view.tenant as Record<string, unknown>;
const setup = async (root: string, owner = alice, custodyRef?: string) => {
  equals(await ok({ action: "seed", root, owner, custodyRef }), true);
};
const binding = (
  attemptId: string,
  overrides: Partial<InvocationReservationTransaction> = {},
): InvocationReservationTransaction => ({
  principalId: "user",
  principalEpoch: 1,
  agentId: "agent",
  agentEpoch: 1,
  deviceId: "device",
  deviceEpoch: 1,
  grantId: "grant",
  grantVersion: 1,
  connectionId: "connection",
  connectionEpoch: 1,
  operation: "github.user.read",
  deviceNonceHash: `device_${attemptId}`,
  agentNonceHash: `agent_${attemptId}`,
  nonceExpiresAt: 600,
  jtiHash: `jti_${attemptId}`,
  jtiExpiresAt: 600,
  now: 10,
  attemptId,
  correlationId: `correlation_${attemptId}`,
  ...overrides,
});
const reserve = async (root: string, id: string, owner = alice, overrides = {}) =>
  await ok({ action: "reserve", root, owner, transaction: binding(id, overrides) });
const claim = async (root: string, id: string, owner = alice, now = 11) =>
  await ok({
    action: "claim",
    root,
    owner,
    transaction: { attemptId: id, expectedState: "reserved", now },
  }) as DispatchPermitClaim;
const challenge = (owner: typeof alice, id: string, purpose: string, now = 10) => ({
  challenge: {
    id,
    tenantId: owner.tenantId,
    userId: owner.userId,
    purpose,
    transactionHash: `hash_${id}`,
    expiresAt: 500,
    used: false,
  },
  expectedAbsent: true,
  now,
});
function validEnvelope(): DurableAuthorityEnvelope {
  return {
    schemaVersion: 2,
    authorityGeneration: 3,
    highWatermarks: {
      authorityGeneration: 3,
      migrationGeneration: 0,
      replayGeneration: 1,
      revocationGeneration: 0,
      schemaVersion: 2,
    },
    migration: { status: "idle", generation: 0, fromVersion: 2, toVersion: 2 },
    records: {
      "tenant/tenant_a/user/user/subject/device": {
        tenantId: "tenant_a",
        userId: "user",
        recordVersion: 2,
        authorityGeneration: 3,
        value: { kind: "device", id: "device", status: "active", version: 1 },
      },
      "tenant/tenant_a/user/user/replay/replayhash": {
        tenantId: "tenant_a",
        userId: "user",
        recordVersion: 3,
        authorityGeneration: 3,
        value: { kind: "nonce", hash: "replayhash", expiresAt: 500, generation: 1 },
      },
      "tenant/tenant_a/user/user/attempt/attempt": {
        tenantId: "tenant_a",
        userId: "user",
        recordVersion: 4,
        authorityGeneration: 3,
        value: {
          attemptId: "attempt",
          state: "reserved",
          replayKeys: ["tenant/tenant_a/user/user/replay/replayhash"],
          dispatchPermitUsed: false,
          claimVersion: 0,
          result: null,
        },
      },
      "tenant/tenant_a/user/user/challenge/challenge": {
        tenantId: "tenant_a",
        userId: "user",
        recordVersion: 5,
        authorityGeneration: 3,
        value: {
          id: "challenge",
          tenantId: "tenant_a",
          userId: "user",
          purpose: "bootstrap",
          transactionHash: "challengehash",
          expiresAt: 500,
          used: false,
        },
      },
      "tenant/tenant_a/user/user/custody/custodyhash": {
        tenantId: "tenant_a",
        userId: "user",
        recordVersion: 6,
        authorityGeneration: 3,
        value: {
          custodyReferenceHash: "custodyhash",
          owner: "tenant/tenant_a/user/user",
        },
      },
    },
  };
}

const cases: Record<string, (root: string) => Promise<void>> = {
  "DUR-01": async (root) => {
    await setup(root);
    const adapter: DurableAuthorityTransactions = new OfflineReferenceAuthority(root);
    assert(adapter instanceof OfflineReferenceAuthority);
    equals((await inspect(root)).exists, true);
  },
  "DUR-02": async (root) => {
    await Promise.all([setup(root, alice, "custody_a"), setup(root, bob, "custody_b")]);
    const tx = { records: [{ kind: "nonce", hash: "collision" }], expiresAt: 90, now: 1 };
    const results = await Promise.all([
      ok({ action: "consumeReplay", root, owner: alice, transaction: tx }),
      ok({ action: "consumeReplay", root, owner: bob, transaction: tx }),
    ]);
    equals(results.map(outcome), ["committed", "committed"]);
    for (const owner of [alice, bob]) {
      const replay = tenantOf(await inspect(root, owner)).replay as Record<string, unknown>;
      equals(Object.keys(replay), ["nonce/collision"]);
    }
  },
  "DUR-03": async (root) => {
    await setup(root);
    const tx = { records: [{ kind: "nonce", hash: "race" }], expiresAt: 90, now: 1 };
    const results = await Promise.all(
      Array.from(
        { length: 12 },
        () => ok({ action: "consumeReplay", root, owner: alice, transaction: tx }),
      ),
    );
    equals(results.filter((item) => outcome(item) === "committed").length, 1);
  },
  "DUR-04": async (root) => {
    await setup(root);
    const first = { records: [{ kind: "nonce", hash: "first" }], expiresAt: 90, now: 1 };
    equals(
      outcome(await ok({ action: "consumeReplay", root, owner: alice, transaction: first })),
      "committed",
    );
    const both = {
      records: [{ kind: "nonce", hash: "first" }, { kind: "nonce", hash: "second" }],
      expiresAt: 90,
      now: 1,
    };
    equals(
      outcome(await ok({ action: "consumeReplay", root, owner: alice, transaction: both })),
      "denied",
    );
    const replay = tenantOf(await inspect(root)).replay as Record<string, unknown>;
    equals("nonce/second" in replay, false);
  },
  "DUR-05": async (root) => {
    await setup(root);
    const tx = { records: [{ kind: "jti", hash: "capability" }], expiresAt: 90, now: 1 };
    const results = await Promise.all(
      Array.from(
        { length: 10 },
        () => ok({ action: "consumeReplay", root, owner: alice, transaction: tx }),
      ),
    );
    equals(results.filter((item) => outcome(item) === "committed").length, 1);
  },
  "DUR-06": async (root) => {
    await setup(root);
    equals(outcome(await reserve(root, "bound")), "reserved");
    equals(outcome(await reserve(root, "wrong_epoch", alice, { deviceEpoch: 9 })), "denied");
    const tenant = tenantOf(await inspect(root));
    equals(Object.keys(tenant.attempts as object), ["bound"]);
    equals(Object.keys(tenant.replay as object).sort(), [
      "jti/jti_bound",
      "nonce/agent_bound",
      "nonce/device_bound",
    ]);
  },
  "DUR-07": async (root) => {
    await setup(root);
    await reserve(root, "dispatch");
    const claims = await Promise.all(Array.from({ length: 8 }, () => claim(root, "dispatch")));
    equals(claims.filter(grantsDispatch).length, 1);
    const permit = claims.find(grantsDispatch)!;
    equals(await ok({ action: "dispatch", root, owner: alice, claim: permit }), true);
    equals(
      await ok({
        action: "dispatch",
        root,
        owner: alice,
        claim: { outcome: "denied", reason: "x" },
      }),
      false,
    );
  },
  "DUR-08": async (root) => {
    await setup(root);
    const result = await run({
      action: "reserveFault",
      root,
      owner: alice,
      transaction: binding("before"),
      fault: "before_rename",
    });
    equals(result.code, 75);
    const tenant = tenantOf(await inspect(root));
    equals(Object.keys(tenant.attempts as object).length, 0);
    equals(Object.keys(tenant.replay as object).length, 0);
  },
  "DUR-09": async (root) => {
    await setup(root);
    const result = await run({
      action: "reserveFault",
      root,
      owner: alice,
      transaction: binding("ambiguous"),
      fault: "after_commit_before_reply",
    });
    equals(result.code, 75);
    equals(outcome(await reserve(root, "ambiguous")), "already_consumed");
    equals(automaticRetryAllowed("unknown_commit"), false);
  },
  "DUR-10": async (root) => {
    await setup(root);
    await reserve(root, "permit_commit");
    const result = await run({
      action: "claimFault",
      root,
      owner: alice,
      transaction: { attemptId: "permit_commit", expectedState: "reserved", now: 11 },
      fault: "after_commit_before_reply",
    });
    equals(result.code, 75);
    const attempt =
      (tenantOf(await inspect(root)).attempts as Record<string, Record<string, unknown>>)
        .permit_commit!;
    equals(attempt.state, "dispatching");
    equals(attempt.dispatchStarted, false);
    equals(
      outcome(
        await ok({
          action: "recover",
          root,
          owner: alice,
          transaction: {
            attemptId: "permit_commit",
            expectedState: "dispatching",
            nextState: "dispatch_unknown",
            now: 12,
          },
        }),
      ),
      "committed",
    );
  },
  "DUR-11": async (root) => {
    await setup(root);
    await reserve(root, "start_ambiguity");
    const permit = await claim(root, "start_ambiguity");
    equals(
      (await run({ action: "dispatch", root, owner: alice, claim: permit, fault: "ambiguous" }))
        .code,
      75,
    );
    const attempt =
      (tenantOf(await inspect(root)).attempts as Record<string, Record<string, unknown>>)
        .start_ambiguity!;
    equals({ started: attempt.dispatchStarted, count: attempt.dispatchStarts }, {
      started: true,
      count: 1,
    });
    equals(await ok({ action: "dispatch", root, owner: alice, claim: permit }), false);
    equals(
      outcome(
        await ok({
          action: "recover",
          root,
          owner: alice,
          transaction: {
            attemptId: "start_ambiguity",
            expectedState: "dispatching",
            nextState: "dispatch_unknown",
            now: 12,
          },
        }),
      ),
      "committed",
    );
  },
  "DUR-12": async (root) => {
    await setup(root);
    await reserve(root, "final");
    const permit = await claim(root, "final");
    assert(grantsDispatch(permit));
    equals(
      outcome(
        await ok({
          action: "finalize",
          root,
          owner: alice,
          transaction: {
            attemptId: "final",
            expectedState: "dispatching",
            permit: { ...permit.permit, token: "wrong" },
            nextState: "completed",
            result: { outcome: "completed", resultHash: "result_hash" },
            now: 12,
          },
        }),
      ),
      "denied",
    );
    equals(
      outcome(
        await ok({
          action: "finalize",
          root,
          owner: alice,
          transaction: {
            attemptId: "final",
            expectedState: "dispatching",
            permit: permit.permit,
            nextState: "completed",
            result: { outcome: "completed", resultHash: "result_hash" },
            now: 12,
          },
        }),
      ),
      "committed",
    );
    equals(automaticRetryAllowed("dispatch_unknown"), false);
  },
  "DUR-13": async (root) => {
    await setup(root);
    equals(
      outcome(
        await ok({
          action: "transition",
          root,
          owner: alice,
          transaction: {
            subjectType: "device",
            subjectId: "device",
            expectedVersion: 1,
            nextVersion: 2,
            nextStatus: "revoked",
            reason: "compromise",
            now: 20,
          },
        }),
      ),
      "committed",
    );
    equals(
      (tenantOf(await inspect(root)).subjects as Record<string, Record<string, unknown>>).device!
        .status,
      "revoked",
    );
  },
  "DUR-14": async (root) => {
    await setup(root);
    await ok({
      action: "transition",
      root,
      owner: alice,
      transaction: {
        subjectType: "device",
        subjectId: "device",
        expectedVersion: 1,
        nextVersion: 2,
        nextStatus: "revoked",
        reason: "operator",
        now: 20,
      },
    });
    equals(
      outcome(
        await ok({
          action: "transition",
          root,
          owner: alice,
          transaction: {
            subjectType: "device",
            subjectId: "device",
            expectedVersion: 2,
            nextVersion: 2,
            nextStatus: "active",
            reason: "operator",
            now: 21,
          },
        }),
      ),
      "denied",
    );
    equals(
      outcome(
        await ok({
          action: "transition",
          root,
          owner: alice,
          transaction: {
            subjectType: "device",
            subjectId: "device",
            expectedVersion: 2,
            nextVersion: 3,
            nextStatus: "active",
            reason: "operator",
            now: 21,
          },
        }),
      ),
      "committed",
    );
  },
  "DUR-15": async (root) => {
    await setup(root);
    await ok({
      action: "issue",
      root,
      owner: alice,
      transaction: challenge(alice, "bound", "enroll_candidate"),
    });
    const mismatch = {
      challengeId: "bound",
      transactionHash: "wrong",
      purpose: "bootstrap",
      now: 20,
      mutation: { kind: "bootstrap", value: bootstrapValue(alice) },
    };
    equals(
      outcome(await ok({ action: "commit", root, owner: alice, transaction: mismatch })),
      "denied",
    );
    const stored =
      (tenantOf(await inspect(root)).challenges as Record<string, Record<string, unknown>>).bound!;
    equals(stored.used, false);
    equals(
      outcome(
        await ok({
          action: "consumeReplay",
          root,
          owner: alice,
          transaction: {
            records: [{ kind: "nonce", hash: "clock_advance" }],
            expiresAt: 600,
            now: 550,
          },
        }),
      ),
      "committed",
    );
    equals(
      outcome(
        await ok({
          action: "commit",
          root,
          owner: alice,
          transaction: {
            ...mismatch,
            transactionHash: "hash_bound",
            purpose: "enroll_candidate",
            now: 10,
            mutation: { kind: "enrollment", value: enrollmentValue(alice, "late") },
          },
        }),
      ),
      "denied",
    );
  },
  "DUR-16": async (root) => {
    await setup(root);
    await ok({
      action: "issue",
      root,
      owner: alice,
      transaction: challenge(alice, "race", "bootstrap"),
    });
    const tx = {
      challengeId: "race",
      transactionHash: "hash_race",
      purpose: "bootstrap",
      now: 20,
      mutation: { kind: "bootstrap", value: bootstrapValue(alice) },
    };
    const results = await Promise.all(
      Array.from(
        { length: 10 },
        () => ok({ action: "commit", root, owner: alice, transaction: tx }),
      ),
    );
    equals(results.filter((item) => outcome(item) === "committed").length, 1);
  },
  "DUR-17": async (root) => {
    await setup(root);
    const ceremonies = [
      ["boot", "bootstrap", { kind: "bootstrap", value: bootstrapValue(alice) }],
      ["enroll", "enroll_candidate", {
        kind: "enrollment",
        value: enrollmentValue(alice, "request"),
      }],
      ["approve", "approve_enrollment", {
        kind: "approval",
        value: approvalValue(alice, "request"),
      }],
      ["remove", "remove_device", { kind: "removal", value: removalValue() }],
    ] as const;
    for (const [id, purpose, mutation] of ceremonies) {
      await ok({ action: "issue", root, owner: alice, transaction: challenge(alice, id, purpose) });
      const before = tenantOf(await inspect(root));
      equals(
        outcome(
          await ok({
            action: "commit",
            root,
            owner: alice,
            transaction: {
              challengeId: id,
              transactionHash: `hash_${id}`,
              purpose: purpose === "bootstrap" ? "remove_device" : "bootstrap",
              now: 20,
              mutation,
            },
          }),
        ),
        "denied",
      );
      const afterMismatch = tenantOf(await inspect(root));
      equals(serialize(afterMismatch), serialize(before));
      equals(
        outcome(
          await ok({
            action: "commit",
            root,
            owner: alice,
            transaction: {
              challengeId: id,
              transactionHash: `hash_${id}`,
              purpose,
              now: 20,
              mutation,
            },
          }),
        ),
        "committed",
      );
    }
    equals(Object.keys(tenantOf(await inspect(root)).ceremonies as object).sort(), [
      "approve",
      "boot",
      "enroll",
      "remove",
    ]);
  },
  "DUR-18": async (root) => {
    for (const fault of ["after_preparing", "after_committing", "mark_failed"]) {
      const migrationRoot = `${root}/${fault}`;
      await setup(migrationRoot);
      await ok({ action: "legacy", root: migrationRoot, owner: alice });
      const result = await run({ action: "migrate", root: migrationRoot, fault });
      equals(result.code, 75);
      const raw = await ok({ action: "raw", root: migrationRoot }) as {
        migration: { status: string };
      };
      assert(["preparing", "committing", "failed"].includes(raw.migration.status));
      equals(await ok({ action: "migrate", root: migrationRoot }), "migrated");
      const view = await inspect(migrationRoot);
      equals(view.schemaVersion, 2);
      assert("nonce/legacy" in (tenantOf(view).replay as object));
    }
    const legacy = validEnvelope();
    legacy.schemaVersion = 1;
    legacy.highWatermarks.schemaVersion = 1;
    legacy.migration = { status: "idle", generation: 0, fromVersion: 1, toVersion: 1 };
    const migrated = migrateAuthorityEnvelope(legacy, [{
      fromVersion: 1,
      toVersion: 2,
      migrate(value) {
        value.schemaVersion = 2;
        value.highWatermarks.schemaVersion = 2;
        value.migration = { status: "idle", generation: 1, fromVersion: 1, toVersion: 2 };
        value.highWatermarks.migrationGeneration = 1;
        return value;
      },
    }]);
    assertCurrentEnvelope(migrated);
  },
  "DUR-19": async (root) => {
    await setup(root);
    await ok({ action: "legacy", root, owner: alice });
    equals((await run({ action: "inspect", root, owner: alice })).outcome, "denied");
    const results = await Promise.all(
      Array.from({ length: 6 }, () => ok({ action: "migrate", root })),
    );
    assert(results.every((item) => item === "migrated" || item === "already_current"));
    const migrated = await inspect(root);
    equals(migrated.schemaVersion, 2);
    equals((migrated.migration as Record<string, unknown>).generation, 1);
  },
  "DUR-20": async (root) => {
    await setup(root);
    const currentPath = `${root}/current.json`;
    await ok({ action: "snapshot", root, path: currentPath });
    await ok({
      action: "transition",
      root,
      owner: alice,
      transaction: {
        subjectType: "device",
        subjectId: "device",
        expectedVersion: 1,
        nextVersion: 2,
        nextStatus: "revoked",
        reason: "operator",
        now: 20,
      },
    });
    equals(await ok({ action: "restore", root, path: currentPath }), false);
    const mutationBase = "tenants.tenant_a/user";
    const mutations = [
      { path: `${mutationBase}.subjects.device`, deletion: true },
      { path: `${mutationBase}.subjects.device.recordVersion`, value: 1 },
      { path: `${mutationBase}.subjects.device.status`, value: "active" },
      { path: `${mutationBase}.tenantId`, value: "tenant_b" },
    ];
    for (const mutation of mutations) {
      const path = `${root}/candidate_${crypto.randomUUID()}.json`;
      await ok({ action: "snapshot", root, path });
      await ok({ action: "mutatePath", root, path, mutation });
      equals(await ok({ action: "restore", root, path }), false);
    }
    const envelope = validEnvelope();
    const stale = structuredClone(envelope);
    stale.authorityGeneration = 2;
    stale.highWatermarks.authorityGeneration = 2;
    await rejects(() => assertRestoreNotStale(stale, envelope));
    const copied = structuredClone(envelope);
    (copied.records["tenant/tenant_a/user/user/subject/device"]!.value as Record<string, unknown>)
      .status = "revoked";
    await rejects(() => assertRestoreNotStale(copied, envelope));
  },
  "DUR-21": async (root) => {
    await setup(root);
    const tx = (expiresAt: number, now: number) => ({
      records: [{ kind: "nonce", hash: "ttl" }],
      expiresAt,
      now,
    });
    equals(
      outcome(await ok({ action: "consumeReplay", root, owner: alice, transaction: tx(10, 1) })),
      "committed",
    );
    equals(
      outcome(await ok({ action: "consumeReplay", root, owner: alice, transaction: tx(20, 10) })),
      "denied",
    );
    equals(
      outcome(await ok({ action: "consumeReplay", root, owner: alice, transaction: tx(20, 11) })),
      "committed",
    );
  },
  "DUR-22": async (root) => {
    await setup(root);
    await ok({
      action: "consumeReplay",
      root,
      owner: alice,
      transaction: {
        records: [{ kind: "nonce", hash: "advance" }],
        expiresAt: 300,
        now: 200,
      },
    });
    equals(
      outcome(
        await ok({
          action: "consumeReplay",
          root,
          owner: alice,
          transaction: {
            records: [{ kind: "nonce", hash: "rollback" }],
            expiresAt: 150,
            now: 100,
          },
        }),
      ),
      "denied",
    );
    equals(
      outcome(
        await reserve(root, "rolled", alice, { now: 100, nonceExpiresAt: 150, jtiExpiresAt: 150 }),
      ),
      "denied",
    );
    equals(
      outcome(
        await ok({
          action: "issue",
          root,
          owner: alice,
          transaction: challenge(alice, "expired", "bootstrap", 100),
        }),
      ),
      "committed",
    );
    // The default challenge expires at 500 and is future relative to durable 200; advance then deny consume.
    await ok({
      action: "consumeReplay",
      root,
      owner: alice,
      transaction: {
        records: [{ kind: "nonce", hash: "advance_again" }],
        expiresAt: 700,
        now: 600,
      },
    });
    equals(
      outcome(
        await ok({
          action: "commit",
          root,
          owner: alice,
          transaction: {
            challengeId: "expired",
            transactionHash: "hash_expired",
            purpose: "bootstrap",
            now: 100,
            mutation: { kind: "bootstrap", value: bootstrapValue(alice) },
          },
        }),
      ),
      "denied",
    );
    equals((await inspect(root)).effectiveNow, 600);
  },
  "DUR-23": async (root) => {
    const encoderCases: unknown[] = [
      (() => {
        const a: unknown[] = [];
        a.length = 1;
        return a;
      })(),
      (() => {
        const a = [1];
        Object.defineProperty(a, "x", { enumerable: true, get: () => 1 });
        return a;
      })(),
      (() => {
        const a = [1];
        (a as unknown as Record<PropertyKey, unknown>)[Symbol("x")] = 1;
        return a;
      })(),
      (() => {
        const a = [1];
        (a as unknown as Record<string, unknown>).x = 1;
        return a;
      })(),
      new (class RecordLike {
        x = 1;
      })(),
    ];
    for (const value of encoderCases) await rejects(() => serializeDurableAuthority(value));
    assert(new TextDecoder().decode(serializeDurableAuthority([1, 2])) === "[1,2]");
    const envelope = validEnvelope();
    assertCurrentEnvelope(envelope);
    equals(entityKey(ctx(), "subject", "device"), "tenant/tenant_a/user/user/subject/device");
    equals(replayKey(ctx(), "nonce", "hash"), "tenant/tenant_a/user/user/replay/nonce/hash");
    assert(DURABLE_KEY_LAYOUT.authorityRecord.includes("{tenantId}"));
    const recordKey = "tenant/tenant_a/user/user/subject/device";
    const corruptions: Array<(value: DurableAuthorityEnvelope) => void> = [
      (value) => {
        value.records[recordKey]!.tenantId = "tenant_b";
      },
      (value) => {
        value.records[recordKey]!.recordVersion = 0;
      },
      (value) => {
        (value.records[recordKey]!.value as Record<string, unknown>).status = "corrupt";
      },
      (value) => {
        (value.records[recordKey]!.value as Record<string, unknown>).version = -1;
      },
      (value) => {
        value.authorityGeneration = 2;
      },
      (value) => {
        const replay = value.records["tenant/tenant_a/user/user/replay/replayhash"]!;
        (replay.value as Record<string, unknown>).expiresAt = 0;
      },
      (value) => {
        const attempt = value.records["tenant/tenant_a/user/user/attempt/attempt"]!;
        (attempt.value as Record<string, unknown>).replayKeys = ["missing"];
      },
      (value) => {
        const attempt = value.records["tenant/tenant_a/user/user/attempt/attempt"]!;
        Object.assign(attempt.value as Record<string, unknown>, {
          state: "completed",
          dispatchPermitUsed: true,
          claimVersion: 1,
          result: { outcome: "failed_safe", reason: "wrong" },
        });
      },
      (value) => {
        const item = value.records["tenant/tenant_a/user/user/challenge/challenge"]!;
        (item.value as Record<string, unknown>).purpose = "wrong";
      },
      (value) => {
        const item = value.records["tenant/tenant_a/user/user/custody/custodyhash"]!;
        (item.value as Record<string, unknown>).owner = "tenant/tenant_b/user/user";
      },
      (value) => {
        value.records["tenant/tenant_b/user/user/custody/custodyhash"] = {
          tenantId: "tenant_b",
          userId: "user",
          recordVersion: 7,
          authorityGeneration: 3,
          value: {
            custodyReferenceHash: "custodyhash",
            owner: "tenant/tenant_b/user/user",
          },
        };
      },
    ];
    for (const corrupt of corruptions) {
      const candidate = structuredClone(envelope);
      corrupt(candidate);
      await rejects(() => assertCurrentEnvelope(candidate));
    }
    await setup(root);
    await ok({
      action: "consumeReplay",
      root,
      owner: alice,
      transaction: {
        records: [{ kind: "nonce", hash: "corrupt" }],
        expiresAt: 500,
        now: 1,
      },
    });
    await ok({
      action: "issue",
      root,
      owner: alice,
      transaction: challenge(alice, "corrupt_challenge", "bootstrap"),
    });
    const backup = `${root}/clean.json`;
    await ok({ action: "snapshot", root, path: backup });
    const nested = [
      { path: "tenants.tenant_a/user.subjects.device.version", value: "bad" },
      { path: "tenants.tenant_a/user.subjects.device.status", value: "bad" },
      { path: "tenants.tenant_a/user.replay.nonce/corrupt.expiresAt", value: -1 },
      { path: "tenants.tenant_a/user.challenges.corrupt_challenge.purpose", value: "bad" },
      { path: "tenants.tenant_a/user.attempts.bad", value: { state: "reserved" } },
      { path: "custodyClaims.custody_tenant_a_user", value: "tenant_b/user" },
      { path: "effectiveNow", value: -1 },
    ];
    for (const mutation of nested) {
      await ok({ action: "mutate", root, mutation });
      equals((await run({ action: "inspect", root, owner: alice })).outcome, "denied");
      await ok({ action: "replace", root, path: backup });
    }
  },
  "DUR-24": async (root) => {
    const owners = Array.from(
      { length: 12 },
      (_, index) => ({ tenantId: `tenant_${index}`, userId: "user" }),
    );
    const results = await Promise.all(
      owners.map((owner) => ok({ action: "seed", root, owner, custodyRef: "shared_custody" })),
    );
    equals(results.filter(Boolean).length, 1);
    const winner = owners[results.findIndex(Boolean)]!;
    equals((await inspect(root, winner)).exists, true);
    for (const owner of owners.filter((item) => item !== winner)) {
      equals((await inspect(root, owner)).exists, false);
    }
  },
};

function bootstrapValue(owner: typeof alice) {
  return {
    principal: {
      id: owner.userId,
      tenantId: owner.tenantId,
      kind: "cryptographic",
      status: "active",
      emailRequired: false,
      epoch: 1,
    },
    agent: {
      id: "agent",
      tenantId: owner.tenantId,
      userId: owner.userId,
      publicJwk: { kty: "OKP" },
      thumbprint: "agent_thumb",
      status: "active",
      epoch: 1,
    },
    device: {
      id: "device",
      tenantId: owner.tenantId,
      userId: owner.userId,
      agentId: "agent",
      publicJwk: { kty: "OKP" },
      thumbprint: "device_thumb",
      role: "admin",
      status: "active",
      epoch: 1,
    },
  };
}
function enrollmentValue(owner: typeof alice, id: string) {
  return {
    request: {
      id,
      tenantId: owner.tenantId,
      userId: owner.userId,
      agentId: "agent",
      candidateJwk: { kty: "OKP" },
      thumbprint: "candidate",
      status: "pending",
      expiresAt: 400,
    },
    principalEpoch: 1,
    agentEpoch: 1,
    agentThumbprint: "agent_thumb",
  };
}
function approvalValue(owner: typeof alice, requestId: string) {
  return {
    requestId,
    device: {
      id: "candidate",
      tenantId: owner.tenantId,
      userId: owner.userId,
      agentId: "agent",
      publicJwk: { kty: "OKP" },
      thumbprint: "candidate",
      role: "member",
      status: "active",
      epoch: 1,
    },
    principalEpoch: 1,
    agentEpoch: 1,
    agentThumbprint: "agent_thumb",
    approverId: "device",
    approverEpoch: 1,
    approverThumbprint: "device_thumb",
  };
}
function removalValue() {
  return {
    agentId: "agent",
    agentEpoch: 1,
    agentThumbprint: "agent_thumb",
    approverId: "device",
    approverEpoch: 1,
    approverThumbprint: "device_thumb",
    targetId: "device",
    targetEpoch: 1,
    targetThumbprint: "device_thumb",
    targetRole: "admin",
  };
}
const serialize = (value: unknown) => new TextDecoder().decode(serializeDurableAuthority(value));

for (const scenario of scenarios) {
  Deno.test(`${scenario.id}: ${scenario.title}`, async () => {
    const root = await Deno.makeTempDir({ prefix: `cairn_${scenario.id}_` });
    try {
      const implementation = cases[scenario.id];
      if (!implementation) throw new Error(`missing scenario ${scenario.id}`);
      await implementation(root);
    } finally {
      await Deno.remove(root, { recursive: true }).catch(() => undefined);
    }
  });
}

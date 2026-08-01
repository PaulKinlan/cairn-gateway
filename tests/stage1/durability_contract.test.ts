import { assert, equals, rejects } from "../assert.ts";
import type {
  AuthorityMaintenanceContext,
  DispatchPermitClaim,
  DurableAuthorityMaintenance,
  DurableAuthorityTransactions,
  InvocationReservationTransaction,
} from "../../packages/core/src/store/authority_transaction.ts";
import {
  automaticRetryAllowed,
  grantsDispatch,
  grantsDispatchPermit,
} from "../../packages/core/src/store/authority_transaction.ts";
import { ids, type TenantContext } from "../../packages/core/src/domain/types.ts";
import { transactionHash } from "../../packages/core/src/identity/transactions.ts";
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
import {
  createCandidateAdapter,
  FIXTURE_JWKS,
  FIXTURE_THUMBPRINTS,
} from "./fixtures/candidate_adapter_factory.ts";

interface Scenario {
  id: string;
  title: string;
}
interface WorkerInput {
  action: string;
  root: string;
  owner?: { tenantId: string; userId: string };
  transaction?: unknown;
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
      "--allow-run=kill",
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
const defaultMutation = (owner: typeof alice, purpose: string, id: string) =>
  purpose === "bootstrap"
    ? { kind: "bootstrap", value: bootstrapValue(owner) }
    : purpose === "enroll_candidate"
    ? { kind: "enrollment", value: enrollmentValue(owner, `request_${id}`) }
    : purpose === "approve_enrollment"
    ? { kind: "approval", value: approvalValue(owner, `request_${id}`) }
    : { kind: "removal", value: removalValue() };
const challenge = async (
  owner: typeof alice,
  id: string,
  purpose: string,
  now = 10,
  mutation: unknown = defaultMutation(owner, purpose, id),
) => ({
  challenge: {
    id,
    tenantId: owner.tenantId,
    userId: owner.userId,
    purpose,
    transactionHash: await transactionHash(mutation),
    expiresAt: 500,
    used: false,
  },
  expectedAbsent: true as const,
  now,
});
function validEnvelope(): DurableAuthorityEnvelope {
  const owner = ctx();
  const principal = entityKey(owner, "subject", "user");
  const agent = entityKey(owner, "subject", "agent");
  const device = entityKey(owner, "subject", "device");
  const grant = entityKey(owner, "subject", "grant");
  const connectionSubject = entityKey(owner, "subject", "connection");
  const connection = entityKey(owner, "connection", "connection");
  const custody = entityKey(owner, "custody", "custodyhash");
  const replayKeys = [
    replayKey(owner, "nonce", "device_attempt"),
    replayKey(owner, "nonce", "agent_attempt"),
    replayKey(owner, "jti", "jti_attempt"),
  ];
  let version = 0;
  const records: DurableAuthorityEnvelope["records"] = {};
  const add = (key: string, value: unknown) => {
    records[key] = {
      tenantId: "tenant_a",
      userId: "user",
      recordVersion: ++version,
      authorityGeneration: 3,
      value,
    };
  };
  add(principal, {
    kind: "principal",
    id: "user",
    status: "active",
    version: 1,
    identity: {
      id: "user",
      tenantId: "tenant_a",
      kind: "cryptographic",
      status: "active",
      emailRequired: false,
      epoch: 1,
    },
  });
  add(agent, {
    kind: "agent",
    id: "agent",
    status: "active",
    version: 1,
    identity: {
      id: "agent",
      tenantId: "tenant_a",
      userId: "user",
      publicJwk: FIXTURE_JWKS.agent,
      thumbprint: FIXTURE_THUMBPRINTS.agent,
      status: "active",
      epoch: 1,
    },
  });
  add(device, {
    kind: "device",
    id: "device",
    status: "active",
    version: 1,
    identity: {
      id: "device",
      tenantId: "tenant_a",
      userId: "user",
      agentId: "agent",
      publicJwk: FIXTURE_JWKS.admin,
      thumbprint: FIXTURE_THUMBPRINTS.admin,
      role: "admin",
      status: "active",
      epoch: 1,
    },
  });
  add(grant, {
    kind: "grant",
    id: "grant",
    status: "active",
    version: 1,
    identity: {
      id: "grant",
      tenantId: "tenant_a",
      userId: "user",
      agentId: "agent",
      deviceId: "device",
      connectionId: "connection",
      operation: "github.user.read",
      status: "active",
      version: 1,
      expiresAt: 1_000,
    },
  });
  add(connectionSubject, {
    kind: "connection",
    id: "connection",
    status: "active",
    version: 1,
    identity: {
      id: "connection",
      tenantId: "tenant_a",
      userId: "user",
      provider: "github",
      adapter: "fixture",
      custodyReferenceHash: "custodyhash",
      status: "active",
      epoch: 1,
    },
  });
  add(connection, {
    id: "connection",
    custodyReferenceHash: "custodyhash",
    owner: "tenant/tenant_a/user/user",
    agentId: "agent",
    deviceId: "device",
    workload: "github.user.read",
  });
  add(custody, {
    custodyReferenceHash: "custodyhash",
    owner: "tenant/tenant_a/user/user",
    connectionId: "connection",
    agentId: "agent",
    deviceId: "device",
    workload: "github.user.read",
  });
  add(replayKeys[0]!, { kind: "nonce", hash: "device_attempt", expiresAt: 500, generation: 1 });
  add(replayKeys[1]!, { kind: "nonce", hash: "agent_attempt", expiresAt: 500, generation: 1 });
  add(replayKeys[2]!, { kind: "jti", hash: "jti_attempt", expiresAt: 500, generation: 1 });
  add(entityKey(owner, "attempt", "attempt"), {
    attemptId: "attempt",
    state: "reserved",
    binding: binding("attempt"),
    replayKeys,
    claimVersion: 0,
    permitHash: null,
    permitAuthorityGeneration: null,
    dispatchStarted: false,
    dispatchStarts: 0,
    result: null,
  });
  add(entityKey(owner, "challenge", "challenge"), {
    id: "challenge",
    tenantId: "tenant_a",
    userId: "user",
    purpose: "bootstrap",
    transactionHash: "challengehash",
    expiresAt: 500,
    used: false,
  });
  return {
    schemaVersion: 2,
    authorityGeneration: 3,
    effectiveNow: 10,
    highWatermarks: {
      authorityGeneration: 3,
      migrationGeneration: 0,
      replayGeneration: 1,
      revocationGeneration: 0,
      schemaVersion: 2,
    },
    migration: { status: "idle", generation: 0, fromVersion: 2, toVersion: 2 },
    records,
  };
}

async function exercisePostImportIntrinsicReplacement(root: string): Promise<void> {
  const make = async (name: string, legacy = false) => {
    const candidate = createCandidateAdapter(`${root}/intrinsic_${name}`);
    await candidate.fixture.seed(alice, `custody_${name}`);
    if (legacy) await candidate.fixture.writeLegacy(alice);
    return candidate;
  };
  const authorityContext = (
    candidate: ReturnType<typeof createCandidateAdapter>,
    purpose:
      | "export"
      | "inspect"
      | "initialize"
      | "restore"
      | "prepare_migration"
      | "advance_migration"
      | "fail_migration"
      | "recover_migration",
  ) =>
    candidate.fixture.issueAuthorityMaintenanceContext({
      actorId: "intrinsic_authority_operator",
      purpose,
    });

  const source = await make("source");
  const sourceEnvelope = await source.maintenance.exportAuthority(
    authorityContext(source, "export"),
  );
  const exportAdapter = await make("export");
  const inspectAdapter = await make("inspect");
  const initializeAdapter = createCandidateAdapter(`${root}/intrinsic_initialize`);
  const restoreAdapter = await make("restore");
  const restoreEnvelope = await restoreAdapter.maintenance.exportAuthority(
    authorityContext(restoreAdapter, "export"),
  );
  const prepareAdapter = await make("prepare", true);
  const advanceAdapter = await make("advance", true);
  const failAdapter = await make("fail", true);
  const recoverAdapter = await make("recover", true);
  equals(
    outcome(
      await advanceAdapter.maintenance.prepareMigration(
        authorityContext(advanceAdapter, "prepare_migration"),
        { expectedSchemaVersion: 1, targetSchemaVersion: 2 },
      ),
    ),
    "committed",
  );
  equals(
    outcome(
      await failAdapter.maintenance.prepareMigration(
        authorityContext(failAdapter, "prepare_migration"),
        { expectedSchemaVersion: 1, targetSchemaVersion: 2 },
      ),
    ),
    "committed",
  );

  const contexts = {
    export: authorityContext(exportAdapter, "export"),
    inspect: authorityContext(inspectAdapter, "inspect"),
    initialize: authorityContext(initializeAdapter, "initialize"),
    restore: authorityContext(restoreAdapter, "restore"),
    prepare: authorityContext(prepareAdapter, "prepare_migration"),
    advance: authorityContext(advanceAdapter, "advance_migration"),
    fail: authorityContext(failAdapter, "fail_migration"),
    recover: authorityContext(recoverAdapter, "recover_migration"),
  };

  const multi = createCandidateAdapter(`${root}/intrinsic_multi`);
  await multi.fixture.seed(alice, "intrinsic_alice_custody");
  await multi.fixture.seed(bob, "intrinsic_bob_custody");
  const aliceExportContext = multi.fixture.issueMaintenanceContext({
    tenant: ctx(alice),
    actorId: "alice_intrinsic_operator",
    purpose: "export",
  });
  const bobExportContext = multi.fixture.issueMaintenanceContext({
    tenant: ctx(bob),
    actorId: "bob_intrinsic_operator",
    purpose: "export",
  });
  const aliceRestoreContext = multi.fixture.issueMaintenanceContext({
    tenant: ctx(alice),
    actorId: "alice_intrinsic_operator",
    purpose: "restore",
  });
  const bobEnvelope = await multi.maintenance.exportAuthority(bobExportContext);

  const OriginalObject = Object;
  const OriginalArray = Array;
  const OriginalWeakMap = WeakMap;
  const OriginalFunction = Function;
  const defineProperty = Object.defineProperty;
  const descriptor = Object.getOwnPropertyDescriptor;
  const descriptors = {
    weakMapGet: descriptor(OriginalWeakMap.prototype, "get")!,
    weakMapSet: descriptor(OriginalWeakMap.prototype, "set")!,
    weakMapHas: descriptor(OriginalWeakMap.prototype, "has")!,
    values: descriptor(OriginalObject, "values")!,
    entries: descriptor(OriginalObject, "entries")!,
    keys: descriptor(OriginalObject, "keys")!,
    freeze: descriptor(OriginalObject, "freeze")!,
    descriptors: descriptor(OriginalObject, "getOwnPropertyDescriptors")!,
    prototype: descriptor(OriginalObject, "getPrototypeOf")!,
    create: descriptor(OriginalObject, "create")!,
    assign: descriptor(OriginalObject, "assign")!,
    is: descriptor(OriginalObject, "is")!,
    isArray: descriptor(OriginalArray, "isArray")!,
    call: descriptor(OriginalFunction.prototype, "call")!,
    apply: descriptor(OriginalFunction.prototype, "apply")!,
    bind: descriptor(OriginalFunction.prototype, "bind")!,
    reflectApply: descriptor(Reflect, "apply")!,
    reflectOwnKeys: descriptor(Reflect, "ownKeys")!,
    reflectGetPrototypeOf: descriptor(Reflect, "getPrototypeOf")!,
    structuredClone: descriptor(globalThis, "structuredClone")!,
    jsonParse: descriptor(JSON, "parse")!,
    jsonStringify: descriptor(JSON, "stringify")!,
  };
  const poison = () => {
    throw new Error("mutable intrinsic used");
  };
  const replace = (target: object, name: string, original: PropertyDescriptor, value: unknown) =>
    defineProperty(target, name, { ...original, value });

  let exported: DurableAuthorityEnvelope | undefined;
  let inspected: DurableAuthorityEnvelope | undefined;
  let crossTenantRecords: DurableAuthorityEnvelope | undefined;
  const results: string[] = [];
  const forgedDenied: boolean[] = [];
  const forged = {} as AuthorityMaintenanceContext;
  const deniedCall = async (operation: () => Promise<unknown>): Promise<boolean> => {
    try {
      await operation();
      return false;
    } catch {
      return true;
    }
  };
  try {
    replace(OriginalWeakMap.prototype, "get", descriptors.weakMapGet, () => ({
      scope: "authority",
      actorId: "forged_actor",
      purpose: "export",
    }));
    replace(OriginalWeakMap.prototype, "set", descriptors.weakMapSet, poison);
    replace(OriginalWeakMap.prototype, "has", descriptors.weakMapHas, () => true);
    replace(OriginalObject, "values", descriptors.values, () => []);
    replace(OriginalObject, "entries", descriptors.entries, () => []);
    replace(OriginalObject, "keys", descriptors.keys, () => []);
    replace(OriginalObject, "freeze", descriptors.freeze, (value: unknown) => value);
    replace(OriginalObject, "getOwnPropertyDescriptors", descriptors.descriptors, () => ({}));
    replace(OriginalObject, "getPrototypeOf", descriptors.prototype, () => null);
    replace(OriginalObject, "create", descriptors.create, () => ({}));
    replace(OriginalObject, "assign", descriptors.assign, (target: unknown) => target);
    replace(OriginalObject, "is", descriptors.is, () => true);
    replace(OriginalArray, "isArray", descriptors.isArray, () => false);
    replace(
      OriginalFunction.prototype,
      "call",
      descriptors.call,
      function (this: (...args: unknown[]) => unknown, thisArg: unknown, ...args: unknown[]) {
        return descriptors.reflectApply.value(descriptors.call.value, this, [thisArg, ...args]);
      },
    );
    replace(
      OriginalFunction.prototype,
      "apply",
      descriptors.apply,
      function (this: (...args: unknown[]) => unknown, thisArg: unknown, args?: unknown[]) {
        return descriptors.reflectApply.value(descriptors.apply.value, this, [thisArg, args]);
      },
    );
    replace(
      OriginalFunction.prototype,
      "bind",
      descriptors.bind,
      function (this: (...args: unknown[]) => unknown, thisArg: unknown, ...args: unknown[]) {
        return descriptors.reflectApply.value(descriptors.bind.value, this, [thisArg, ...args]);
      },
    );
    replace(Reflect, "apply", descriptors.reflectApply, poison);
    replace(Reflect, "ownKeys", descriptors.reflectOwnKeys, poison);
    replace(Reflect, "getPrototypeOf", descriptors.reflectGetPrototypeOf, poison);
    replace(globalThis, "structuredClone", descriptors.structuredClone, poison);
    replace(JSON, "parse", descriptors.jsonParse, () => ({}));
    replace(JSON, "stringify", descriptors.jsonStringify, () => "{}");

    const postImportExportContext = exportAdapter.fixture.issueAuthorityMaintenanceContext({
      actorId: "post_import_authority_operator",
      purpose: "export",
    });
    forgedDenied[0] = await deniedCall(() => exportAdapter.maintenance.exportAuthority(forged));
    forgedDenied[1] = await deniedCall(() => inspectAdapter.maintenance.inspectAuthority(forged));
    forgedDenied[2] = await deniedCall(() =>
      initializeAdapter.maintenance.initializeAuthority(forged, sourceEnvelope)
    );
    forgedDenied[3] = await deniedCall(() =>
      restoreAdapter.maintenance.restoreAuthority(forged, restoreEnvelope)
    );
    forgedDenied[4] = await deniedCall(() =>
      prepareAdapter.maintenance.prepareMigration(forged, {
        expectedSchemaVersion: 1,
        targetSchemaVersion: 2,
      })
    );
    forgedDenied[5] = await deniedCall(() => advanceAdapter.maintenance.advanceMigration(forged));
    forgedDenied[6] = await deniedCall(() => failAdapter.maintenance.failMigration(forged));
    forgedDenied[7] = await deniedCall(() => recoverAdapter.maintenance.recoverMigration(forged));

    exported = await exportAdapter.maintenance.exportAuthority(postImportExportContext);
    results[0] = "committed";
    inspected = await inspectAdapter.maintenance.inspectAuthority(contexts.inspect);
    results[1] = "committed";
    results[2] = outcome(
      await initializeAdapter.maintenance.initializeAuthority(contexts.initialize, sourceEnvelope),
    );
    results[3] = outcome(
      await restoreAdapter.maintenance.restoreAuthority(contexts.restore, restoreEnvelope),
    );
    results[4] = outcome(
      await prepareAdapter.maintenance.prepareMigration(contexts.prepare, {
        expectedSchemaVersion: 1,
        targetSchemaVersion: 2,
      }),
    );
    results[5] = outcome(await advanceAdapter.maintenance.advanceMigration(contexts.advance));
    results[6] = outcome(await failAdapter.maintenance.failMigration(contexts.fail));
    results[7] = outcome(await recoverAdapter.maintenance.recoverMigration(contexts.recover));

    crossTenantRecords = await multi.maintenance.exportAuthority(aliceExportContext);
    results[8] = outcome(
      await multi.maintenance.restoreAuthority(aliceRestoreContext, bobEnvelope),
    );
  } finally {
    defineProperty(OriginalWeakMap.prototype, "get", descriptors.weakMapGet);
    defineProperty(OriginalWeakMap.prototype, "set", descriptors.weakMapSet);
    defineProperty(OriginalWeakMap.prototype, "has", descriptors.weakMapHas);
    defineProperty(OriginalObject, "values", descriptors.values);
    defineProperty(OriginalObject, "entries", descriptors.entries);
    defineProperty(OriginalObject, "keys", descriptors.keys);
    defineProperty(OriginalObject, "freeze", descriptors.freeze);
    defineProperty(OriginalObject, "getOwnPropertyDescriptors", descriptors.descriptors);
    defineProperty(OriginalObject, "getPrototypeOf", descriptors.prototype);
    defineProperty(OriginalObject, "create", descriptors.create);
    defineProperty(OriginalObject, "assign", descriptors.assign);
    defineProperty(OriginalObject, "is", descriptors.is);
    defineProperty(OriginalArray, "isArray", descriptors.isArray);
    defineProperty(OriginalFunction.prototype, "call", descriptors.call);
    defineProperty(OriginalFunction.prototype, "apply", descriptors.apply);
    defineProperty(OriginalFunction.prototype, "bind", descriptors.bind);
    defineProperty(Reflect, "apply", descriptors.reflectApply);
    defineProperty(Reflect, "ownKeys", descriptors.reflectOwnKeys);
    defineProperty(Reflect, "getPrototypeOf", descriptors.reflectGetPrototypeOf);
    defineProperty(globalThis, "structuredClone", descriptors.structuredClone);
    defineProperty(JSON, "parse", descriptors.jsonParse);
    defineProperty(JSON, "stringify", descriptors.jsonStringify);
  }

  assert(forgedDenied.every(Boolean));
  equals(results.slice(0, 8), Array.from({ length: 8 }, () => "committed"));
  equals(results[8], "denied");
  assert(
    crossTenantRecords &&
      Object.values(crossTenantRecords.records).every((record) => record.tenantId === "tenant_a"),
  );
  for (const snapshot of [exported, inspected]) {
    assert(snapshot && Object.isFrozen(snapshot));
    assert(Object.isFrozen(snapshot.records));
    const nested = Object.values(snapshot.records)[0]!;
    assert(Object.isFrozen(nested));
    assert(Object.isFrozen(nested.value as object));
    const originalGeneration = snapshot.authorityGeneration;
    try {
      (snapshot as { authorityGeneration: number }).authorityGeneration = 0;
    } catch {
      // Expected for a frozen snapshot.
    }
    equals(snapshot.authorityGeneration, originalGeneration);
  }
}

type CandidateFactory = (root: string) => ReturnType<typeof createCandidateAdapter>;

const tenantMaintenanceContext = (
  candidate: ReturnType<typeof createCandidateAdapter>,
  owner: typeof alice,
  purpose: "export" | "inspect" | "restore",
): AuthorityMaintenanceContext =>
  candidate.fixture.issueMaintenanceContext({
    tenant: ctx(owner),
    actorId: `${owner.tenantId}_operator`,
    purpose,
  });

function plannedAliceGrantDisable(
  exported: DurableAuthorityEnvelope,
): DurableAuthorityEnvelope {
  const planned = structuredClone(exported);
  const grant = planned.records[entityKey(ctx(alice), "subject", "grant")]!;
  const value = grant.value as Record<string, unknown>;
  const identity = value.identity as Record<string, unknown>;
  grant.recordVersion++;
  grant.authorityGeneration = planned.authorityGeneration;
  value.status = "disabled";
  value.version = Number(value.version) + 1;
  identity.status = "disabled";
  identity.version = Number(identity.version) + 1;
  assertCurrentEnvelope(planned);
  return planned;
}

async function assertScopedRestoreApplied(
  factory: CandidateFactory,
  root: string,
): Promise<void> {
  const candidate = factory(root);
  const aliceBefore = await candidate.maintenance.exportAuthority(
    tenantMaintenanceContext(candidate, alice, "export"),
  );
  const bobBefore = await candidate.maintenance.exportAuthority(
    tenantMaintenanceContext(candidate, bob, "export"),
  );
  const planned = plannedAliceGrantDisable(aliceBefore);
  const expectedAliceRecords = serialize(planned.records);
  const expectedBobRecords = serialize(bobBefore.records);
  const expectedGeneration = planned.authorityGeneration + 1;
  const grantKey = entityKey(ctx(alice), "subject", "grant");
  const priorGrant = aliceBefore.records[grantKey]!;
  const priorValue = priorGrant.value as Record<string, unknown>;
  const priorIdentity = priorValue.identity as Record<string, unknown>;
  const expectedGrant = planned.records[grantKey]!;
  const expectedValue = expectedGrant.value as Record<string, unknown>;
  const expectedIdentity = expectedValue.identity as Record<string, unknown>;
  assert(Object.values(planned.records).every((record) => record.tenantId === alice.tenantId));
  equals(
    {
      recordVersion: expectedGrant.recordVersion,
      recordAuthorityGeneration: expectedGrant.authorityGeneration,
      status: expectedValue.status,
      version: expectedValue.version,
      identityStatus: expectedIdentity.status,
      identityVersion: expectedIdentity.version,
    },
    {
      recordVersion: priorGrant.recordVersion + 1,
      recordAuthorityGeneration: planned.authorityGeneration,
      status: "disabled",
      version: Number(priorValue.version) + 1,
      identityStatus: "disabled",
      identityVersion: Number(priorIdentity.version) + 1,
    },
  );

  equals(
    await candidate.maintenance.restoreAuthority(
      tenantMaintenanceContext(candidate, alice, "restore"),
      planned,
    ),
    { outcome: "committed", authorityGeneration: expectedGeneration },
  );

  // Recreate the candidate through the public seam so only persisted state can satisfy the proof.
  const reopened = factory(root);
  const aliceAfter = await reopened.maintenance.exportAuthority(
    tenantMaintenanceContext(reopened, alice, "export"),
  );
  const bobAfter = await reopened.maintenance.exportAuthority(
    tenantMaintenanceContext(reopened, bob, "export"),
  );
  equals(serialize(aliceAfter.records), expectedAliceRecords);
  equals(serialize(bobAfter.records), expectedBobRecords);
  equals(aliceAfter.authorityGeneration, expectedGeneration);
  equals(aliceAfter.highWatermarks.authorityGeneration, expectedGeneration);

  const actualGrant = aliceAfter.records[grantKey]!;
  const actualValue = actualGrant.value as Record<string, unknown>;
  const actualIdentity = actualValue.identity as Record<string, unknown>;
  equals(
    {
      recordVersion: actualGrant.recordVersion,
      recordAuthorityGeneration: actualGrant.authorityGeneration,
      status: actualValue.status,
      version: actualValue.version,
      identityStatus: actualIdentity.status,
      identityVersion: actualIdentity.version,
    },
    {
      recordVersion: expectedGrant.recordVersion,
      recordAuthorityGeneration: expectedGrant.authorityGeneration,
      status: "disabled",
      version: expectedValue.version,
      identityStatus: "disabled",
      identityVersion: expectedIdentity.version,
    },
  );
}

/** Deliberately defective candidate used only to prove the conformance assertion catches false commit. */
const falseCommitCandidate: CandidateFactory = (root) => {
  const candidate = createCandidateAdapter(root);
  const maintenance = new Proxy(candidate.maintenance, {
    get(target, property) {
      if (property === "restoreAuthority") {
        return (
          _context: AuthorityMaintenanceContext,
          snapshot: DurableAuthorityEnvelope,
        ) =>
          Promise.resolve({
            outcome: "committed" as const,
            authorityGeneration: snapshot.authorityGeneration + 1,
          });
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return Object.freeze({
    transactions: candidate.transactions,
    maintenance,
    fixture: candidate.fixture,
  });
};

const cases: Record<string, (root: string) => Promise<void>> = {
  "DUR-01": async (root) => {
    await setup(root);
    const candidate = createCandidateAdapter(root);
    const adapter: DurableAuthorityTransactions = candidate.transactions;
    const maintenance: DurableAuthorityMaintenance = candidate.maintenance;
    const authorize = (
      purpose: "export" | "inspect" | "restore",
      owner = alice,
    ) =>
      candidate.fixture.issueMaintenanceContext({
        tenant: ctx(owner),
        actorId: "durability_operator",
        purpose,
      });
    const exportContext = authorize("export");
    const exported = await maintenance.exportAuthority(exportContext);
    assertCurrentEnvelope(exported);
    assert(Object.isFrozen(exported));
    assert(Object.isFrozen(exported.records));
    assert(Object.isFrozen(Object.values(exported.records)[0]!));
    const frozenAgent = exported.records[entityKey(ctx(), "subject", "agent")]!.value as Record<
      string,
      unknown
    >;
    assert(Object.isFrozen(frozenAgent));
    assert(Object.isFrozen(frozenAgent.identity as object));
    assert(
      Object.isFrozen(
        ((frozenAgent.identity as Record<string, unknown>).publicJwk as Record<string, unknown>)
          .key_ops as object,
      ),
    );
    equals(Object.getPrototypeOf(exported), null);
    equals(Object.getPrototypeOf(exported.records), null);
    assert(typeof adapter.reserveInvocation === "function");
    await rejects(() =>
      maintenance.exportAuthority({
        tenant: ctx(),
        actorId: "durability_operator",
        purpose: "export",
      } as unknown as AuthorityMaintenanceContext)
    );
    let capabilityReads = 0;
    const proxiedContext = new Proxy(exportContext, {
      get(target, property, receiver) {
        capabilityReads++;
        return Reflect.get(target, property, receiver);
      },
    });
    await rejects(() => maintenance.exportAuthority(proxiedContext));
    equals(capabilityReads, 0);
    await rejects(() => maintenance.exportAuthority(authorize("inspect")));
    await rejects(() =>
      candidate.fixture.issueMaintenanceContext({
        tenant: ctx(),
        actorId: "invalid actor",
        purpose: "export",
      })
    );
    equals(
      Object.keys(
        await maintenance.exportAuthority(authorize("export", bob)).then((value) => value.records),
      ),
      [],
    );
    const foreignContext = createCandidateAdapter(root).fixture.issueMaintenanceContext({
      tenant: ctx(),
      actorId: "durability_operator",
      purpose: "export",
    });
    await rejects(() => maintenance.exportAuthority(foreignContext));
    equals(
      Object.keys((await maintenance.inspectAuthority(authorize("inspect", bob))).records),
      [],
    );
    for (
      const purpose of [
        "prepare_migration",
        "advance_migration",
        "fail_migration",
        "recover_migration",
      ] as const
    ) {
      await rejects(() =>
        candidate.fixture.issueMaintenanceContext({
          tenant: ctx(),
          actorId: "durability_operator",
          purpose,
        } as never)
      );
    }
    await rejects(() =>
      maintenance.prepareMigration(authorize("export"), {
        expectedSchemaVersion: 1,
        targetSchemaVersion: 2,
      })
    );
    equals(
      outcome(await maintenance.restoreAuthority(authorize("restore", bob), exported)),
      "denied",
    );
    const pristine = createCandidateAdapter(`${root}/pristine`);
    await rejects(() =>
      pristine.fixture.issueMaintenanceContext({
        tenant: ctx(bob),
        actorId: "durability_operator",
        purpose: "initialize",
      } as never)
    );
    await rejects(() =>
      pristine.maintenance.initializeAuthority(authorize("export", bob), exported)
    );
    equals((await inspect(root)).exists, true);
    await exercisePostImportIntrinsicReplacement(root);
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

    const candidate = createCandidateAdapter(root);
    const aliceExport = await candidate.maintenance.exportAuthority(
      tenantMaintenanceContext(candidate, alice, "export"),
    );
    const bobExport = await candidate.maintenance.exportAuthority(
      tenantMaintenanceContext(candidate, bob, "export"),
    );
    assert(
      Object.values(aliceExport.records).every((record) => record.tenantId === alice.tenantId),
    );
    assert(Object.values(bobExport.records).every((record) => record.tenantId === bob.tenantId));
    const aliceBefore = serialize(aliceExport.records);
    const bobBefore = serialize(bobExport.records);
    const aliceGrantKey = entityKey(ctx(alice), "subject", "grant");
    const bobGrantKey = entityKey(ctx(bob), "subject", "grant");
    assert(!(bobGrantKey in aliceExport.records));

    // A tenant snapshot may neither inject a new foreign record nor overwrite an existing one.
    const foreignInjection = structuredClone(aliceExport);
    const injectedReplayKey = replayKey(ctx(bob), "nonce", "restore_injection");
    foreignInjection.records[injectedReplayKey] = {
      tenantId: bob.tenantId,
      userId: bob.userId,
      recordVersion: 1,
      authorityGeneration: foreignInjection.authorityGeneration,
      value: {
        kind: "nonce",
        hash: "restore_injection",
        expiresAt: 90,
        generation: foreignInjection.highWatermarks.replayGeneration,
      },
    };
    equals(
      outcome(
        await candidate.maintenance.restoreAuthority(
          tenantMaintenanceContext(candidate, alice, "restore"),
          foreignInjection,
        ),
      ),
      "denied",
    );

    const foreignOverwrite = structuredClone(aliceExport);
    const overwrittenBobGrant = structuredClone(bobExport.records[bobGrantKey]!);
    const overwrittenValue = overwrittenBobGrant.value as Record<string, unknown>;
    const overwrittenIdentity = overwrittenValue.identity as Record<string, unknown>;
    overwrittenBobGrant.recordVersion++;
    overwrittenBobGrant.authorityGeneration = foreignOverwrite.authorityGeneration;
    overwrittenValue.status = "disabled";
    overwrittenValue.version = Number(overwrittenValue.version) + 1;
    overwrittenIdentity.status = "disabled";
    overwrittenIdentity.version = Number(overwrittenIdentity.version) + 1;
    foreignOverwrite.records[bobGrantKey] = overwrittenBobGrant;
    equals(
      outcome(
        await candidate.maintenance.restoreAuthority(
          tenantMaintenanceContext(candidate, alice, "restore"),
          foreignOverwrite,
        ),
      ),
      "denied",
    );

    // Omitting an existing record from the owned partition is a denied monotonic deletion.
    const ownedDeletion = structuredClone(aliceExport);
    delete ownedDeletion.records[aliceGrantKey];
    equals(
      outcome(
        await candidate.maintenance.restoreAuthority(
          tenantMaintenanceContext(candidate, alice, "restore"),
          ownedDeletion,
        ),
      ),
      "denied",
    );
    equals(
      outcome(
        await candidate.maintenance.restoreAuthority(
          tenantMaintenanceContext(candidate, alice, "restore"),
          bobExport,
        ),
      ),
      "denied",
    );
    equals(
      serialize(
        (await candidate.maintenance.exportAuthority(
          tenantMaintenanceContext(candidate, alice, "export"),
        )).records,
      ),
      aliceBefore,
    );
    equals(
      serialize(
        (await candidate.maintenance.exportAuthority(
          tenantMaintenanceContext(candidate, bob, "export"),
        )).records,
      ),
      bobBefore,
    );

    // Apply a genuine Alice-only monotonic authority transition and prove it survived reopening.
    await assertScopedRestoreApplied(createCandidateAdapter, root);

    // The same proof must reject an adapter that claims commit but does not write the snapshot.
    const falseCommitRoot = `${root}/false_commit`;
    await Promise.all([
      setup(falseCommitRoot, alice, "false_commit_a"),
      setup(falseCommitRoot, bob, "false_commit_b"),
    ]);
    await rejects(() => assertScopedRestoreApplied(falseCommitCandidate, falseCommitRoot));
    await rejects(() => candidate.maintenance.recoverMigration({} as AuthorityMaintenanceContext));
    await candidate.fixture.writeLegacy(alice);
    const globalRecovery = candidate.fixture.issueAuthorityMaintenanceContext({
      actorId: "schema_authority_operator",
      purpose: "recover_migration",
    });
    equals(outcome(await candidate.maintenance.recoverMigration(globalRecovery)), "committed");
    const globalInspection = await candidate.maintenance.inspectAuthority(
      candidate.fixture.issueAuthorityMaintenanceContext({
        actorId: "schema_authority_operator",
        purpose: "inspect",
      }),
    );
    assertCurrentEnvelope(globalInspection);
    assert(entityKey(ctx(alice), "subject", "agent") in globalInspection.records);
    assert(entityKey(ctx(bob), "subject", "agent") in globalInspection.records);
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
    const graph = await ok({ action: "export", root }) as DurableAuthorityEnvelope;
    const agent2Key = entityKey(ctx(), "subject", "agent2");
    graph.records[agent2Key] = {
      tenantId: "tenant_a",
      userId: "user",
      recordVersion: Math.max(...Object.values(graph.records).map((item) => item.recordVersion)) +
        1,
      authorityGeneration: graph.authorityGeneration,
      value: {
        kind: "agent",
        id: "agent2",
        status: "active",
        version: 1,
        identity: {
          id: "agent2",
          tenantId: "tenant_a",
          userId: "user",
          publicJwk: FIXTURE_JWKS.candidate,
          thumbprint: FIXTURE_THUMBPRINTS.candidate,
          status: "active",
          epoch: 1,
        },
      },
    };
    const graphRoot = `${root}/graph`;
    equals(
      outcome(await ok({ action: "initializeAuthority", root: graphRoot, transaction: graph })),
      "committed",
    );
    equals(
      outcome(await reserve(graphRoot, "cross_agent", alice, { agentId: "agent2" })),
      "denied",
    );
  },
  "DUR-07": async (root) => {
    await setup(root);
    await reserve(root, "dispatch");
    const claims = await Promise.all(Array.from({ length: 8 }, () => claim(root, "dispatch")));
    equals(claims.filter(grantsDispatchPermit).length, 1);
    const permit = claims.find(grantsDispatchPermit)!;
    equals(
      outcome(
        await ok({
          action: "start",
          root,
          owner: alice,
          transaction: { permit: { ...permit.permit, authorityGeneration: 1 }, now: 12 },
        }),
      ),
      "denied",
    );
    const started = await ok({
      action: "start",
      root,
      owner: alice,
      transaction: { permit: permit.permit, now: 12 },
    });
    assert(grantsDispatch(started as never));
    equals(outcome(started), "authorized");
    equals(
      outcome(
        await ok({
          action: "start",
          root,
          owner: alice,
          transaction: { permit: permit.permit, now: 12 },
        }),
      ),
      "already_consumed",
    );

    await reserve(root, "proxy_boundary");
    const proxyPermit = await claim(root, "proxy_boundary");
    assert(grantsDispatchPermit(proxyPermit));
    const direct = createCandidateAdapter(root).transactions;
    let reads = 0;
    const hostilePermit = new Proxy(proxyPermit.permit, {
      get(target, property, receiver) {
        reads++;
        return Reflect.get(target, property, receiver);
      },
    });
    await rejects(() => direct.startDispatch(ctx(), { permit: hostilePermit, now: 12 }));
    equals(reads, 0);
    const authenticStart = await direct.startDispatch(ctx(), {
      permit: proxyPermit.permit,
      now: 12,
    });
    equals(outcome(authenticStart), "authorized");
    equals(
      (authenticStart as { authorization: { attemptId: string } }).authorization.attemptId,
      "proxy_boundary",
    );

    const expiryRoot = `${root}/expiry`;
    await setup(expiryRoot);
    await reserve(expiryRoot, "grant_expiry", alice, {
      nonceExpiresAt: 1_200,
      jtiExpiresAt: 1_200,
    });
    const expiringPermit = await claim(expiryRoot, "grant_expiry");
    assert(grantsDispatchPermit(expiringPermit));
    equals(
      outcome(
        await ok({
          action: "start",
          root: expiryRoot,
          owner: alice,
          transaction: { permit: expiringPermit.permit, now: 1_000 },
        }),
      ),
      "denied",
    );

    await reserve(root, "start_revoked", alice, {
      now: 13,
      nonceExpiresAt: 700,
      jtiExpiresAt: 700,
    });
    const revokedPermit = await claim(root, "start_revoked", alice, 14);
    assert(grantsDispatchPermit(revokedPermit));
    await reserve(root, "claim_revoked", alice, {
      now: 14,
      nonceExpiresAt: 700,
      jtiExpiresAt: 700,
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
            expectedVersion: 1,
            nextVersion: 2,
            nextStatus: "revoked",
            reason: "compromise",
            now: 15,
          },
        }),
      ),
      "committed",
    );
    equals(
      outcome(
        await ok({
          action: "start",
          root,
          owner: alice,
          transaction: { permit: revokedPermit.permit, now: 16 },
        }),
      ),
      "denied",
    );
    equals(outcome(await claim(root, "claim_revoked", alice, 16)), "denied");
  },
  "DUR-08": async (root) => {
    await setup(root);
    // A crash before atomic hard-link acquisition may leave a prepared claimant, never a lock.
    await Deno.writeTextFile(`${root}/authority.lock.orphan.claim`, "orphan");
    equals(outcome(await reserve(root, "orphan_claimant")), "reserved");
    const result = await run({
      action: "reserveFault",
      root,
      owner: alice,
      transaction: binding("before"),
      fault: "abrupt_before_commit",
    });
    equals(result.code, 75);
    const lock = await Deno.stat(`${root}/authority.lock`);
    assert(lock.isFile);
    const owner = JSON.parse(await Deno.readTextFile(`${root}/authority.lock`)) as Record<
      string,
      unknown
    >;
    assert(Number.isSafeInteger(owner.pid) && Number(owner.pid) > 0);
    assert(Number.isSafeInteger(owner.acquiredAt));
    const recoveryStarted = Date.now();
    equals(
      outcome(
        await ok({
          action: "claim",
          root,
          owner: alice,
          transaction: { attemptId: "absent", expectedState: "reserved", now: 11 },
        }),
      ),
      "denied",
    );
    const tenant = tenantOf(await inspect(root));
    assert(Date.now() - recoveryStarted < 2_000);
    await rejects(() => Deno.stat(`${root}/authority.lock`));
    equals(Object.keys(tenant.attempts as object), ["orphan_claimant"]);
    equals(Object.keys(tenant.replay as object).sort(), [
      "jti/jti_orphan_claimant",
      "nonce/agent_orphan_claimant",
      "nonce/device_orphan_claimant",
    ]);
  },
  "DUR-09": async (root) => {
    await setup(root);
    const result = await run({
      action: "reserveFault",
      root,
      owner: alice,
      transaction: binding("ambiguous"),
      fault: "abrupt_after_commit",
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
      fault: "abrupt_after_commit",
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
      (await run({
        action: "start",
        root,
        owner: alice,
        transaction: {
          permit: (permit as Extract<DispatchPermitClaim, { outcome: "permit" }>).permit,
          now: 12,
        },
        fault: "ambiguous",
      })).code,
      75,
    );
    const attempt =
      (tenantOf(await inspect(root)).attempts as Record<string, Record<string, unknown>>)
        .start_ambiguity!;
    equals({ started: attempt.dispatchStarted, count: attempt.dispatchStarts }, {
      started: true,
      count: 1,
    });
    assert(grantsDispatchPermit(permit));
    equals(
      outcome(
        await ok({
          action: "start",
          root,
          owner: alice,
          transaction: { permit: permit.permit, now: 12 },
        }),
      ),
      "already_consumed",
    );
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
    assert(grantsDispatchPermit(permit));
    equals(
      outcome(
        await ok({
          action: "start",
          root,
          owner: alice,
          transaction: { permit: permit.permit, now: 12 },
        }),
      ),
      "authorized",
    );
    for (
      const badPermit of [
        { ...permit.permit, token: "wrong" },
        { ...permit.permit, authorityGeneration: permit.permit.authorityGeneration + 1 },
        { ...permit.permit, claimVersion: permit.permit.claimVersion + 1 },
        { ...permit.permit, attemptId: "wrong_attempt" },
      ]
    ) {
      equals(
        outcome(
          await ok({
            action: "finalize",
            root,
            owner: alice,
            transaction: {
              attemptId: "final",
              expectedState: "dispatching",
              permit: badPermit,
              nextState: "completed",
              result: { outcome: "completed", resultHash: "result_hash" },
              now: 12,
            },
          }),
        ),
        "denied",
      );
    }
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
            reason: "operator",
            now: 20,
          },
        }),
      ),
      "committed",
    );
    for (const [expectedVersion, nextVersion] of [[2, 2], [1, 2]] as const) {
      equals(
        outcome(
          await ok({
            action: "transition",
            root,
            owner: alice,
            transaction: {
              subjectType: "device",
              subjectId: "device",
              expectedVersion,
              nextVersion,
              nextStatus: "active",
              reason: "operator",
              now: 21,
            },
          }),
        ),
        "denied",
      );
    }
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
            now: 22,
          },
        }),
      ),
      "committed",
    );
    const device = (tenantOf(await inspect(root)).subjects as Record<
      string,
      Record<string, unknown>
    >).device!;
    equals({ status: device.status, version: device.version }, { status: "active", version: 3 });
  },
  "DUR-15": async (root) => {
    await setup(root);
    await ok({
      action: "issue",
      root,
      owner: alice,
      transaction: await challenge(alice, "bound", "enroll_candidate"),
    });
    const mismatch = {
      challengeId: "bound",
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
    const mutation = { kind: "enrollment", value: enrollmentValue(alice, "race_request") };
    await ok({
      action: "issue",
      root,
      owner: alice,
      transaction: await challenge(alice, "race", "enroll_candidate", 10, mutation),
    });
    const tx = {
      challengeId: "race",
      purpose: "enroll_candidate",
      now: 20,
      mutation,
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
    const invalidBootstrap = structuredClone(bootstrapValue(alice));
    invalidBootstrap.principal.epoch = 7;
    invalidBootstrap.agent.epoch = 7;
    invalidBootstrap.device.epoch = 7;
    (invalidBootstrap.agent as { thumbprint: string }).thumbprint =
      "caller_supplied_agent_thumbprint";
    (invalidBootstrap.device as { thumbprint: string }).thumbprint =
      "caller_supplied_device_thumbprint";
    const invalidMutation = { kind: "bootstrap", value: invalidBootstrap };
    const invalidRoot = `${root}/invalid_bootstrap`;
    await ok({
      action: "issue",
      root: invalidRoot,
      owner: alice,
      transaction: await challenge(alice, "invalid_bootstrap", "bootstrap", 10, invalidMutation),
    });
    equals(
      outcome(
        await ok({
          action: "commit",
          root: invalidRoot,
          owner: alice,
          transaction: {
            challengeId: "invalid_bootstrap",
            purpose: "bootstrap",
            now: 20,
            mutation: invalidMutation,
          },
        }),
      ),
      "denied",
    );
    equals(Object.keys(tenantOf(await inspect(invalidRoot)).subjects as object).length, 0);

    const frozenRoot = `${root}/frozen_enrollment`;
    await setup(frozenRoot);
    const unbounded = enrollmentValue(alice, "unbounded");
    unbounded.request.expiresAt = 10_000;
    const unboundedMutation = { kind: "enrollment", value: unbounded };
    await ok({
      action: "issue",
      root: frozenRoot,
      owner: alice,
      transaction: await challenge(
        alice,
        "unbounded",
        "enroll_candidate",
        10,
        unboundedMutation,
      ),
    });
    equals(
      outcome(
        await ok({
          action: "commit",
          root: frozenRoot,
          owner: alice,
          transaction: {
            challengeId: "unbounded",
            purpose: "enroll_candidate",
            now: 20,
            mutation: unboundedMutation,
          },
        }),
      ),
      "denied",
    );
    const boundedMutation = {
      kind: "enrollment",
      value: enrollmentValue(alice, "epoch_request"),
    };
    await ok({
      action: "issue",
      root: frozenRoot,
      owner: alice,
      transaction: await challenge(alice, "bounded", "enroll_candidate", 10, boundedMutation),
    });
    equals(
      outcome(
        await ok({
          action: "commit",
          root: frozenRoot,
          owner: alice,
          transaction: {
            challengeId: "bounded",
            purpose: "enroll_candidate",
            now: 20,
            mutation: boundedMutation,
          },
        }),
      ),
      "committed",
    );
    equals(
      (await run({
        action: "transition",
        root: frozenRoot,
        owner: alice,
        transaction: {
          subjectType: "agent",
          subjectId: "agent",
          expectedVersion: 1,
          nextVersion: 2,
          nextStatus: "revoked",
          reason: "compromise",
          now: 20,
        },
      })).outcome,
      "denied",
    );
    const epochSeven = approvalValue(alice, "epoch_request");
    epochSeven.device.epoch = 7;
    const epochSevenMutation = { kind: "approval", value: epochSeven };
    await ok({
      action: "issue",
      root: frozenRoot,
      owner: alice,
      transaction: await challenge(
        alice,
        "epoch_seven",
        "approve_enrollment",
        10,
        epochSevenMutation,
      ),
    });
    equals(
      outcome(
        await ok({
          action: "commit",
          root: frozenRoot,
          owner: alice,
          transaction: {
            challengeId: "epoch_seven",
            purpose: "approve_enrollment",
            now: 20,
            mutation: epochSevenMutation,
          },
        }),
      ),
      "denied",
    );
    const importedUnbounded = await ok({
      action: "export",
      root: frozenRoot,
    }) as DurableAuthorityEnvelope;
    const importedRequest = importedUnbounded.records[
      entityKey(ctx(), "enrollment", "epoch_request")
    ]!.value as Record<string, Record<string, unknown>>;
    importedRequest.request!.expiresAt = 10_000;
    equals(
      outcome(
        await ok({
          action: "initializeAuthority",
          root: `${frozenRoot}/imported_unbounded`,
          transaction: importedUnbounded,
        }),
      ),
      "denied",
    );

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
      await ok({
        action: "issue",
        root,
        owner: alice,
        transaction: await challenge(alice, id, purpose, 10, mutation),
      });
      const before = tenantOf(await inspect(root));
      equals(
        outcome(
          await ok({
            action: "commit",
            root,
            owner: alice,
            transaction: {
              challengeId: id,
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
      const invalid = structuredClone(mutation) as { kind: string; value: Record<string, unknown> };
      if (invalid.kind === "bootstrap") {
        (invalid.value.agent as Record<string, unknown>).status = "revoked";
      } else if (invalid.kind === "enrollment") {
        (invalid.value.request as Record<string, unknown>).status = "approved";
      } else if (invalid.kind === "approval") invalid.value.approverThumbprint = "wrong_thumb";
      else invalid.value.targetThumbprint = "wrong_thumb";
      equals(
        outcome(
          await ok({
            action: "commit",
            root,
            owner: alice,
            transaction: {
              challengeId: id,
              purpose,
              now: 20,
              mutation: invalid,
            },
          }),
        ),
        "denied",
      );
      equals(serialize(tenantOf(await inspect(root))), serialize(before));
      equals(
        outcome(
          await ok({
            action: "commit",
            root,
            owner: alice,
            transaction: {
              challengeId: id,
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
    const persisted = await ok({ action: "export", root }) as DurableAuthorityEnvelope;
    const approved = persisted.records[entityKey(ctx(), "enrollment", "request")]!.value as Record<
      string,
      Record<string, unknown>
    >;
    equals(approved.request!.status, "approved");
    const candidate = persisted.records[entityKey(ctx(), "subject", "candidate")]!.value as Record<
      string,
      Record<string, unknown>
    >;
    equals({ role: candidate.identity!.role, status: candidate.identity!.status }, {
      role: "member",
      status: "revoked",
    });
    equals(approved.approvedDeviceId, "candidate");
    const removed = persisted.records[entityKey(ctx(), "subject", "candidate")]!.value as Record<
      string,
      Record<string, unknown>
    >;
    equals({ status: removed.status, identityStatus: removed.identity!.status }, {
      status: "revoked",
      identityStatus: "revoked",
    });
    equals(
      outcome(
        await ok({
          action: "transition",
          root,
          owner: alice,
          transaction: {
            subjectType: "agent",
            subjectId: "agent",
            expectedVersion: 1,
            nextVersion: 2,
            nextStatus: "revoked",
            reason: "compromise",
            now: 30,
          },
        }),
      ),
      "committed",
    );
    const historical = await ok({ action: "export", root }) as DurableAuthorityEnvelope;
    const historicalAgent = historical.records[entityKey(ctx(), "subject", "agent")]!
      .value as Record<string, unknown>;
    equals(historicalAgent.status, "revoked");
    equals(
      outcome(
        await ok({
          action: "initializeAuthority",
          root: `${root}/historical_copy`,
          transaction: historical,
        }),
      ),
      "committed",
    );
    equals(
      outcome(
        await ok({
          action: "restore",
          root: `${root}/historical_copy`,
          transaction: historical,
        }),
      ),
      "committed",
    );
  },
  "DUR-18": async (root) => {
    const unsupportedRoot = `${root}/unsupported_target`;
    await setup(unsupportedRoot);
    const beforeUnsupported = await ok({
      action: "raw",
      root: unsupportedRoot,
      transaction: false,
    }) as DurableAuthorityEnvelope;
    equals(
      outcome(
        await ok({
          action: "prepareMigration",
          root: unsupportedRoot,
          transaction: { expectedSchemaVersion: 2, targetSchemaVersion: 3 },
        }),
      ),
      "denied",
    );
    const afterUnsupported = await ok({
      action: "raw",
      root: unsupportedRoot,
      transaction: false,
    }) as DurableAuthorityEnvelope;
    equals(afterUnsupported.migration.status, "idle");
    equals(afterUnsupported.migration.toVersion, 2);
    equals(afterUnsupported.authorityGeneration, beforeUnsupported.authorityGeneration);
    equals(outcome(await ok({ action: "failMigration", root: unsupportedRoot })), "denied");
    equals(outcome(await ok({ action: "recoverMigration", root: unsupportedRoot })), "committed");
    assertCurrentEnvelope(
      await ok({ action: "export", root: unsupportedRoot }) as DurableAuthorityEnvelope,
    );

    const makeLegacy = async (name: string): Promise<DurableAuthorityEnvelope> => {
      const source = `${root}/source_${name}`;
      await setup(source);
      const envelope = await ok({ action: "export", root: source }) as DurableAuthorityEnvelope;
      envelope.schemaVersion = 1;
      envelope.highWatermarks.schemaVersion = 1;
      envelope.migration = { status: "idle", generation: 0, fromVersion: 1, toVersion: 1 };
      envelope.highWatermarks.replayGeneration++;
      const legacyKey = replayKey(ctx(), "nonce", "legacy");
      envelope.records[legacyKey] = {
        tenantId: "tenant_a",
        userId: "user",
        recordVersion:
          Math.max(...Object.values(envelope.records).map((item) => item.recordVersion)) + 1,
        authorityGeneration: envelope.authorityGeneration,
        value: {
          kind: "nonce",
          hash: "legacy",
          expiresAt: 999,
          generation: envelope.highWatermarks.replayGeneration,
        },
      };
      return envelope;
    };
    for (const stateName of ["preparing", "committing", "failed"] as const) {
      const migrationRoot = `${root}/${stateName}`;
      const legacyEnvelope = await makeLegacy(stateName);
      equals(
        outcome(
          await ok({
            action: "initializeAuthority",
            root: migrationRoot,
            transaction: legacyEnvelope,
          }),
        ),
        "committed",
      );
      equals(
        outcome(
          await ok({
            action: "prepareMigration",
            root: migrationRoot,
            transaction: { expectedSchemaVersion: 1, targetSchemaVersion: 2 },
          }),
        ),
        "committed",
      );
      if (stateName === "committing") {
        equals(outcome(await ok({ action: "advanceMigration", root: migrationRoot })), "committed");
      }
      if (stateName === "failed") {
        equals(outcome(await ok({ action: "failMigration", root: migrationRoot })), "committed");
      }
      const raw = await ok({
        action: "raw",
        root: migrationRoot,
        transaction: false,
      }) as DurableAuthorityEnvelope;
      equals(raw.migration.status, stateName);
      equals(outcome(await ok({ action: "recoverMigration", root: migrationRoot })), "committed");
      const exported = await ok({
        action: "export",
        root: migrationRoot,
      }) as DurableAuthorityEnvelope;
      assertCurrentEnvelope(exported);
      assert(replayKey(ctx(), "nonce", "legacy") in exported.records);
    }
    const legacy = validEnvelope();
    const legacyAgent = legacy.records[entityKey(ctx(), "subject", "agent")]!;
    Object.assign(legacyAgent.value as Record<string, unknown>, {
      status: "revoked",
      version: 2,
    });
    Object.assign((legacyAgent.value as Record<string, Record<string, unknown>>).identity!, {
      status: "revoked",
      epoch: 2,
    });
    let historicalVersion = Math.max(
      ...Object.values(legacy.records).map((item) => item.recordVersion),
    );
    legacy.records[entityKey(ctx(), "subject", "candidate")] = {
      tenantId: "tenant_a",
      userId: "user",
      recordVersion: ++historicalVersion,
      authorityGeneration: legacy.authorityGeneration,
      value: {
        kind: "device",
        id: "candidate",
        status: "revoked",
        version: 2,
        identity: {
          id: "candidate",
          tenantId: "tenant_a",
          userId: "user",
          agentId: "agent",
          publicJwk: FIXTURE_JWKS.candidate,
          thumbprint: FIXTURE_THUMBPRINTS.candidate,
          role: "member",
          status: "revoked",
          epoch: 2,
        },
      },
    };
    legacy.records[entityKey(ctx(), "enrollment", "historical_request")] = {
      tenantId: "tenant_a",
      userId: "user",
      recordVersion: ++historicalVersion,
      authorityGeneration: legacy.authorityGeneration,
      value: {
        request: {
          id: "historical_request",
          tenantId: "tenant_a",
          userId: "user",
          agentId: "agent",
          candidateJwk: FIXTURE_JWKS.candidate,
          thumbprint: FIXTURE_THUMBPRINTS.candidate,
          status: "approved",
          expiresAt: 400,
        },
        approvedDeviceId: "candidate",
      },
    };
    legacy.schemaVersion = 1;
    legacy.highWatermarks.schemaVersion = 1;
    legacy.migration = { status: "idle", generation: 0, fromVersion: 1, toVersion: 1 };
    const migrated = migrateAuthorityEnvelope(legacy, [{
      fromVersion: 1,
      toVersion: 2,
      migrate(value) {
        value.schemaVersion = 2;
        value.authorityGeneration++;
        value.highWatermarks.authorityGeneration = value.authorityGeneration;
        value.highWatermarks.schemaVersion = 2;
        value.migration = { status: "idle", generation: 1, fromVersion: 1, toVersion: 2 };
        value.highWatermarks.migrationGeneration = 1;
        return value;
      },
    }]);
    assertCurrentEnvelope(migrated);
    const helperRoot = `${root}/helper_restore`;
    equals(
      outcome(
        await ok({
          action: "initializeAuthority",
          root: helperRoot,
          transaction: migrated,
        }),
      ),
      "committed",
    );
    equals(
      outcome(
        await ok({
          action: "restore",
          root: helperRoot,
          transaction: migrated,
        }),
      ),
      "committed",
    );
    assertCurrentEnvelope(
      await ok({ action: "export", root: helperRoot }) as DurableAuthorityEnvelope,
    );
    const rollback = structuredClone(legacy);
    rollback.records[entityKey(ctx(), "subject", "device")]!.recordVersion = 99;
    const deviceKey = entityKey(ctx(), "subject", "device");
    const grantKey = entityKey(ctx(), "subject", "grant");
    const rejectsMigration = async (
      before: DurableAuthorityEnvelope,
      mutate: (value: DurableAuthorityEnvelope) => void,
    ) => {
      await rejects(() =>
        migrateAuthorityEnvelope(before, [{
          fromVersion: 1,
          toVersion: 2,
          migrate(value) {
            value.schemaVersion = 2;
            value.authorityGeneration++;
            value.highWatermarks.authorityGeneration = value.authorityGeneration;
            value.highWatermarks.schemaVersion = 2;
            value.highWatermarks.migrationGeneration++;
            value.migration = { status: "idle", generation: 1, fromVersion: 1, toVersion: 2 };
            mutate(value);
            return value;
          },
        }])
      );
    };
    await rejectsMigration(rollback, (value) => {
      value.records[deviceKey]!.recordVersion = 1;
    });
    await rejectsMigration(legacy, (value) => {
      delete value.records[deviceKey];
    });
    await rejectsMigration(legacy, (value) => {
      value.records[deviceKey]!.authorityGeneration--;
    });
    await rejectsMigration(legacy, (value) => {
      const grant = value.records[grantKey]!.value as Record<string, unknown>;
      grant.status = "disabled";
    });
    await rejectsMigration(legacy, (value) => {
      value.authorityGeneration = legacy.authorityGeneration - 1;
      value.highWatermarks.authorityGeneration = value.authorityGeneration;
    });
    const revoked = structuredClone(legacy);
    const revokedDevice = revoked.records[deviceKey]!.value as Record<string, unknown>;
    revokedDevice.status = "revoked";
    (revokedDevice.identity as Record<string, unknown>).status = "revoked";
    await rejectsMigration(revoked, (value) => {
      const item = value.records[deviceKey]!;
      item.recordVersion++;
      const device = item.value as Record<string, unknown>;
      device.status = "active";
      (device.identity as Record<string, unknown>).status = "active";
    });
    const logicalVersion = structuredClone(legacy);
    const logicalDevice = logicalVersion.records[deviceKey]!.value as Record<string, unknown>;
    logicalDevice.version = 3;
    (logicalDevice.identity as Record<string, unknown>).epoch = 3;
    await rejectsMigration(logicalVersion, (value) => {
      const item = value.records[deviceKey]!;
      item.recordVersion += 100;
      const device = item.value as Record<string, unknown>;
      device.version = 1;
      (device.identity as Record<string, unknown>).epoch = 1;
    });
    const completed = structuredClone(legacy);
    const attemptKey = entityKey(ctx(), "attempt", "attempt");
    Object.assign(completed.records[attemptKey]!.value as Record<string, unknown>, {
      state: "completed",
      claimVersion: 1,
      permitHash: "durablepermit",
      permitAuthorityGeneration: 3,
      dispatchStarted: true,
      dispatchStarts: 1,
      result: { outcome: "completed", resultHash: "result_hash" },
    });
    await rejectsMigration(completed, (value) => {
      const item = value.records[attemptKey]!;
      item.recordVersion += 100;
      Object.assign(item.value as Record<string, unknown>, {
        state: "reserved",
        claimVersion: 0,
        permitHash: null,
        permitAuthorityGeneration: null,
        dispatchStarted: false,
        dispatchStarts: 0,
        result: null,
      });
    });
  },
  "DUR-19": async (root) => {
    const source = `${root}/source`;
    await setup(source);
    const envelope = await ok({ action: "export", root: source }) as DurableAuthorityEnvelope;
    envelope.schemaVersion = 1;
    envelope.highWatermarks.schemaVersion = 1;
    envelope.migration = { status: "idle", generation: 0, fromVersion: 1, toVersion: 1 };
    equals(
      outcome(await ok({ action: "initializeAuthority", root, transaction: envelope })),
      "committed",
    );
    const preMigration = await run({
      action: "reserve",
      root,
      owner: alice,
      transaction: binding("old_schema_denied"),
    });
    equals({ code: preMigration.code, outcome: preMigration.outcome }, {
      code: 0,
      outcome: "denied",
    });
    equals(
      (await run({ action: "inspectAuthority", root, transaction: true })).outcome,
      "denied",
    );
    const results = await Promise.all(
      Array.from({ length: 6 }, () => ok({ action: "recoverMigration", root })),
    );
    assert(results.every((item) => outcome(item) === "committed"));
    const migrated = await ok({ action: "export", root }) as DurableAuthorityEnvelope;
    assertCurrentEnvelope(migrated);
    equals(migrated.migration.generation, 1);
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
    equals(outcome(await ok({ action: "restore", root, path: currentPath })), "denied");
    const recordBase = `records.${entityKey(ctx(), "subject", "device")}`;
    const mutations = [
      { path: recordBase, deletion: true },
      { path: `${recordBase}.recordVersion`, value: 1 },
      { path: `${recordBase}.value.status`, value: "active" },
      { path: `${recordBase}.tenantId`, value: "tenant_b" },
    ];
    for (const mutation of mutations) {
      const path = `${root}/candidate_${crypto.randomUUID()}.json`;
      await ok({ action: "snapshot", root, path });
      await ok({ action: "mutatePath", root, path, mutation });
      equals(outcome(await ok({ action: "restore", root, path })), "denied");
    }
    await ok({
      action: "issue",
      root,
      owner: alice,
      transaction: await challenge(alice, "restore_expired", "bootstrap", 20),
    });
    const beforeClock = `${root}/before_clock.json`;
    await ok({ action: "snapshot", root, path: beforeClock });
    await ok({
      action: "consumeReplay",
      root,
      owner: alice,
      transaction: {
        records: [{ kind: "nonce", hash: "clock_restore" }],
        expiresAt: 700,
        now: 600,
      },
    });
    equals(outcome(await ok({ action: "restore", root, path: beforeClock })), "denied");
    equals(
      outcome(
        await ok({
          action: "commit",
          root,
          owner: alice,
          transaction: {
            challengeId: "restore_expired",
            purpose: "bootstrap",
            now: 100,
            mutation: { kind: "bootstrap", value: bootstrapValue(alice) },
          },
        }),
      ),
      "denied",
    );
    const envelope = await ok({ action: "export", root }) as DurableAuthorityEnvelope;
    assertCurrentEnvelope(envelope);
    equals(outcome(await ok({ action: "restore", root, transaction: envelope })), "committed");
    const reactivated = structuredClone(envelope);
    reactivated.authorityGeneration++;
    reactivated.highWatermarks.authorityGeneration = reactivated.authorityGeneration;
    const reactivatedDevice = reactivated.records[entityKey(ctx(), "subject", "device")]!;
    reactivatedDevice.recordVersion++;
    reactivatedDevice.authorityGeneration = reactivated.authorityGeneration;
    Object.assign(reactivatedDevice.value as Record<string, unknown>, {
      status: "active",
      version: 3,
    });
    Object.assign(
      (reactivatedDevice.value as Record<string, Record<string, unknown>>).identity!,
      { status: "active", epoch: 3 },
    );
    assertCurrentEnvelope(reactivated);
    equals(outcome(await ok({ action: "restore", root, transaction: reactivated })), "committed");
    const stale = structuredClone(envelope);
    stale.effectiveNow--;
    await rejects(() => assertRestoreNotStale(stale, envelope));
    const copied = structuredClone(envelope);
    (copied.records[entityKey(ctx(), "subject", "device")]!.value as Record<string, unknown>)
      .status = "active";
    await rejects(() => assertRestoreNotStale(copied, envelope));

    const semanticRoot = `${root}/semantic`;
    await setup(semanticRoot);
    equals(
      outcome(
        await ok({
          action: "transition",
          root: semanticRoot,
          owner: alice,
          transaction: {
            subjectType: "connection",
            subjectId: "connection",
            expectedVersion: 1,
            nextVersion: 2,
            nextStatus: "active",
            reason: "operator",
            now: 20,
          },
        }),
      ),
      "committed",
    );
    const nestedRollback = await ok({
      action: "export",
      root: semanticRoot,
    }) as DurableAuthorityEnvelope;
    const connectionRecord = nestedRollback.records[entityKey(ctx(), "subject", "connection")]!;
    connectionRecord.recordVersion += 100;
    const connectionValue = connectionRecord.value as Record<string, unknown>;
    connectionValue.version = 1;
    (connectionValue.identity as Record<string, unknown>).epoch = 1;
    equals(
      outcome(await ok({ action: "restore", root: semanticRoot, transaction: nestedRollback })),
      "denied",
    );

    await reserve(semanticRoot, "terminal_restore", alice, { connectionEpoch: 2, now: 21 });
    const terminalPermit = await claim(semanticRoot, "terminal_restore");
    assert(grantsDispatchPermit(terminalPermit));
    equals(
      outcome(
        await ok({
          action: "start",
          root: semanticRoot,
          owner: alice,
          transaction: { permit: terminalPermit.permit, now: 22 },
        }),
      ),
      "authorized",
    );
    equals(
      outcome(
        await ok({
          action: "finalize",
          root: semanticRoot,
          owner: alice,
          transaction: {
            attemptId: "terminal_restore",
            expectedState: "dispatching",
            permit: terminalPermit.permit,
            nextState: "completed",
            result: { outcome: "completed", resultHash: "restore_result" },
            now: 23,
          },
        }),
      ),
      "committed",
    );
    const attemptRollback = await ok({
      action: "export",
      root: semanticRoot,
    }) as DurableAuthorityEnvelope;
    const attemptRecord = attemptRollback.records[
      entityKey(ctx(), "attempt", "terminal_restore")
    ]!;
    attemptRecord.recordVersion += 100;
    Object.assign(attemptRecord.value as Record<string, unknown>, {
      state: "reserved",
      claimVersion: 0,
      permitHash: null,
      permitAuthorityGeneration: null,
      dispatchStarted: false,
      dispatchStarts: 0,
      result: null,
    });
    equals(
      outcome(await ok({ action: "restore", root: semanticRoot, transaction: attemptRollback })),
      "denied",
    );
    equals(outcome(await claim(semanticRoot, "terminal_restore", alice, 24)), "already_consumed");
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
          transaction: await challenge(alice, "expired", "bootstrap", 100),
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
    await rejects(() => serializeDurableAuthority(-0));
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
        const replay = value.records[replayKey(ctx(), "nonce", "device_attempt")]!;
        (replay.value as Record<string, unknown>).expiresAt = 0;
      },
      (value) => {
        const attempt = value.records["tenant/tenant_a/user/user/attempt/attempt"]!;
        (attempt.value as Record<string, unknown>).replayKeys = ["missing"];
      },
      (value) => {
        const attempt = value.records["tenant/tenant_a/user/user/attempt/attempt"]!;
        Object.assign(attempt.value as Record<string, unknown>, {
          state: "reserved",
          claimVersion: 1,
          permitHash: "usedpermit",
          permitAuthorityGeneration: 3,
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
        delete value.records[entityKey(ctx(), "custody", "custodyhash")];
      },
      (value) => {
        delete value.records[entityKey(ctx(), "connection", "connection")];
      },
      (value) => {
        delete value.records[entityKey(ctx(), "connection", "connection")];
        delete value.records[entityKey(ctx(), "custody", "custodyhash")];
      },
      (value) => {
        const connection = value.records[entityKey(ctx(), "connection", "connection")]!
          .value as Record<string, unknown>;
        connection.agentId = "other_agent";
      },
      (value) => {
        const custody = value.records[entityKey(ctx(), "custody", "custodyhash")]!
          .value as Record<string, unknown>;
        custody.workload = "wrong.operation";
      },
      (value) => {
        const item = value.records[recordKey]!.value as Record<string, unknown>;
        (item.identity as Record<string, unknown>).status = "revoked";
      },
      (value) => {
        delete value.records[entityKey(ctx(), "subject", "agent")];
      },
      (value) => {
        delete value.records[entityKey(ctx(), "subject", "device")];
      },
      (value) => {
        delete value.records[entityKey(ctx(), "subject", "connection")];
      },
      (value) => {
        const grant = value.records[entityKey(ctx(), "subject", "grant")]!.value as Record<
          string,
          Record<string, unknown>
        >;
        grant.identity!.agentId = "missing_agent";
      },
      (value) => {
        const grant = value.records[entityKey(ctx(), "subject", "grant")]!.value as Record<
          string,
          Record<string, unknown>
        >;
        grant.identity!.deviceId = "connection";
      },
      (value) => {
        const grant = value.records[entityKey(ctx(), "subject", "grant")]!.value as Record<
          string,
          Record<string, unknown>
        >;
        grant.identity!.connectionId = "device";
      },
      (value) => {
        const grant = value.records[entityKey(ctx(), "subject", "grant")]!.value as Record<
          string,
          Record<string, unknown>
        >;
        grant.identity!.expiresAt = 0;
      },
      (value) => {
        const grant = value.records[entityKey(ctx(), "subject", "grant")]!.value as Record<
          string,
          Record<string, unknown>
        >;
        grant.identity!.operation = "wrong.operation";
      },
      (value) => {
        const grant = value.records[entityKey(ctx(), "subject", "grant")]!.value as Record<
          string,
          Record<string, unknown>
        >;
        grant.identity!.tenantId = "tenant_b";
      },
      (value) => {
        const bobReplay = replayKey(ctx(bob), "nonce", "device_attempt");
        value.records[bobReplay] = {
          tenantId: "tenant_b",
          userId: "user",
          recordVersion: 20,
          authorityGeneration: 3,
          value: { kind: "nonce", hash: "device_attempt", expiresAt: 500, generation: 1 },
        };
        const attempt = value.records[entityKey(ctx(), "attempt", "attempt")]!.value as Record<
          string,
          unknown
        >;
        (attempt.replayKeys as string[])[0] = bobReplay;
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
            connectionId: "connection",
            agentId: "agent",
            deviceId: "device",
            workload: "github.user.read",
          },
        };
      },
    ];
    for (const [index, corrupt] of corruptions.entries()) {
      const candidate = structuredClone(envelope);
      corrupt(candidate);
      await rejects(() => assertCurrentEnvelope(candidate));
      equals(
        outcome(
          await ok({
            action: "initializeAuthority",
            root: `${root}/pristine_${index}`,
            transaction: candidate,
          }),
        ),
        "denied",
      );
    }

    const disconnected = structuredClone(envelope);
    delete disconnected.records[entityKey(ctx(), "connection", "connection")];
    delete disconnected.records[entityKey(ctx(), "custody", "custodyhash")];
    const legacyDisconnected = structuredClone(disconnected);
    legacyDisconnected.schemaVersion = 1;
    legacyDisconnected.highWatermarks.schemaVersion = 1;
    legacyDisconnected.migration = {
      status: "idle",
      generation: 0,
      fromVersion: 1,
      toVersion: 1,
    };
    await rejects(() =>
      migrateAuthorityEnvelope(legacyDisconnected, [{
        fromVersion: 1,
        toVersion: 2,
        migrate(value) {
          value.schemaVersion = 2;
          value.highWatermarks.schemaVersion = 2;
          return value;
        },
      }])
    );

    await setup(root);
    const cleanBackup = `${root}/complete_graph.json`;
    await ok({ action: "snapshot", root, path: cleanBackup });
    const brokenRestore = await ok({ action: "export", root }) as DurableAuthorityEnvelope;
    delete brokenRestore.records[entityKey(ctx(), "connection", "connection")];
    delete brokenRestore.records[entityKey(ctx(), "custody", "custody_tenant_a_user")];
    equals(outcome(await ok({ action: "restore", root, transaction: brokenRestore })), "denied");
    await ok({
      action: "mutate",
      root,
      mutation: {
        path: `records.${entityKey(ctx(), "connection", "connection")}`,
        deletion: true,
      },
    });
    await ok({
      action: "mutate",
      root,
      mutation: {
        path: `records.${entityKey(ctx(), "custody", "custody_tenant_a_user")}`,
        deletion: true,
      },
    });
    equals(
      (await run({
        action: "reserve",
        root,
        owner: alice,
        transaction: binding("disconnected"),
      })).outcome,
      "denied",
    );
    await ok({ action: "replace", root, path: cleanBackup });
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
      transaction: await challenge(alice, "corrupt_challenge", "bootstrap"),
    });
    const backup = `${root}/clean.json`;
    await ok({ action: "snapshot", root, path: backup });
    const nested = [
      { path: `records.${entityKey(ctx(), "subject", "device")}.value.version`, value: "bad" },
      { path: `records.${entityKey(ctx(), "subject", "device")}.value.status`, value: "bad" },
      { path: `records.${replayKey(ctx(), "nonce", "corrupt")}.value.expiresAt`, value: -1 },
      {
        path: `records.${entityKey(ctx(), "challenge", "corrupt_challenge")}.value.purpose`,
        value: "bad",
      },
      { path: `records.${entityKey(ctx(), "attempt", "bad")}`, value: { state: "reserved" } },
      {
        path: `records.${entityKey(ctx(), "custody", "custody_tenant_a_user")}.value.owner`,
        value: "tenant/tenant_b/user/user",
      },
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
      publicJwk: FIXTURE_JWKS.agent,
      thumbprint: FIXTURE_THUMBPRINTS.agent,
      status: "active",
      epoch: 1,
    },
    device: {
      id: "device",
      tenantId: owner.tenantId,
      userId: owner.userId,
      agentId: "agent",
      publicJwk: FIXTURE_JWKS.admin,
      thumbprint: FIXTURE_THUMBPRINTS.admin,
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
      candidateJwk: FIXTURE_JWKS.candidate,
      thumbprint: FIXTURE_THUMBPRINTS.candidate,
      status: "pending",
      expiresAt: 400,
    },
    principalEpoch: 1,
    agentEpoch: 1,
    agentThumbprint: FIXTURE_THUMBPRINTS.agent,
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
      publicJwk: FIXTURE_JWKS.candidate,
      thumbprint: FIXTURE_THUMBPRINTS.candidate,
      role: "member",
      status: "active",
      epoch: 1,
    },
    principalEpoch: 1,
    agentEpoch: 1,
    agentThumbprint: FIXTURE_THUMBPRINTS.agent,
    approverId: "device",
    approverEpoch: 1,
    approverThumbprint: FIXTURE_THUMBPRINTS.admin,
  };
}
function removalValue() {
  return {
    agentId: "agent",
    agentEpoch: 1,
    agentThumbprint: FIXTURE_THUMBPRINTS.agent,
    approverId: "device",
    approverEpoch: 1,
    approverThumbprint: FIXTURE_THUMBPRINTS.admin,
    targetId: "candidate",
    targetEpoch: 1,
    targetThumbprint: FIXTURE_THUMBPRINTS.candidate,
    targetRole: "member",
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

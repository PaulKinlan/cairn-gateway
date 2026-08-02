import type {
  AtomicAuthorityResult,
  AttemptFinalization,
  AuthorityMaintenanceAuthorization,
  AuthorityMaintenanceContext,
  AuthorityMaintenancePurpose,
  AuthorityMaintenanceResult,
  AuthorityTransition,
  ChallengeCreationTransaction,
  ChallengeTransaction,
  DispatchClaimTransaction,
  DispatchPermitClaim,
  DispatchRecoveryTransaction,
  DispatchStartResult,
  DispatchStartTransaction,
  DurableAuthorityMaintenance,
  DurableAuthorityTransactions,
  DurableDispatchPermit,
  GlobalAuthorityMaintenanceAuthorization,
  InvocationReservation,
  InvocationReservationTransaction,
  MigrationPreparation,
  ReplayTransaction,
} from "../../../packages/core/src/store/authority_transaction.ts";
import type {
  Agent,
  Device,
  EnrollmentRequest,
  Grant,
  Principal,
  TenantContext,
} from "../../../packages/core/src/domain/types.ts";
import { ids } from "../../../packages/core/src/domain/types.ts";
import { jwkThumbprint } from "../../../packages/core/src/crypto/thumbprint.ts";
import { transactionHash } from "../../../packages/core/src/identity/transactions.ts";
import { entityKey, replayKey } from "../../../packages/core/src/store/keys.ts";
import {
  assertRestoreNotStale,
  assertTenantRestoreNotStale,
} from "../../../packages/core/src/store/migrations.ts";
import {
  assertAuthorityCryptography,
  assertAuthorityEnvelope,
  DURABLE_AUTHORITY_MIN_SCHEMA_VERSION,
  DURABLE_AUTHORITY_SCHEMA_VERSION,
  type DurableAuthorityEnvelope,
  type DurableRecord,
  frozenDurableSnapshot,
  hashDispatchPermit,
  sameDurableValue,
  serializeDurableAuthority,
  snapshotDurableInput,
} from "../../../packages/core/src/store/schema.ts";
import {
  authorityArrayIsArray,
  authorityJsonParse,
  authorityJsonStringify,
  authorityNumberIsSafeInteger,
  authorityObjectAssign,
  authorityObjectCreate,
  authorityObjectEntries,
  authorityObjectFreeze,
  authorityObjectGetPrototypeOf,
  authorityObjectIs,
  authorityObjectKeys,
  authorityObjectPrototype,
  authorityObjectValues,
  authorityStructuredClone,
  authorityWeakMapGet,
  authorityWeakMapHas,
  authorityWeakMapSet,
} from "../../../packages/core/src/store/intrinsics.ts";
import { FIXTURE_JWKS, FIXTURE_THUMBPRINTS, type Owner } from "./candidate_fixture_data.ts";

/** Test machinery only: process contention and logical commits, never power-loss/fsync evidence. */
export type FaultPoint = "abrupt_before_commit" | "abrupt_after_commit";
type Status = "active" | "disabled" | "revoked";
type ConnectionMetadata = {
  id: string;
  tenantId: string;
  userId: string;
  provider: "github";
  adapter: "fixture";
  custodyReferenceHash: string;
  status: Status;
  epoch: number;
};
type SubjectMetadata = Principal | Agent | Device | Grant | ConnectionMetadata;
type SubjectValue = {
  kind: "principal" | "agent" | "device" | "grant" | "connection";
  id: string;
  status: Status;
  version: number;
  identity: SubjectMetadata;
};
type ReplayValue = { kind: "nonce" | "jti"; hash: string; expiresAt: number; generation: number };
type AttemptValue = {
  attemptId: string;
  state: "reserved" | "dispatching" | "completed" | "failed_safe" | "dispatch_unknown";
  binding: InvocationReservationTransaction;
  replayKeys: string[];
  claimVersion: number;
  permitHash: string | null;
  permitAuthorityGeneration: number | null;
  dispatchStarted: boolean;
  dispatchStarts: number;
  result: unknown;
};
type ChallengeValue = ChallengeCreationTransaction["challenge"];
type EnrollmentValue = {
  request: EnrollmentRequest;
  approvedDeviceId: string | null;
};
type StoredMaintenanceAuthorization =
  | {
    scope: "tenant";
    tenant: TenantContext;
    actorId: string;
    purpose: AuthorityMaintenancePurpose;
  }
  | {
    scope: "authority";
    actorId: string;
    purpose: AuthorityMaintenancePurpose;
  };

const safe = (value: unknown, minimum = 0): value is number =>
  typeof value === "number" && authorityNumberIsSafeInteger(value) &&
  !authorityObjectIs(value, -0) &&
  value >= minimum;
const plain = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !authorityArrayIsArray(value) &&
  (authorityObjectGetPrototypeOf(value as object) === authorityObjectPrototype ||
    authorityObjectGetPrototypeOf(value as object) === null);
const clean = (value: unknown): string => {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new Error("identifier denied");
  }
  return value;
};
const context = (owner: Owner): TenantContext => ({
  tenantId: ids.tenant(clean(owner.tenantId)),
  userId: ids.user(clean(owner.userId)),
});
const ownerPrefix = (ctx: TenantContext): string => `tenant/${ctx.tenantId}/user/${ctx.userId}`;
const key = (ctx: TenantContext, kind: string, id: string): string =>
  entityKey(ctx, kind, clean(id));
const subjectKey = (ctx: TenantContext, id: string): string => key(ctx, "subject", id);
/** Pristine envelope shared with candidate adapters that reuse this transaction core. */
export const emptyEnvelope = (): DurableAuthorityEnvelope => ({
  schemaVersion: 2,
  authorityGeneration: 1,
  effectiveNow: 0,
  highWatermarks: {
    authorityGeneration: 1,
    migrationGeneration: 0,
    replayGeneration: 0,
    revocationGeneration: 0,
    schemaVersion: 2,
  },
  migration: { status: "idle", generation: 0, fromVersion: 2, toVersion: 2 },
  records: {},
});
const denied = (reason: string): AtomicAuthorityResult => ({ outcome: "denied", reason });
const maintenanceDenied = (reason: string): AuthorityMaintenanceResult => ({
  outcome: "denied",
  reason,
});
const supportedMigration = (fromVersion: number, toVersion: number): boolean =>
  fromVersion === DURABLE_AUTHORITY_MIN_SCHEMA_VERSION &&
  toVersion === DURABLE_AUTHORITY_SCHEMA_VERSION;
function nextVersion(state: DurableAuthorityEnvelope): number {
  return Math.max(
    0,
    ...authorityObjectValues(state.records).map((record) => record.recordVersion),
  ) + 1;
}
function beginCommit(state: DurableAuthorityEnvelope): void {
  state.authorityGeneration++;
  state.highWatermarks.authorityGeneration = state.authorityGeneration;
}
function put(
  state: DurableAuthorityEnvelope,
  ctx: TenantContext,
  recordKey: string,
  value: unknown,
): number {
  const recordVersion = nextVersion(state);
  state.records[recordKey] = {
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    recordVersion,
    authorityGeneration: state.authorityGeneration,
    value: authorityStructuredClone(value),
  };
  return recordVersion;
}
function effective(state: DurableAuthorityEnvelope, now: number): number {
  if (!safe(now)) throw new Error("time denied");
  state.effectiveNow = Math.max(state.effectiveNow, now);
  return state.effectiveNow;
}
function record<T>(
  state: DurableAuthorityEnvelope,
  recordKey: string,
): DurableRecord<T> | undefined {
  return state.records[recordKey] as DurableRecord<T> | undefined;
}
function subject(
  state: DurableAuthorityEnvelope,
  ctx: TenantContext,
  id: string,
): DurableRecord<SubjectValue> | undefined {
  return record<SubjectValue>(state, subjectKey(ctx, id));
}
function identityThumbprint(value: SubjectValue | undefined): string | undefined {
  return value?.identity && "thumbprint" in value.identity ? value.identity.thumbprint : undefined;
}
function subjectActive(
  value: SubjectValue | undefined,
  kind: SubjectValue["kind"],
  version: number,
): boolean {
  return Boolean(
    value && value.kind === kind && value.status === "active" && value.version === version,
  );
}
function makeSubject(
  kind: SubjectValue["kind"],
  id: string,
  status: Status,
  version: number,
  identity: SubjectValue["identity"],
): SubjectValue {
  return { kind, id, status, version, identity };
}
function defaultIdentities(owner: Owner): { principal: Principal; agent: Agent; device: Device } {
  return {
    principal: {
      id: ids.user(owner.userId),
      tenantId: ids.tenant(owner.tenantId),
      kind: "cryptographic",
      status: "active",
      emailRequired: false,
      epoch: 1,
    },
    agent: {
      id: ids.agent("agent"),
      tenantId: ids.tenant(owner.tenantId),
      userId: ids.user(owner.userId),
      publicJwk: FIXTURE_JWKS.agent,
      thumbprint: FIXTURE_THUMBPRINTS.agent,
      status: "active",
      epoch: 1,
    },
    device: {
      id: ids.device("device"),
      tenantId: ids.tenant(owner.tenantId),
      userId: ids.user(owner.userId),
      agentId: ids.agent("agent"),
      publicJwk: FIXTURE_JWKS.admin,
      thumbprint: FIXTURE_THUMBPRINTS.admin,
      role: "admin",
      status: "active",
      epoch: 1,
    },
  };
}
function validBinding(
  state: DurableAuthorityEnvelope,
  ctx: TenantContext,
  tx: InvocationReservationTransaction,
  now: number,
): boolean {
  const principal = subject(state, ctx, tx.principalId)?.value;
  const agent = subject(state, ctx, tx.agentId)?.value;
  const device = subject(state, ctx, tx.deviceId)?.value;
  const grant = subject(state, ctx, tx.grantId)?.value;
  const connection = subject(state, ctx, tx.connectionId)?.value;
  const deviceMetadata = device?.identity as Device | undefined;
  const grantMetadata = grant?.identity as Grant | undefined;
  const connectionMetadata = connection?.identity as ConnectionMetadata | undefined;
  const connectionRecord = record<Record<string, unknown>>(
    state,
    key(ctx, "connection", tx.connectionId),
  )?.value;
  const custodyRecord = connectionMetadata
    ? record<Record<string, unknown>>(
      state,
      key(ctx, "custody", connectionMetadata.custodyReferenceHash),
    )?.value
    : undefined;
  const owner = ownerPrefix(ctx);
  const completeLinkage = connectionRecord?.id === tx.connectionId &&
    connectionRecord.custodyReferenceHash === connectionMetadata?.custodyReferenceHash &&
    connectionRecord.owner === owner && connectionRecord.agentId === tx.agentId &&
    connectionRecord.deviceId === tx.deviceId && connectionRecord.workload === tx.operation &&
    custodyRecord?.custodyReferenceHash === connectionMetadata?.custodyReferenceHash &&
    custodyRecord?.owner === owner && custodyRecord?.connectionId === tx.connectionId &&
    custodyRecord?.agentId === tx.agentId && custodyRecord?.deviceId === tx.deviceId &&
    custodyRecord?.workload === tx.operation;
  return tx.operation === "github.user.read" && completeLinkage &&
    subjectActive(principal, "principal", tx.principalEpoch) &&
    subjectActive(agent, "agent", tx.agentEpoch) &&
    subjectActive(device, "device", tx.deviceEpoch) &&
    subjectActive(grant, "grant", tx.grantVersion) &&
    subjectActive(connection, "connection", tx.connectionEpoch) &&
    deviceMetadata?.agentId === tx.agentId &&
    grantMetadata?.agentId === tx.agentId && grantMetadata.deviceId === tx.deviceId &&
    grantMetadata.connectionId === tx.connectionId && grantMetadata.operation === tx.operation &&
    grantMetadata.expiresAt > now && connectionMetadata?.provider === "github" &&
    connectionMetadata.adapter === "fixture";
}
function ownerRecords(
  state: DurableAuthorityEnvelope,
  ctx: TenantContext,
  kind?: string,
): Array<[string, DurableRecord]> {
  const prefix = `${ownerPrefix(ctx)}/${kind ? `${kind}/` : ""}`;
  return authorityObjectEntries(state.records).filter(([recordKey]) =>
    recordKey.startsWith(prefix)
  );
}

export class OfflineReferenceAuthority
  implements DurableAuthorityTransactions, DurableAuthorityMaintenance {
  readonly statePath: string;
  readonly lockPath: string;
  private readonly maintenanceContexts = new WeakMap<object, StoredMaintenanceAuthorization>();
  constructor(readonly root: string, protected readonly injectedFault?: FaultPoint) {
    this.statePath = `${root}/authority.json`;
    this.lockPath = `${root}/authority.lock`;
  }

  /** Test-only tenant issuer kept behind the fixture driver, never on the maintenance interface. */
  issueMaintenanceContext(
    input: AuthorityMaintenanceAuthorization,
  ): AuthorityMaintenanceContext {
    const value = snapshotDurableInput(input);
    const tenant = context(value.tenant);
    const purposes: readonly AuthorityMaintenancePurpose[] = ["export", "inspect", "restore"];
    clean(value.actorId);
    if (!purposes.includes(value.purpose)) throw new Error("maintenance purpose denied");
    return this.issueCapability({
      scope: "tenant",
      tenant,
      actorId: value.actorId,
      purpose: value.purpose,
    });
  }

  /** Test-only schema-wide issuer is deliberately separate from the tenant issuer. */
  issueAuthorityMaintenanceContext(
    input: GlobalAuthorityMaintenanceAuthorization,
  ): AuthorityMaintenanceContext {
    const value = snapshotDurableInput(input);
    const purposes: readonly AuthorityMaintenancePurpose[] = [
      "export",
      "inspect",
      "initialize",
      "restore",
      "prepare_migration",
      "advance_migration",
      "fail_migration",
      "recover_migration",
    ];
    clean(value.actorId);
    if (!purposes.includes(value.purpose)) throw new Error("maintenance purpose denied");
    return this.issueCapability({
      scope: "authority",
      actorId: value.actorId,
      purpose: value.purpose,
    });
  }

  private issueCapability(
    authorization: StoredMaintenanceAuthorization,
  ): AuthorityMaintenanceContext {
    const capability = authorityObjectFreeze(
      authorityObjectCreate<Record<string, unknown>>(null),
    ) as unknown as AuthorityMaintenanceContext;
    authorityWeakMapSet(
      this.maintenanceContexts,
      capability,
      authorityObjectFreeze(authorization) as StoredMaintenanceAuthorization,
    );
    return capability;
  }

  private privileged(
    input: AuthorityMaintenanceContext,
    purpose: AuthorityMaintenancePurpose,
  ): StoredMaintenanceAuthorization {
    if (!input || typeof input !== "object") throw new Error("maintenance privilege denied");
    if (!authorityWeakMapHas(this.maintenanceContexts, input as object)) {
      throw new Error("maintenance privilege denied");
    }
    const authorization = authorityWeakMapGet(this.maintenanceContexts, input as object);
    if (!authorization || authorization.purpose !== purpose) {
      throw new Error("maintenance privilege denied");
    }
    clean(authorization.actorId);
    if (authorization.scope === "tenant") context(authorization.tenant);
    return authorization;
  }

  private globalPrivilege(
    input: AuthorityMaintenanceContext,
    purpose: AuthorityMaintenancePurpose,
  ): Extract<StoredMaintenanceAuthorization, { scope: "authority" }> {
    const authorization = this.privileged(input, purpose);
    if (authorization.scope !== "authority") throw new Error("global maintenance privilege denied");
    return authorization;
  }

  private assertTenantOwnership(
    state: DurableAuthorityEnvelope,
    authorization: Extract<StoredMaintenanceAuthorization, { scope: "tenant" }>,
  ): void {
    for (const item of authorityObjectValues(state.records)) {
      if (
        item.tenantId !== authorization.tenant.tenantId ||
        item.userId !== authorization.tenant.userId
      ) throw new Error("maintenance tenant ownership denied");
    }
  }

  private scopedEnvelope(
    state: DurableAuthorityEnvelope,
    authorization: StoredMaintenanceAuthorization,
  ): DurableAuthorityEnvelope {
    if (authorization.scope === "authority") return state;
    const scoped = authorityStructuredClone(state);
    scoped.records = {};
    for (const [recordKey, item] of ownerRecords(state, authorization.tenant)) {
      scoped.records[recordKey] = item;
    }
    assertAuthorityEnvelope(scoped, false);
    return scoped;
  }

  async initialize(): Promise<void> {
    await Deno.mkdir(this.root, { recursive: true });
    try {
      await Deno.writeFile(this.statePath, serializeDurableAuthority(emptyEnvelope()), {
        createNew: true,
      });
    } catch (error) {
      if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
    }
  }
  async read(requireCurrent = true): Promise<DurableAuthorityEnvelope> {
    let value: unknown;
    try {
      value = authorityJsonParse(await Deno.readTextFile(this.statePath));
    } catch {
      throw new Error("record denied");
    }
    assertAuthorityEnvelope(value, requireCurrent);
    await assertAuthorityCryptography(value);
    return value;
  }
  private async write(state: DurableAuthorityEnvelope, fault?: FaultPoint): Promise<void> {
    const temporary = `${this.statePath}.${Deno.pid}.${crypto.randomUUID()}.tmp`;
    await Deno.writeFile(temporary, serializeDurableAuthority(state), { createNew: true });
    if (fault === "abrupt_before_commit") Deno.exit(75);
    await Deno.rename(temporary, this.statePath);
    if (fault === "abrupt_after_commit") Deno.exit(75);
  }
  // Protected (not private) so candidate adapters that swap the persistence core (e.g. Deno KV)
  // keep the identical shared crash-recovery lock protocol: the complete owner record exists
  // before one atomic hard-link acquisition, and dead-owner recovery is bounded.
  protected async acquireLock(): Promise<void> {
    for (let attempt = 0;; attempt++) {
      const claimant = `${this.lockPath}.${Deno.pid}.${crypto.randomUUID()}.claim`;
      try {
        // The complete owner record exists before one atomic hard-link acquisition. A crash before
        // link leaves no lock; a crash after link leaves recoverable owner metadata at lockPath.
        await Deno.writeTextFile(
          claimant,
          authorityJsonStringify({ pid: Deno.pid, acquiredAt: Date.now() }),
          { createNew: true },
        );
        await Deno.link(claimant, this.lockPath);
        await Deno.remove(claimant);
        break;
      } catch (error) {
        await Deno.remove(claimant).catch(() => undefined);
        if (!(error instanceof Deno.errors.AlreadyExists) || attempt >= 5000) throw error;
        try {
          const lockOwner = authorityJsonParse(
            await Deno.readTextFile(this.lockPath),
          ) as { pid?: unknown; acquiredAt?: unknown };
          if (!safe(lockOwner.pid, 1) || !safe(lockOwner.acquiredAt)) {
            throw new Error("lock owner metadata denied");
          }
          const alive = await new Deno.Command("kill", {
            args: ["-0", String(lockOwner.pid)],
            stdout: "null",
            stderr: "null",
          }).output();
          if (!alive.success) {
            await Deno.remove(this.lockPath);
            continue;
          }
        } catch (probeError) {
          if (!(probeError instanceof Deno.errors.NotFound)) throw probeError;
        }
        await new Promise((resolve) => setTimeout(resolve, 1 + attempt % 7));
      }
    }
  }
  protected async releaseLock(): Promise<void> {
    await Deno.remove(this.lockPath).catch(() => undefined);
  }
  // Protected (not private) so candidate adapters can swap the persistence core (e.g. Deno KV
  // versionstamp CAS) while reusing the identical transaction/maintenance operation logic.
  protected async locked<T>(
    operation: (state: DurableAuthorityEnvelope) => T | Promise<T>,
    requireCurrent = true,
    fault?: FaultPoint,
  ): Promise<T> {
    await this.initialize();
    await this.acquireLock();
    try {
      const state = await this.read(requireCurrent);
      const result = await operation(state);
      assertAuthorityEnvelope(state, requireCurrent);
      await this.write(state, fault ?? this.injectedFault);
      return result;
    } finally {
      await this.releaseLock();
    }
  }

  /** Concrete seed/view helpers exist only to arrange and display test fixtures. */
  async seed(ownerInput: Owner, custodyInput?: string): Promise<boolean> {
    const owner = snapshotDurableInput(ownerInput);
    const custodyRef = clean(custodyInput ?? `custody_${owner.tenantId}_${owner.userId}`);
    return await this.locked((state) => {
      const ctx = context(owner);
      if (
        ownerRecords(state, ctx).length ||
        authorityObjectValues(state.records).some((item) =>
          plain(item.value) && item.value.custodyReferenceHash === custodyRef
        )
      ) return false;
      beginCommit(state);
      const identities = defaultIdentities(owner);
      put(
        state,
        ctx,
        subjectKey(ctx, owner.userId),
        makeSubject("principal", owner.userId, "active", 1, identities.principal),
      );
      put(
        state,
        ctx,
        subjectKey(ctx, "agent"),
        makeSubject("agent", "agent", "active", 1, identities.agent),
      );
      put(
        state,
        ctx,
        subjectKey(ctx, "device"),
        makeSubject("device", "device", "active", 1, identities.device),
      );
      put(
        state,
        ctx,
        subjectKey(ctx, "grant"),
        makeSubject("grant", "grant", "active", 1, {
          id: "grant",
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          agentId: ids.agent("agent"),
          deviceId: ids.device("device"),
          connectionId: ids.connection("connection"),
          operation: "github.user.read",
          status: "active",
          version: 1,
          expiresAt: 1_000,
        }),
      );
      put(
        state,
        ctx,
        subjectKey(ctx, "connection"),
        makeSubject("connection", "connection", "active", 1, {
          id: "connection",
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          provider: "github",
          adapter: "fixture",
          custodyReferenceHash: clean(custodyRef),
          status: "active",
          epoch: 1,
        }),
      );
      put(state, ctx, key(ctx, "connection", "connection"), {
        id: "connection",
        custodyReferenceHash: clean(custodyRef),
        owner: ownerPrefix(ctx),
        agentId: "agent",
        deviceId: "device",
        workload: "github.user.read",
      });
      put(state, ctx, key(ctx, "custody", custodyRef), {
        custodyReferenceHash: clean(custodyRef),
        owner: ownerPrefix(ctx),
        connectionId: "connection",
        agentId: "agent",
        deviceId: "device",
        workload: "github.user.read",
      });
      return true;
    });
  }
  async inspect(ownerInput: Owner): Promise<Record<string, unknown>> {
    const owner = snapshotDurableInput(ownerInput);
    const state = await this.read();
    const ctx = context(owner);
    const all = ownerRecords(state, ctx);
    const subjects: Record<string, unknown> = {};
    const replay: Record<string, unknown> = {};
    const attempts: Record<string, unknown> = {};
    const challenges: Record<string, unknown> = {};
    const ceremonies: Record<string, unknown> = {};
    const enrollments: Record<string, unknown> = {};
    const connections: Record<string, unknown> = {};
    for (const [recordKey, item] of all) {
      const relative = recordKey.slice(ownerPrefix(ctx).length + 1);
      const [kind, ...rest] = relative.split("/");
      const id = rest.at(-1)!;
      if (kind === "subject") {
        const value = item.value as SubjectValue;
        if (
          !(value.kind in subjects) ||
          [ctx.userId, "agent", "device", "grant", "connection"].includes(value.id)
        ) {
          subjects[value.kind] = {
            id: value.id,
            status: value.status,
            version: value.version,
            recordVersion: item.recordVersion,
            identity: value.identity,
          };
        }
      } else if (kind === "replay") {
        const value = item.value as ReplayValue;
        replay[`${value.kind}/${value.hash}`] = { ...value, recordVersion: item.recordVersion };
      } else if (kind === "attempt") {
        const value = item.value as AttemptValue;
        attempts[id] = {
          ...value,
          dispatchPermitUsed: value.permitHash !== null,
          automaticRetry: false,
          recordVersion: item.recordVersion,
        };
      } else if (kind === "challenge") {
        challenges[id] = { ...(item.value as object), recordVersion: item.recordVersion };
      } else if (kind === "ceremony") {
        ceremonies[id] = {
          kind: (item.value as Record<string, unknown>).kind,
          recordVersion: item.recordVersion,
        };
      } else if (kind === "enrollment") {
        const request = (item.value as Record<string, Record<string, unknown>>).request;
        enrollments[id] = { ...request, recordVersion: item.recordVersion };
      } else if (kind === "connection") {
        connections[id] = { ...(item.value as object), recordVersion: item.recordVersion };
      }
    }
    return frozenDurableSnapshot({
      exists: all.length > 0,
      tenant: all.length
        ? {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          subjects,
          replay,
          attempts,
          challenges,
          ceremonies,
          enrollments,
          connections,
        }
        : null,
      schemaVersion: state.schemaVersion,
      migration: state.migration,
      authorityGeneration: state.authorityGeneration,
      highWatermarks: state.highWatermarks,
      effectiveNow: state.effectiveNow,
    });
  }

  async consumeReplay(ctx: TenantContext, tx: ReplayTransaction): Promise<AtomicAuthorityResult> {
    ctx = snapshotDurableInput(ctx);
    tx = snapshotDurableInput(tx);
    return await this.locked((state) => {
      const now = effective(state, tx.now);
      if (!ownerRecords(state, ctx).length || !tx.records.length || tx.expiresAt <= now) {
        return denied("replay denied");
      }
      const keys = tx.records.map((item) => replayKey(ctx, item.kind, clean(item.hash)));
      if (new Set(keys).size !== keys.length) return denied("duplicate replay key");
      for (const [recordKey, item] of ownerRecords(state, ctx, "replay")) {
        if ((item.value as ReplayValue).expiresAt < now) delete state.records[recordKey];
      }
      if (keys.some((recordKey) => state.records[recordKey])) return denied("already consumed");
      beginCommit(state);
      const generation = ++state.highWatermarks.replayGeneration;
      tx.records.forEach((item, index) =>
        put(
          state,
          ctx,
          keys[index]!,
          {
            kind: item.kind,
            hash: item.hash,
            expiresAt: tx.expiresAt,
            generation,
          } satisfies ReplayValue,
        )
      );
      return {
        outcome: "committed",
        authorityGeneration: state.authorityGeneration,
        recordVersion: nextVersion(state) - 1,
      };
    });
  }

  async reserveInvocation(
    ctx: TenantContext,
    tx: InvocationReservationTransaction,
  ): Promise<InvocationReservation> {
    ctx = snapshotDurableInput(ctx);
    tx = snapshotDurableInput(tx);
    return await this.locked(
      (state) => {
        const now = effective(state, tx.now);
        if (
          !validBinding(state, ctx, tx, now) || tx.nonceExpiresAt <= now || tx.jtiExpiresAt <= now
        ) {
          return { outcome: "denied", reason: "binding or expiry denied" };
        }
        const replayKeys = [
          replayKey(ctx, "nonce", tx.deviceNonceHash),
          replayKey(ctx, "nonce", tx.agentNonceHash),
          replayKey(ctx, "jti", tx.jtiHash),
        ];
        if (
          new Set(replayKeys).size !== 3 || state.records[key(ctx, "attempt", tx.attemptId)] ||
          replayKeys.some((item) => state.records[item])
        ) {
          return { outcome: "already_consumed" };
        }
        beginCommit(state);
        const generation = ++state.highWatermarks.replayGeneration;
        const values = [
          { kind: "nonce", hash: tx.deviceNonceHash, expiresAt: tx.nonceExpiresAt, generation },
          { kind: "nonce", hash: tx.agentNonceHash, expiresAt: tx.nonceExpiresAt, generation },
          { kind: "jti", hash: tx.jtiHash, expiresAt: tx.jtiExpiresAt, generation },
        ] satisfies ReplayValue[];
        replayKeys.forEach((item, index) => put(state, ctx, item, values[index]!));
        put(
          state,
          ctx,
          key(ctx, "attempt", tx.attemptId),
          {
            attemptId: tx.attemptId,
            state: "reserved",
            binding: authorityStructuredClone(tx),
            replayKeys,
            claimVersion: 0,
            permitHash: null,
            permitAuthorityGeneration: null,
            dispatchStarted: false,
            dispatchStarts: 0,
            result: null,
          } satisfies AttemptValue,
        );
        return {
          outcome: "reserved",
          attemptId: tx.attemptId,
          authorityGeneration: state.authorityGeneration,
        };
      },
    );
  }

  async claimDispatch(
    ctx: TenantContext,
    tx: DispatchClaimTransaction,
  ): Promise<DispatchPermitClaim> {
    ctx = snapshotDurableInput(ctx);
    tx = snapshotDurableInput(tx);
    return await this.locked(
      async (state) => {
        const now = effective(state, tx.now);
        const item = record<AttemptValue>(state, key(ctx, "attempt", tx.attemptId));
        if (!item) return { outcome: "denied", reason: "attempt absent" };
        if (
          tx.expectedState !== "reserved" || item.value.state !== "reserved" ||
          item.value.permitHash !== null
        ) return { outcome: "already_consumed" };
        if (
          item.value.binding.nonceExpiresAt <= now || item.value.binding.jtiExpiresAt <= now ||
          !validBinding(state, ctx, item.value.binding, now)
        ) return { outcome: "denied", reason: "reservation authority denied" };
        beginCommit(state);
        const permit: DurableDispatchPermit = {
          attemptId: tx.attemptId,
          claimVersion: 1,
          authorityGeneration: state.authorityGeneration,
          token: `p_${crypto.randomUUID().replaceAll("-", "")}`,
        };
        const value: AttemptValue = {
          ...item.value,
          state: "dispatching",
          claimVersion: 1,
          permitHash: await hashDispatchPermit(permit),
          permitAuthorityGeneration: permit.authorityGeneration,
        };
        put(state, ctx, key(ctx, "attempt", tx.attemptId), value);
        return { outcome: "permit", permit };
      },
    );
  }

  async startDispatch(
    ctx: TenantContext,
    tx: DispatchStartTransaction,
  ): Promise<DispatchStartResult> {
    ctx = snapshotDurableInput(ctx);
    tx = snapshotDurableInput(tx);
    return await this.locked(async (state) => {
      const now = effective(state, tx.now);
      const permit = tx.permit;
      const item = record<AttemptValue>(state, key(ctx, "attempt", clean(permit.attemptId)));
      if (!item || item.value.state !== "dispatching") {
        return { outcome: "denied", reason: "attempt state denied" };
      }
      if (item.value.dispatchStarted) return { outcome: "already_consumed" };
      if (
        item.value.binding.nonceExpiresAt <= now || item.value.binding.jtiExpiresAt <= now ||
        !validBinding(state, ctx, item.value.binding, now)
      ) return { outcome: "denied", reason: "dispatch authority denied" };
      if (
        permit.claimVersion !== item.value.claimVersion ||
        permit.authorityGeneration !== item.value.permitAuthorityGeneration ||
        await hashDispatchPermit(permit) !== item.value.permitHash
      ) return { outcome: "denied", reason: "dispatch permit denied" };
      beginCommit(state);
      put(state, ctx, key(ctx, "attempt", permit.attemptId), {
        ...item.value,
        dispatchStarted: true,
        dispatchStarts: 1,
      });
      return {
        outcome: "authorized",
        authorization: {
          attemptId: permit.attemptId,
          claimVersion: permit.claimVersion,
          authorityGeneration: permit.authorityGeneration,
        },
      };
    });
  }

  async finalizeAttempt(
    ctx: TenantContext,
    tx: AttemptFinalization,
  ): Promise<AtomicAuthorityResult> {
    ctx = snapshotDurableInput(ctx);
    tx = snapshotDurableInput(tx);
    return await this.locked(async (state) => {
      effective(state, tx.now);
      const item = record<AttemptValue>(state, key(ctx, "attempt", clean(tx.attemptId)));
      if (!item || item.value.state !== tx.expectedState || tx.result.outcome !== tx.nextState) {
        return denied("attempt state denied");
      }
      if (tx.expectedState === "dispatching") {
        if (
          tx.permit.attemptId !== tx.attemptId ||
          tx.permit.claimVersion !== item.value.claimVersion ||
          tx.permit.authorityGeneration !== item.value.permitAuthorityGeneration ||
          await hashDispatchPermit(tx.permit) !== item.value.permitHash ||
          (tx.nextState === "completed" && !item.value.dispatchStarted)
        ) return denied("dispatch permit denied");
      }
      beginCommit(state);
      const version = put(state, ctx, key(ctx, "attempt", tx.attemptId), {
        ...item.value,
        state: tx.nextState,
        result: authorityStructuredClone(tx.result),
      });
      return {
        outcome: "committed",
        authorityGeneration: state.authorityGeneration,
        recordVersion: version,
      };
    });
  }
  async recoverDispatch(
    ctx: TenantContext,
    tx: DispatchRecoveryTransaction,
  ): Promise<AtomicAuthorityResult> {
    ctx = snapshotDurableInput(ctx);
    tx = snapshotDurableInput(tx);
    return await this.locked((state) => {
      effective(state, tx.now);
      const item = record<AttemptValue>(state, key(ctx, "attempt", clean(tx.attemptId)));
      if (
        !item || tx.expectedState !== "dispatching" || tx.nextState !== "dispatch_unknown" ||
        item.value.state !== "dispatching"
      ) return denied("dispatch recovery denied");
      beginCommit(state);
      const version = put(state, ctx, key(ctx, "attempt", tx.attemptId), {
        ...item.value,
        state: "dispatch_unknown",
        result: { outcome: "dispatch_unknown" },
      });
      return {
        outcome: "committed",
        authorityGeneration: state.authorityGeneration,
        recordVersion: version,
      };
    });
  }

  async issueChallenge(
    ctx: TenantContext,
    tx: ChallengeCreationTransaction,
  ): Promise<AtomicAuthorityResult> {
    ctx = snapshotDurableInput(ctx);
    tx = snapshotDurableInput(tx);
    return await this.locked((state) => {
      const now = effective(state, tx.now);
      const challenge = tx.challenge;
      const challengeKey = key(ctx, "challenge", challenge.id);
      if (
        (challenge.purpose !== "bootstrap" && !ownerRecords(state, ctx).length) ||
        challenge.tenantId !== ctx.tenantId ||
        challenge.userId !== ctx.userId ||
        challenge.expiresAt <= now || challenge.used || tx.expectedAbsent !== true ||
        state.records[challengeKey]
      ) return denied("challenge issue denied");
      beginCommit(state);
      const version = put(state, ctx, challengeKey, challenge);
      return {
        outcome: "committed",
        authorityGeneration: state.authorityGeneration,
        recordVersion: version,
      };
    });
  }

  private async ceremonyValid(
    state: DurableAuthorityEnvelope,
    ctx: TenantContext,
    tx: ChallengeTransaction,
    now: number,
  ): Promise<boolean> {
    const mutation = tx.mutation;
    if (
      (tx.purpose === "bootstrap" && mutation.kind !== "bootstrap") ||
      (tx.purpose === "enroll_candidate" && mutation.kind !== "enrollment") ||
      (tx.purpose === "approve_enrollment" && mutation.kind !== "approval") ||
      (tx.purpose === "remove_device" && mutation.kind !== "removal")
    ) return false;
    const principal = subject(state, ctx, ctx.userId)?.value;
    if (mutation.kind === "bootstrap") {
      const { principal: p, agent: a, device: d } = mutation.value;
      return ownerRecords(state, ctx, "subject").length === 0 &&
        ownerRecords(state, ctx, "enrollment").length === 0 &&
        p.id === ctx.userId && p.tenantId === ctx.tenantId && p.kind === "cryptographic" &&
        p.emailRequired === false && p.status === "active" && p.epoch === 1 &&
        a.tenantId === ctx.tenantId && a.userId === ctx.userId && a.status === "active" &&
        a.epoch === 1 && clean(a.id) === a.id &&
        await jwkThumbprint(a.publicJwk) === a.thumbprint &&
        d.tenantId === ctx.tenantId && d.userId === ctx.userId && d.agentId === a.id &&
        d.status === "active" && d.role === "admin" && d.epoch === 1 && clean(d.id) === d.id &&
        await jwkThumbprint(d.publicJwk) === d.thumbprint && String(a.id) !== String(d.id) &&
        a.thumbprint !== d.thumbprint;
    }
    if (mutation.kind === "enrollment") {
      const value = mutation.value;
      const agent = subject(state, ctx, value.request.agentId)?.value;
      const request = value.request;
      const deviceThumbprints = ownerRecords(state, ctx, "subject").map(([, item]) =>
        identityThumbprint(item.value as SubjectValue)
      ).filter(Boolean);
      return subjectActive(principal, "principal", value.principalEpoch) &&
        subjectActive(agent, "agent", value.agentEpoch) &&
        identityThumbprint(agent) === value.agentThumbprint &&
        await jwkThumbprint(request.candidateJwk) === request.thumbprint &&
        request.tenantId === ctx.tenantId &&
        request.userId === ctx.userId && request.agentId === agent!.id &&
        request.status === "pending" && safe(request.expiresAt, 1) && request.expiresAt > now &&
        request.expiresAt - now <= 600 &&
        clean(request.id) === request.id && clean(request.thumbprint) === request.thumbprint &&
        request.thumbprint !== value.agentThumbprint &&
        !deviceThumbprints.includes(request.thumbprint) &&
        !state.records[key(ctx, "enrollment", request.id)];
    }
    if (mutation.kind === "approval") {
      const value = mutation.value;
      const agent = subject(state, ctx, value.device.agentId)?.value;
      const enrollment = record<{ request: Record<string, unknown> }>(
        state,
        key(ctx, "enrollment", value.requestId),
      )?.value.request;
      const approver = subject(state, ctx, value.approverId)?.value;
      const device = value.device;
      return subjectActive(principal, "principal", value.principalEpoch) &&
        subjectActive(agent, "agent", value.agentEpoch) &&
        identityThumbprint(agent) === value.agentThumbprint &&
        subjectActive(approver, "device", value.approverEpoch) &&
        identityThumbprint(approver) === value.approverThumbprint &&
        (approver!.identity as Device).role === "admin" &&
        (approver!.identity as Device).agentId === agent!.id &&
        Boolean(enrollment) && enrollment!.status === "pending" && safe(enrollment!.expiresAt, 1) &&
        Number(enrollment!.expiresAt) > now &&
        enrollment!.agentId === agent!.id && enrollment!.id === value.requestId &&
        enrollment!.thumbprint === device.thumbprint &&
        await jwkThumbprint(device.publicJwk) === device.thumbprint &&
        sameDurableValue(enrollment!.candidateJwk, device.publicJwk) &&
        device.id !== value.approverId && device.tenantId === ctx.tenantId &&
        device.userId === ctx.userId && device.agentId === agent!.id &&
        device.status === "active" && device.role === "member" && device.epoch === 1 &&
        device.thumbprint !== value.agentThumbprint &&
        device.thumbprint !== value.approverThumbprint && !subject(state, ctx, device.id);
    }
    const value = mutation.value;
    const removalAgent = subject(state, ctx, value.agentId)?.value;
    const approver = subject(state, ctx, value.approverId)?.value;
    const target = subject(state, ctx, value.targetId)?.value;
    return subjectActive(principal, "principal", principal?.version ?? 0) &&
      subjectActive(removalAgent, "agent", value.agentEpoch) &&
      identityThumbprint(removalAgent) === value.agentThumbprint &&
      subjectActive(approver, "device", value.approverEpoch) &&
      identityThumbprint(approver) === value.approverThumbprint &&
      (approver!.identity as Device).role === "admin" &&
      (approver!.identity as Device).agentId === removalAgent!.id &&
      subjectActive(target, "device", value.targetEpoch) &&
      identityThumbprint(target) === value.targetThumbprint &&
      (target!.identity as Device).agentId === removalAgent!.id &&
      (target!.identity as Device).role === value.targetRole && target!.id !== approver!.id;
  }

  async commitChallenge(
    ctx: TenantContext,
    tx: ChallengeTransaction,
  ): Promise<AtomicAuthorityResult> {
    ctx = snapshotDurableInput(ctx);
    tx = snapshotDurableInput(tx);
    const mutationHash = await transactionHash(tx.mutation);
    return await this.locked(async (state) => {
      const now = effective(state, tx.now);
      const challengeKey = key(ctx, "challenge", tx.challengeId);
      const challenge = record<ChallengeValue>(state, challengeKey);
      if (
        !challenge || challenge.value.used || challenge.value.expiresAt <= now ||
        challenge.value.transactionHash !== mutationHash ||
        challenge.value.purpose !== tx.purpose || !await this.ceremonyValid(state, ctx, tx, now)
      ) return denied("challenge commit denied");
      beginCommit(state);
      if (tx.mutation.kind === "bootstrap") {
        const value = tx.mutation.value;
        put(
          state,
          ctx,
          subjectKey(ctx, value.principal.id),
          makeSubject(
            "principal",
            value.principal.id,
            value.principal.status,
            value.principal.epoch,
            value.principal,
          ),
        );
        put(
          state,
          ctx,
          subjectKey(ctx, value.agent.id),
          makeSubject("agent", value.agent.id, value.agent.status, value.agent.epoch, value.agent),
        );
        put(
          state,
          ctx,
          subjectKey(ctx, value.device.id),
          makeSubject(
            "device",
            value.device.id,
            value.device.status,
            value.device.epoch,
            value.device,
          ),
        );
      } else if (tx.mutation.kind === "enrollment") {
        put(
          state,
          ctx,
          key(ctx, "enrollment", tx.mutation.value.request.id),
          {
            request: tx.mutation.value.request,
            approvedDeviceId: null,
          } satisfies EnrollmentValue,
        );
      } else if (tx.mutation.kind === "approval") {
        const value = tx.mutation.value;
        const enrollmentKey = key(ctx, "enrollment", value.requestId);
        const stored = record<EnrollmentValue>(state, enrollmentKey)!;
        put(
          state,
          ctx,
          enrollmentKey,
          {
            request: { ...stored.value.request, status: "approved" },
            approvedDeviceId: value.device.id,
          } satisfies EnrollmentValue,
        );
        put(
          state,
          ctx,
          subjectKey(ctx, value.device.id),
          makeSubject(
            "device",
            value.device.id,
            value.device.status,
            value.device.epoch,
            value.device,
          ),
        );
      } else {
        const value = tx.mutation.value;
        const targetKey = subjectKey(ctx, value.targetId);
        const target = record<SubjectValue>(state, targetKey)!;
        const identity = {
          ...(target.value.identity as Device),
          status: "revoked",
          epoch: target.value.version + 1,
        };
        put(state, ctx, targetKey, {
          ...target.value,
          status: "revoked",
          version: target.value.version + 1,
          identity,
        });
        state.highWatermarks.revocationGeneration++;
      }
      put(state, ctx, challengeKey, { ...challenge.value, used: true });
      const version = put(state, ctx, key(ctx, "ceremony", tx.challengeId), {
        challengeId: tx.challengeId,
        kind: tx.mutation.kind,
      });
      return {
        outcome: "committed",
        authorityGeneration: state.authorityGeneration,
        recordVersion: version,
      };
    });
  }

  async transitionAuthority(
    ctx: TenantContext,
    tx: AuthorityTransition,
  ): Promise<AtomicAuthorityResult> {
    ctx = snapshotDurableInput(ctx);
    tx = snapshotDurableInput(tx);
    return await this.locked((state) => {
      effective(state, tx.now);
      const recordKey = subjectKey(ctx, tx.subjectId);
      const item = record<SubjectValue>(state, recordKey);
      if (
        !item || item.value.kind !== tx.subjectType || item.value.version !== tx.expectedVersion ||
        tx.nextVersion !== tx.expectedVersion + 1
      ) return denied("authority transition denied");
      beginCommit(state);
      const identity = {
        ...item.value.identity,
        status: tx.nextStatus,
        ...(item.value.kind === "grant" ? { version: tx.nextVersion } : { epoch: tx.nextVersion }),
      } as SubjectValue["identity"];
      const version = put(state, ctx, recordKey, {
        ...item.value,
        status: tx.nextStatus,
        version: tx.nextVersion,
        identity,
      });
      if (tx.nextStatus === "revoked") state.highWatermarks.revocationGeneration++;
      return {
        outcome: "committed",
        authorityGeneration: state.authorityGeneration,
        recordVersion: version,
      };
    });
  }

  async exportAuthority(ctx: AuthorityMaintenanceContext): Promise<DurableAuthorityEnvelope> {
    const authorization = this.privileged(ctx, "export");
    const state = await this.read(false);
    return frozenDurableSnapshot(this.scopedEnvelope(state, authorization));
  }
  async inspectAuthority(
    ctx: AuthorityMaintenanceContext,
    requireCurrent = true,
  ): Promise<DurableAuthorityEnvelope> {
    const authorization = this.privileged(ctx, "inspect");
    const state = await this.read(requireCurrent);
    return frozenDurableSnapshot(this.scopedEnvelope(state, authorization));
  }
  async initializeAuthority(
    ctx: AuthorityMaintenanceContext,
    candidate: DurableAuthorityEnvelope,
  ): Promise<AuthorityMaintenanceResult> {
    this.globalPrivilege(ctx, "initialize");
    candidate = snapshotDurableInput(candidate);
    return await this.locked(async (current) => {
      if (
        authorityObjectKeys(current.records).length || current.authorityGeneration !== 1 ||
        current.effectiveNow !== 0
      ) {
        return maintenanceDenied("authority store is not pristine");
      }
      try {
        assertAuthorityEnvelope(candidate, false);
        await assertAuthorityCryptography(candidate);
      } catch {
        return maintenanceDenied("authority import denied");
      }
      for (const item of authorityObjectKeys(current)) {
        delete (current as unknown as Record<string, unknown>)[item];
      }
      authorityObjectAssign(current, authorityStructuredClone(candidate));
      return { outcome: "committed", authorityGeneration: current.authorityGeneration };
    }, false);
  }
  async restoreAuthority(
    ctx: AuthorityMaintenanceContext,
    candidate: DurableAuthorityEnvelope,
  ): Promise<AuthorityMaintenanceResult> {
    const authorization = this.privileged(ctx, "restore");
    candidate = snapshotDurableInput(candidate);
    return await this.locked(async (current) => {
      try {
        if (authorization.scope === "tenant") {
          this.assertTenantOwnership(candidate, authorization);
          assertTenantRestoreNotStale(
            candidate,
            current,
            authorization.tenant.tenantId,
            authorization.tenant.userId,
          );
        } else {
          assertRestoreNotStale(candidate, current);
        }
        await assertAuthorityCryptography(candidate);
      } catch {
        return maintenanceDenied("stale or corrupt restore denied");
      }
      if (authorization.scope === "tenant") {
        const prefix = `${ownerPrefix(authorization.tenant)}/`;
        for (const recordKey of authorityObjectKeys(current.records)) {
          if (recordKey.startsWith(prefix)) delete current.records[recordKey];
        }
        for (const [recordKey, item] of authorityObjectEntries(candidate.records)) {
          current.records[recordKey] = authorityStructuredClone(item);
        }
        beginCommit(current);
      } else {
        for (const item of authorityObjectKeys(current)) {
          delete (current as unknown as Record<string, unknown>)[item];
        }
        authorityObjectAssign(current, authorityStructuredClone(candidate));
      }
      return { outcome: "committed", authorityGeneration: current.authorityGeneration };
    });
  }
  async prepareMigration(
    ctx: AuthorityMaintenanceContext,
    tx: MigrationPreparation,
  ): Promise<AuthorityMaintenanceResult> {
    this.globalPrivilege(ctx, "prepare_migration");
    tx = snapshotDurableInput(tx);
    return await this.locked((state) => {
      if (
        state.schemaVersion !== tx.expectedSchemaVersion || state.migration.status !== "idle" ||
        tx.targetSchemaVersion !== tx.expectedSchemaVersion + 1 ||
        !supportedMigration(tx.expectedSchemaVersion, tx.targetSchemaVersion)
      ) return maintenanceDenied("migration preparation denied");
      beginCommit(state);
      state.migration = {
        status: "preparing",
        generation: state.migration.generation + 1,
        fromVersion: tx.expectedSchemaVersion,
        toVersion: tx.targetSchemaVersion,
      };
      state.highWatermarks.migrationGeneration = state.migration.generation;
      return { outcome: "committed", authorityGeneration: state.authorityGeneration };
    }, false);
  }
  async advanceMigration(ctx: AuthorityMaintenanceContext): Promise<AuthorityMaintenanceResult> {
    this.globalPrivilege(ctx, "advance_migration");
    return await this.locked((state) => {
      if (
        !supportedMigration(state.migration.fromVersion, state.migration.toVersion)
      ) return maintenanceDenied("migration advance denied");
      if (state.migration.status === "preparing") {
        beginCommit(state);
        state.migration.status = "committing";
      } else if (state.migration.status === "committing") {
        beginCommit(state);
        state.schemaVersion = state.migration.toVersion;
        state.highWatermarks.schemaVersion = state.schemaVersion;
        state.migration.status = "idle";
      } else return maintenanceDenied("migration advance denied");
      return { outcome: "committed", authorityGeneration: state.authorityGeneration };
    }, false);
  }
  async failMigration(ctx: AuthorityMaintenanceContext): Promise<AuthorityMaintenanceResult> {
    this.globalPrivilege(ctx, "fail_migration");
    return await this.locked((state) => {
      if (!["preparing", "committing"].includes(state.migration.status)) {
        return maintenanceDenied("migration failure mark denied");
      }
      beginCommit(state);
      state.migration.status = "failed";
      return { outcome: "committed", authorityGeneration: state.authorityGeneration };
    }, false);
  }
  async recoverMigration(ctx: AuthorityMaintenanceContext): Promise<AuthorityMaintenanceResult> {
    this.globalPrivilege(ctx, "recover_migration");
    for (;;) {
      const result = await this.locked((state) => {
        if (
          state.schemaVersion === DURABLE_AUTHORITY_SCHEMA_VERSION &&
          state.migration.status === "idle"
        ) {
          return { done: true, authorityGeneration: state.authorityGeneration };
        }
        beginCommit(state);
        if (
          state.migration.status !== "idle" &&
          !supportedMigration(state.migration.fromVersion, state.migration.toVersion)
        ) {
          state.migration = {
            status: "idle",
            generation: state.migration.generation,
            fromVersion: state.schemaVersion,
            toVersion: state.schemaVersion,
          };
        } else if (state.migration.status === "failed") {
          state.migration.status = "preparing";
        } else if (state.migration.status === "idle") {
          if (
            !supportedMigration(state.schemaVersion, DURABLE_AUTHORITY_SCHEMA_VERSION)
          ) throw new Error("authority migration unavailable");
          state.migration = {
            status: "preparing",
            generation: state.migration.generation + 1,
            fromVersion: state.schemaVersion,
            toVersion: DURABLE_AUTHORITY_SCHEMA_VERSION,
          };
          state.highWatermarks.migrationGeneration = state.migration.generation;
        } else if (state.migration.status === "preparing") {
          state.migration.status = "committing";
        } else {
          state.schemaVersion = state.migration.toVersion;
          state.highWatermarks.schemaVersion = state.schemaVersion;
          state.migration.status = "idle";
        }
        return { done: false, authorityGeneration: state.authorityGeneration };
      }, false);
      if (result.done) {
        return { outcome: "committed", authorityGeneration: result.authorityGeneration };
      }
    }
  }

  /** Test-only preparation of an old neutral envelope; migration itself uses the neutral contract. */
  async writeLegacy(owner: Owner): Promise<void> {
    owner = snapshotDurableInput(owner);
    await this.locked((state) => {
      state.schemaVersion = 1;
      state.highWatermarks.schemaVersion = 1;
      state.migration = {
        status: "idle",
        generation: state.migration.generation,
        fromVersion: 1,
        toVersion: 1,
      };
      beginCommit(state);
      const ctx = context(owner);
      const generation = ++state.highWatermarks.replayGeneration;
      put(state, ctx, replayKey(ctx, "nonce", "legacy"), {
        kind: "nonce",
        hash: "legacy",
        expiresAt: 999,
        generation,
      });
    }, false);
  }
}

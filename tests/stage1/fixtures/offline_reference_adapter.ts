import type {
  AtomicAuthorityResult,
  AttemptFinalization,
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
  InvocationReservation,
  InvocationReservationTransaction,
  MigrationPreparation,
  ReplayTransaction,
} from "../../../packages/core/src/store/authority_transaction.ts";
import type {
  Agent,
  Device,
  Principal,
  TenantContext,
} from "../../../packages/core/src/domain/types.ts";
import { ids } from "../../../packages/core/src/domain/types.ts";
import { entityKey, replayKey } from "../../../packages/core/src/store/keys.ts";
import { assertRestoreNotStale } from "../../../packages/core/src/store/migrations.ts";
import {
  assertAuthorityEnvelope,
  type DurableAuthorityEnvelope,
  type DurableRecord,
  hashDispatchPermit,
  sameDurableValue,
  serializeDurableAuthority,
} from "../../../packages/core/src/store/schema.ts";

/** Test machinery only: process contention and logical commits, never power-loss/fsync evidence. */
export interface Owner {
  tenantId: string;
  userId: string;
}
export type FaultPoint = "before_rename" | "after_commit_before_reply";
export class InjectedFault extends Error {
  constructor(readonly point: string) {
    super(`injected fault: ${point}`);
  }
}
type Status = "active" | "disabled" | "revoked";
type SubjectValue = {
  kind: "principal" | "agent" | "device" | "grant" | "connection";
  id: string;
  status: Status;
  version: number;
  identity: Principal | Agent | Device | null;
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
  request: ChallengeTransaction["mutation"] extends never ? never : Record<string, unknown>;
};

const safe = (value: unknown, minimum = 0): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0) &&
  value >= minimum;
const plain = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
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
const emptyEnvelope = (): DurableAuthorityEnvelope => ({
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

function nextVersion(state: DurableAuthorityEnvelope): number {
  return Math.max(0, ...Object.values(state.records).map((record) => record.recordVersion)) + 1;
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
    value: structuredClone(value),
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
      publicJwk: { kty: "OKP" },
      thumbprint: "agent_thumb",
      status: "active",
      epoch: 1,
    },
    device: {
      id: ids.device("device"),
      tenantId: ids.tenant(owner.tenantId),
      userId: ids.user(owner.userId),
      agentId: ids.agent("agent"),
      publicJwk: { kty: "OKP" },
      thumbprint: "device_thumb",
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
): boolean {
  const values = [
    [tx.principalId, "principal", tx.principalEpoch],
    [tx.agentId, "agent", tx.agentEpoch],
    [tx.deviceId, "device", tx.deviceEpoch],
    [tx.grantId, "grant", tx.grantVersion],
    [tx.connectionId, "connection", tx.connectionEpoch],
  ] as const;
  return tx.operation === "github.user.read" &&
    values.every(([id, kind, version]) =>
      subjectActive(subject(state, ctx, id)?.value, kind, version)
    );
}
function ownerRecords(
  state: DurableAuthorityEnvelope,
  ctx: TenantContext,
  kind?: string,
): Array<[string, DurableRecord]> {
  const prefix = `${ownerPrefix(ctx)}/${kind ? `${kind}/` : ""}`;
  return Object.entries(state.records).filter(([recordKey]) => recordKey.startsWith(prefix));
}

export class OfflineReferenceAuthority
  implements DurableAuthorityTransactions, DurableAuthorityMaintenance {
  readonly statePath: string;
  readonly lockPath: string;
  constructor(readonly root: string, private readonly injectedFault?: FaultPoint) {
    this.statePath = `${root}/authority.json`;
    this.lockPath = `${root}/authority.lock`;
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
      value = JSON.parse(await Deno.readTextFile(this.statePath));
    } catch {
      throw new Error("record denied");
    }
    assertAuthorityEnvelope(value, requireCurrent);
    return value;
  }
  private async write(state: DurableAuthorityEnvelope, fault?: FaultPoint): Promise<void> {
    const temporary = `${this.statePath}.${Deno.pid}.${crypto.randomUUID()}.tmp`;
    await Deno.writeFile(temporary, serializeDurableAuthority(state), { createNew: true });
    if (fault === "before_rename") {
      await Deno.remove(temporary).catch(() => undefined);
      throw new InjectedFault(fault);
    }
    await Deno.rename(temporary, this.statePath);
    if (fault === "after_commit_before_reply") throw new InjectedFault(fault);
  }
  private async locked<T>(
    operation: (state: DurableAuthorityEnvelope) => T | Promise<T>,
    requireCurrent = true,
    fault?: FaultPoint,
  ): Promise<T> {
    await this.initialize();
    for (let attempt = 0;; attempt++) {
      try {
        await Deno.mkdir(this.lockPath);
        break;
      } catch (error) {
        if (!(error instanceof Deno.errors.AlreadyExists) || attempt >= 5000) throw error;
        await new Promise((resolve) => setTimeout(resolve, 1 + attempt % 7));
      }
    }
    try {
      const state = await this.read(requireCurrent);
      const result = await operation(state);
      assertAuthorityEnvelope(state, requireCurrent);
      await this.write(state, fault ?? this.injectedFault);
      return result;
    } finally {
      await Deno.remove(this.lockPath).catch(() => undefined);
    }
  }

  /** Concrete seed/view helpers exist only to arrange and display test fixtures. */
  async seed(
    owner: Owner,
    custodyRef = `custody_${owner.tenantId}_${owner.userId}`,
  ): Promise<boolean> {
    return await this.locked((state) => {
      const ctx = context(owner);
      if (
        ownerRecords(state, ctx).length ||
        Object.values(state.records).some((item) =>
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
      put(state, ctx, subjectKey(ctx, "grant"), makeSubject("grant", "grant", "active", 1, null));
      put(
        state,
        ctx,
        subjectKey(ctx, "connection"),
        makeSubject("connection", "connection", "active", 1, null),
      );
      put(state, ctx, key(ctx, "connection", "connection"), {
        id: "connection",
        custodyReferenceHash: clean(custodyRef),
      });
      put(state, ctx, key(ctx, "custody", custodyRef), {
        custodyReferenceHash: clean(custodyRef),
        owner: ownerPrefix(ctx),
        connectionId: "connection",
      });
      return true;
    });
  }
  async inspect(owner: Owner): Promise<Record<string, unknown>> {
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
    return structuredClone({
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
    return await this.locked(
      (state) => {
        const now = effective(state, tx.now);
        if (!validBinding(state, ctx, tx) || tx.nonceExpiresAt <= now || tx.jtiExpiresAt <= now) {
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
            binding: structuredClone(tx),
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
          item.value.binding.nonceExpiresAt <= now || item.value.binding.jtiExpiresAt <= now
        ) return { outcome: "denied", reason: "reservation expired" };
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
    return await this.locked(async (state) => {
      effective(state, tx.now);
      const permit = tx.permit;
      const item = record<AttemptValue>(state, key(ctx, "attempt", clean(permit.attemptId)));
      if (!item || item.value.state !== "dispatching") {
        return { outcome: "denied", reason: "attempt state denied" };
      }
      if (item.value.dispatchStarted) return { outcome: "already_consumed" };
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
        result: structuredClone(tx.result),
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
    return await this.locked((state) => {
      const now = effective(state, tx.now);
      const challenge = tx.challenge;
      const challengeKey = key(ctx, "challenge", challenge.id);
      if (
        !ownerRecords(state, ctx).length || challenge.tenantId !== ctx.tenantId ||
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

  private ceremonyValid(
    state: DurableAuthorityEnvelope,
    ctx: TenantContext,
    tx: ChallengeTransaction,
    now: number,
  ): boolean {
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
      return p.id === ctx.userId && p.tenantId === ctx.tenantId && p.kind === "cryptographic" &&
        p.emailRequired === false && p.status === "active" && safe(p.epoch, 1) &&
        a.tenantId === ctx.tenantId && a.userId === ctx.userId && a.status === "active" &&
        safe(a.epoch, 1) && clean(a.id) === a.id && clean(a.thumbprint) === a.thumbprint &&
        d.tenantId === ctx.tenantId && d.userId === ctx.userId && d.agentId === a.id &&
        d.status === "active" && d.role === "admin" && safe(d.epoch, 1) && clean(d.id) === d.id &&
        clean(d.thumbprint) === d.thumbprint && String(a.id) !== String(d.id) &&
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
        identityThumbprint(agent) === value.agentThumbprint && request.tenantId === ctx.tenantId &&
        request.userId === ctx.userId && request.agentId === agent!.id &&
        request.status === "pending" && request.expiresAt > now &&
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
        Boolean(enrollment) && enrollment!.status === "pending" && safe(enrollment!.expiresAt, 1) &&
        Number(enrollment!.expiresAt) > now &&
        enrollment!.agentId === agent!.id && enrollment!.id === value.requestId &&
        enrollment!.thumbprint === device.thumbprint &&
        sameDurableValue(enrollment!.candidateJwk, device.publicJwk) &&
        device.id !== value.approverId && device.tenantId === ctx.tenantId &&
        device.userId === ctx.userId && device.agentId === agent!.id &&
        device.status === "active" && device.role === "member" && safe(device.epoch, 1) &&
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
      subjectActive(target, "device", value.targetEpoch) &&
      identityThumbprint(target) === value.targetThumbprint &&
      (target!.identity as Device).role === value.targetRole;
  }

  async commitChallenge(
    ctx: TenantContext,
    tx: ChallengeTransaction,
  ): Promise<AtomicAuthorityResult> {
    return await this.locked((state) => {
      const now = effective(state, tx.now);
      const challengeKey = key(ctx, "challenge", tx.challengeId);
      const challenge = record<ChallengeValue>(state, challengeKey);
      if (
        !challenge || challenge.value.used || challenge.value.expiresAt <= now ||
        challenge.value.transactionHash !== tx.transactionHash ||
        challenge.value.purpose !== tx.purpose || !this.ceremonyValid(state, ctx, tx, now)
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
        put(state, ctx, key(ctx, "enrollment", tx.mutation.value.request.id), {
          request: tx.mutation.value.request,
        });
      } else if (tx.mutation.kind === "approval") {
        const value = tx.mutation.value;
        const enrollmentKey = key(ctx, "enrollment", value.requestId);
        const stored = record<{ request: Record<string, unknown> }>(state, enrollmentKey)!;
        put(state, ctx, enrollmentKey, {
          request: { ...stored.value.request, status: "approved" },
        });
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
    return await this.locked((state) => {
      effective(state, tx.now);
      const recordKey = subjectKey(ctx, tx.subjectId);
      const item = record<SubjectValue>(state, recordKey);
      if (
        !item || item.value.kind !== tx.subjectType || item.value.version !== tx.expectedVersion ||
        tx.nextVersion !== tx.expectedVersion + 1 ||
        item.value.status === "revoked" && tx.nextStatus !== "revoked" ||
        item.value.status === "disabled" && tx.nextStatus === "active"
      ) return denied("authority transition denied");
      beginCommit(state);
      const identity = item.value.identity
        ? {
          ...item.value.identity,
          status: tx.nextStatus,
          epoch: tx.nextVersion,
        } as SubjectValue["identity"]
        : null;
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

  async exportAuthority(): Promise<DurableAuthorityEnvelope> {
    const value = await this.read(false);
    return structuredClone(value);
  }
  async inspectAuthority(requireCurrent = true): Promise<DurableAuthorityEnvelope> {
    return structuredClone(await this.read(requireCurrent));
  }
  async initializeAuthority(
    candidate: DurableAuthorityEnvelope,
  ): Promise<AuthorityMaintenanceResult> {
    return await this.locked((current) => {
      if (
        Object.keys(current.records).length || current.authorityGeneration !== 1 ||
        current.effectiveNow !== 0
      ) {
        return maintenanceDenied("authority store is not pristine");
      }
      try {
        assertAuthorityEnvelope(candidate, false);
      } catch {
        return maintenanceDenied("authority import denied");
      }
      for (const item of Object.keys(current)) {
        delete (current as unknown as Record<string, unknown>)[item];
      }
      Object.assign(current, structuredClone(candidate));
      return { outcome: "committed", authorityGeneration: current.authorityGeneration };
    }, false);
  }
  async restoreAuthority(candidate: DurableAuthorityEnvelope): Promise<AuthorityMaintenanceResult> {
    return await this.locked((current) => {
      try {
        assertRestoreNotStale(candidate, current);
      } catch {
        return maintenanceDenied("stale or corrupt restore denied");
      }
      for (const item of Object.keys(current)) {
        delete (current as unknown as Record<string, unknown>)[item];
      }
      Object.assign(current, structuredClone(candidate));
      return { outcome: "committed", authorityGeneration: current.authorityGeneration };
    });
  }
  async prepareMigration(tx: MigrationPreparation): Promise<AuthorityMaintenanceResult> {
    return await this.locked((state) => {
      if (
        state.schemaVersion !== tx.expectedSchemaVersion || state.migration.status !== "idle" ||
        tx.targetSchemaVersion !== tx.expectedSchemaVersion + 1
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
  async advanceMigration(): Promise<AuthorityMaintenanceResult> {
    return await this.locked((state) => {
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
  async failMigration(): Promise<AuthorityMaintenanceResult> {
    return await this.locked((state) => {
      if (!["preparing", "committing"].includes(state.migration.status)) {
        return maintenanceDenied("migration failure mark denied");
      }
      beginCommit(state);
      state.migration.status = "failed";
      return { outcome: "committed", authorityGeneration: state.authorityGeneration };
    }, false);
  }
  async recoverMigration(): Promise<AuthorityMaintenanceResult> {
    for (;;) {
      const state = await this.read(false);
      if (state.schemaVersion === 2 && state.migration.status === "idle") {
        return { outcome: "committed", authorityGeneration: state.authorityGeneration };
      }
      if (state.migration.status === "failed") {
        await this.locked((value) => {
          if (value.migration.status === "failed") {
            beginCommit(value);
            value.migration.status = "preparing";
          }
        }, false);
      } else if (state.migration.status === "idle") {
        await this.prepareMigration({
          expectedSchemaVersion: state.schemaVersion,
          targetSchemaVersion: state.schemaVersion + 1,
        });
      } else await this.advanceMigration();
    }
  }

  /** Test-only preparation of an old neutral envelope; migration itself uses the neutral contract. */
  async writeLegacy(owner: Owner): Promise<void> {
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

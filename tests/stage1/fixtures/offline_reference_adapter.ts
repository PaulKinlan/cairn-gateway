import type {
  AtomicAuthorityResult,
  AttemptFinalization,
  AuthorityTransition,
  ChallengeCreationTransaction,
  ChallengeTransaction,
  DispatchClaimTransaction,
  DispatchPermitClaim,
  DispatchRecoveryTransaction,
  DurableAuthorityTransactions,
  InvocationReservation,
  InvocationReservationTransaction,
  ReplayTransaction,
} from "../../../packages/core/src/store/authority_transaction.ts";
import { grantsDispatch } from "../../../packages/core/src/store/authority_transaction.ts";
import type { TenantContext } from "../../../packages/core/src/domain/types.ts";
import { ids } from "../../../packages/core/src/domain/types.ts";
import { serializeDurableAuthority } from "../../../packages/core/src/store/schema.ts";

/** Test machinery only: a process-contended file oracle, never production storage evidence. */
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
type Subject = { id: string; status: Status; version: number; recordVersion: number };
type Replay = {
  kind: "nonce" | "jti";
  hash: string;
  expiresAt: number;
  generation: number;
  recordVersion: number;
};
type Attempt = {
  state: "reserved" | "dispatching" | "completed" | "failed_safe" | "dispatch_unknown";
  binding: InvocationReservationTransaction;
  replayKeys: string[];
  dispatchPermitUsed: boolean;
  claimVersion: number;
  permitToken: string | null;
  dispatchStarted: boolean;
  dispatchStarts: number;
  automaticRetry: false;
  result: unknown;
  recordVersion: number;
};
type Challenge = ChallengeCreationTransaction["challenge"] & { recordVersion: number };
type Ceremony = { kind: ChallengeTransaction["mutation"]["kind"]; recordVersion: number };
type TenantState = {
  tenantId: string;
  userId: string;
  subjects: Record<"principal" | "agent" | "device" | "grant" | "connection", Subject>;
  replay: Record<string, Replay>;
  attempts: Record<string, Attempt>;
  challenges: Record<string, Challenge>;
  ceremonies: Record<string, Ceremony>;
  enrollments: Record<string, { status: "pending" | "approved"; recordVersion: number }>;
  connections: Record<string, { custodyRef: string; recordVersion: number }>;
};
type State = {
  format: "cairn-offline-reference-test-only";
  schemaVersion: number;
  migration: {
    status: "idle" | "preparing" | "committing" | "failed";
    generation: number;
    fromVersion: number;
    toVersion: number;
  };
  authorityGeneration: number;
  highWatermarks: {
    authorityGeneration: number;
    migrationGeneration: number;
    replayGeneration: number;
    revocationGeneration: number;
    schemaVersion: number;
  };
  effectiveNow: number;
  recordVersion: number;
  tenants: Record<string, TenantState>;
  custodyClaims: Record<string, string>;
};

const safe = (value: unknown, minimum = 0): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
const plain = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  plain(value) && Object.keys(value).length === keys.length && keys.every((key) => key in value);
const clean = (value: string): string => {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error("owner denied");
  return value;
};
const ownerKey = (owner: Owner): string => `${clean(owner.tenantId)}/${clean(owner.userId)}`;
const context = (owner: Owner): TenantContext => ({
  tenantId: ids.tenant(clean(owner.tenantId)),
  userId: ids.user(clean(owner.userId)),
});
const emptyState = (): State => ({
  format: "cairn-offline-reference-test-only",
  schemaVersion: 2,
  migration: { status: "idle", generation: 0, fromVersion: 2, toVersion: 2 },
  authorityGeneration: 1,
  highWatermarks: {
    authorityGeneration: 1,
    migrationGeneration: 0,
    replayGeneration: 0,
    revocationGeneration: 0,
    schemaVersion: 2,
  },
  effectiveNow: 0,
  recordVersion: 0,
  tenants: {},
  custodyClaims: {},
});
const emptyTenant = (owner: Owner): TenantState => ({
  tenantId: owner.tenantId,
  userId: owner.userId,
  subjects: {
    principal: { id: owner.userId, status: "active", version: 1, recordVersion: 1 },
    agent: { id: "agent", status: "active", version: 1, recordVersion: 2 },
    device: { id: "device", status: "active", version: 1, recordVersion: 3 },
    grant: { id: "grant", status: "active", version: 1, recordVersion: 4 },
    connection: { id: "connection", status: "active", version: 1, recordVersion: 5 },
  },
  replay: {},
  attempts: {},
  challenges: {},
  ceremonies: {},
  enrollments: {},
  connections: {},
});

function assertBinding(value: unknown): asserts value is InvocationReservationTransaction {
  const keys = [
    "principalId",
    "principalEpoch",
    "agentId",
    "agentEpoch",
    "deviceId",
    "deviceEpoch",
    "grantId",
    "grantVersion",
    "connectionId",
    "connectionEpoch",
    "operation",
    "deviceNonceHash",
    "agentNonceHash",
    "nonceExpiresAt",
    "jtiHash",
    "jtiExpiresAt",
    "now",
    "attemptId",
    "correlationId",
  ];
  if (
    !exact(value, keys) ||
    [
      value.principalId,
      value.agentId,
      value.deviceId,
      value.grantId,
      value.connectionId,
      value.deviceNonceHash,
      value.agentNonceHash,
      value.jtiHash,
      value.attemptId,
      value.correlationId,
    ].some((item) => typeof item !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(item)) ||
    [
      value.principalEpoch,
      value.agentEpoch,
      value.deviceEpoch,
      value.grantVersion,
      value.connectionEpoch,
    ].some((item) => !safe(item, 1)) ||
    !safe(value.nonceExpiresAt, 1) || !safe(value.jtiExpiresAt, 1) || !safe(value.now) ||
    value.operation !== "github.user.read"
  ) throw new Error("record denied");
}
function assertAttemptResult(state: Attempt["state"], value: unknown): void {
  if (["reserved", "dispatching"].includes(state)) {
    if (value !== null) throw new Error("record denied");
    return;
  }
  if (!plain(value) || value.outcome !== state) throw new Error("record denied");
  if (state === "completed") {
    if (
      !exact(value, ["outcome", "resultHash"]) || typeof value.resultHash !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(value.resultHash)
    ) throw new Error("record denied");
  } else if (state === "failed_safe") {
    if (
      !exact(value, ["outcome", "reason"]) || typeof value.reason !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(value.reason)
    ) throw new Error("record denied");
  } else if (!exact(value, ["outcome"])) throw new Error("record denied");
}
function assertSubject(value: unknown): asserts value is Subject {
  if (
    !exact(value, ["id", "status", "version", "recordVersion"]) ||
    typeof value.id !== "string" ||
    !["active", "disabled", "revoked"].includes(String(value.status)) ||
    !safe(value.version, 1) || !safe(value.recordVersion, 1)
  ) throw new Error("record denied");
}
function assertState(value: unknown, requireCurrent = true): asserts value is State {
  if (
    !exact(value, [
      "format",
      "schemaVersion",
      "migration",
      "authorityGeneration",
      "highWatermarks",
      "effectiveNow",
      "recordVersion",
      "tenants",
      "custodyClaims",
    ])
  ) throw new Error("record denied");
  const state = value as unknown as State;
  if (
    state.format !== "cairn-offline-reference-test-only" || !safe(state.schemaVersion, 1) ||
    state.schemaVersion > 2 || (requireCurrent && state.schemaVersion !== 2) ||
    !safe(state.authorityGeneration, 1) || !safe(state.effectiveNow) ||
    !safe(state.recordVersion) ||
    !exact(state.highWatermarks, [
      "authorityGeneration",
      "migrationGeneration",
      "replayGeneration",
      "revocationGeneration",
      "schemaVersion",
    ]) || state.highWatermarks.authorityGeneration !== state.authorityGeneration ||
    state.highWatermarks.schemaVersion !== state.schemaVersion ||
    !safe(state.highWatermarks.migrationGeneration) ||
    !safe(state.highWatermarks.replayGeneration) ||
    !safe(state.highWatermarks.revocationGeneration) ||
    !exact(state.migration, ["status", "generation", "fromVersion", "toVersion"]) ||
    !["idle", "preparing", "committing", "failed"].includes(state.migration.status) ||
    !safe(state.migration.generation) ||
    state.migration.generation !== state.highWatermarks.migrationGeneration ||
    !safe(state.migration.fromVersion, 1) || !safe(state.migration.toVersion, 1) ||
    (requireCurrent && (state.migration.status !== "idle" || state.migration.toVersion !== 2)) ||
    !plain(state.tenants) || !plain(state.custodyClaims)
  ) throw new Error("record denied");
  let maximumRecord = 0;
  const custodySeen = new Map<string, string>();
  for (const [key, tenant] of Object.entries(state.tenants)) {
    if (
      !exact(tenant, [
        "tenantId",
        "userId",
        "subjects",
        "replay",
        "attempts",
        "challenges",
        "ceremonies",
        "enrollments",
        "connections",
      ]) || key !== `${tenant.tenantId}/${tenant.userId}` || !clean(tenant.tenantId) ||
      !clean(tenant.userId) || !exact(tenant.subjects, [
        "principal",
        "agent",
        "device",
        "grant",
        "connection",
      ]) || !plain(tenant.replay) || !plain(tenant.attempts) || !plain(tenant.challenges) ||
      !plain(tenant.ceremonies) || !plain(tenant.enrollments) || !plain(tenant.connections)
    ) {
      throw new Error("record denied");
    }
    for (const subject of Object.values(tenant.subjects)) {
      assertSubject(subject);
      maximumRecord = Math.max(maximumRecord, subject.recordVersion);
    }
    for (const [replayKey, replay] of Object.entries(tenant.replay)) {
      if (
        !exact(replay, ["kind", "hash", "expiresAt", "generation", "recordVersion"]) ||
        !["nonce", "jti"].includes(replay.kind) || replayKey !== `${replay.kind}/${replay.hash}` ||
        !clean(replay.hash) || !safe(replay.expiresAt, 1) || !safe(replay.generation, 1) ||
        replay.generation > state.highWatermarks.replayGeneration || !safe(replay.recordVersion, 1)
      ) {
        throw new Error("record denied");
      }
      maximumRecord = Math.max(maximumRecord, replay.recordVersion);
    }
    for (const [attemptId, attempt] of Object.entries(tenant.attempts)) {
      if (
        !exact(attempt, [
          "state",
          "binding",
          "replayKeys",
          "dispatchPermitUsed",
          "claimVersion",
          "permitToken",
          "dispatchStarted",
          "dispatchStarts",
          "automaticRetry",
          "result",
          "recordVersion",
        ]) ||
        !["reserved", "dispatching", "completed", "failed_safe", "dispatch_unknown"].includes(
          attempt.state,
        ) ||
        !plain(attempt.binding) || attempt.binding.attemptId !== attemptId ||
        !Array.isArray(attempt.replayKeys) ||
        attempt.replayKeys.length !== 3 || attempt.replayKeys.some((key) => !tenant.replay[key]) ||
        typeof attempt.dispatchPermitUsed !== "boolean" || !safe(attempt.claimVersion) ||
        !(attempt.permitToken === null || clean(attempt.permitToken)) ||
        typeof attempt.dispatchStarted !== "boolean" || !safe(attempt.dispatchStarts) ||
        attempt.dispatchStarts > 1 || attempt.automaticRetry !== false ||
        !safe(attempt.recordVersion, 1) ||
        (["reserved", "failed_safe"].includes(attempt.state) && !attempt.dispatchPermitUsed &&
          (attempt.claimVersion !== 0 || attempt.permitToken !== null)) ||
        (["dispatching", "completed", "dispatch_unknown"].includes(attempt.state) &&
          (!attempt.dispatchPermitUsed || attempt.claimVersion < 1 || !attempt.permitToken))
      ) {
        throw new Error("record denied");
      }
      assertBinding(attempt.binding);
      assertAttemptResult(attempt.state, attempt.result);
      maximumRecord = Math.max(maximumRecord, attempt.recordVersion);
    }
    for (const [id, challenge] of Object.entries(tenant.challenges)) {
      if (
        !exact(challenge, [
          "id",
          "tenantId",
          "userId",
          "purpose",
          "transactionHash",
          "expiresAt",
          "used",
          "recordVersion",
        ]) || challenge.id !== id || challenge.tenantId !== tenant.tenantId ||
        challenge.userId !== tenant.userId ||
        !["bootstrap", "enroll_candidate", "approve_enrollment", "remove_device"].includes(
          challenge.purpose,
        ) ||
        !clean(challenge.transactionHash) || !safe(challenge.expiresAt, 1) ||
        typeof challenge.used !== "boolean" ||
        !safe(challenge.recordVersion, 1)
      ) throw new Error("record denied");
      maximumRecord = Math.max(maximumRecord, challenge.recordVersion);
    }
    for (const [id, ceremony] of Object.entries(tenant.ceremonies)) {
      if (
        !clean(id) || !exact(ceremony, ["kind", "recordVersion"]) ||
        !["bootstrap", "enrollment", "approval", "removal"].includes(ceremony.kind) ||
        !safe(ceremony.recordVersion, 1)
      ) throw new Error("record denied");
      maximumRecord = Math.max(maximumRecord, ceremony.recordVersion);
    }
    for (const [id, enrollment] of Object.entries(tenant.enrollments)) {
      if (
        !clean(id) || !exact(enrollment, ["status", "recordVersion"]) ||
        !["pending", "approved"].includes(enrollment.status) || !safe(enrollment.recordVersion, 1)
      ) {
        throw new Error("record denied");
      }
      maximumRecord = Math.max(maximumRecord, enrollment.recordVersion);
    }
    for (const [id, connection] of Object.entries(tenant.connections)) {
      if (
        !clean(id) || !exact(connection, ["custodyRef", "recordVersion"]) ||
        !clean(connection.custodyRef) || !safe(connection.recordVersion, 1)
      ) throw new Error("record denied");
      const owner = custodySeen.get(connection.custodyRef);
      if (owner && owner !== key) throw new Error("record denied");
      custodySeen.set(connection.custodyRef, key);
      maximumRecord = Math.max(maximumRecord, connection.recordVersion);
    }
  }
  for (const [custody, owner] of Object.entries(state.custodyClaims)) {
    if (!clean(custody) || typeof owner !== "string" || custodySeen.get(custody) !== owner) {
      throw new Error("record denied");
    }
  }
  if (maximumRecord > state.recordVersion) throw new Error("record denied");
  serializeDurableAuthority(state);
}

function bump(state: State): number {
  state.authorityGeneration++;
  state.highWatermarks.authorityGeneration = state.authorityGeneration;
  return ++state.recordVersion;
}
function effective(state: State, now: number): number {
  if (!safe(now)) throw new Error("time denied");
  state.effectiveNow = Math.max(state.effectiveNow, now);
  return state.effectiveNow;
}
const denied = (reason: string): AtomicAuthorityResult => ({ outcome: "denied", reason });

export class OfflineReferenceAuthority implements DurableAuthorityTransactions {
  readonly statePath: string;
  readonly lockPath: string;
  constructor(readonly root: string) {
    this.statePath = `${root}/authority.json`;
    this.lockPath = `${root}/authority.lock`;
  }

  async initialize(): Promise<void> {
    await Deno.mkdir(this.root, { recursive: true });
    try {
      await Deno.writeFile(this.statePath, serializeDurableAuthority(emptyState()), {
        createNew: true,
      });
    } catch (error) {
      if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
    }
  }
  async read(requireCurrent = true): Promise<State> {
    let value: unknown;
    try {
      value = JSON.parse(await Deno.readTextFile(this.statePath));
    } catch {
      throw new Error("record denied");
    }
    assertState(value, requireCurrent);
    return value;
  }
  private async write(state: State, fault?: FaultPoint): Promise<void> {
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
    operation: (state: State) => T | Promise<T>,
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
      assertState(state, requireCurrent);
      await this.write(state, fault);
      return result;
    } finally {
      await Deno.remove(this.lockPath).catch(() => undefined);
    }
  }
  private tenant(state: State, ctx: TenantContext): TenantState | undefined {
    return state.tenants[ownerKey(ctx)];
  }

  async seed(
    owner: Owner,
    custodyRef = `custody_${owner.tenantId}_${owner.userId}`,
  ): Promise<boolean> {
    return await this.locked((state) => {
      const key = ownerKey(owner);
      if (state.tenants[key] || state.custodyClaims[clean(custodyRef)]) return false;
      const tenant = emptyTenant(owner);
      state.recordVersion += 5;
      tenant.connections.connection = { custodyRef, recordVersion: ++state.recordVersion };
      state.tenants[key] = tenant;
      state.custodyClaims[custodyRef] = key;
      state.authorityGeneration++;
      state.highWatermarks.authorityGeneration = state.authorityGeneration;
      return true;
    });
  }
  async inspect(owner: Owner): Promise<Record<string, unknown>> {
    const state = await this.read();
    const tenant = this.tenant(state, context(owner));
    return structuredClone({
      exists: Boolean(tenant),
      tenant: tenant ?? null,
      schemaVersion: state.schemaVersion,
      migration: state.migration,
      authorityGeneration: state.authorityGeneration,
      highWatermarks: state.highWatermarks,
      effectiveNow: state.effectiveNow,
    });
  }

  async consumeReplay(ctx: TenantContext, tx: ReplayTransaction): Promise<AtomicAuthorityResult> {
    return await this.locked((state) => {
      const tenant = this.tenant(state, ctx);
      const now = effective(state, tx.now);
      if (!tenant || !tx.records.length || tx.expiresAt <= now) return denied("replay denied");
      const keys = tx.records.map(({ kind, hash }) => `${kind}/${clean(hash)}`);
      if (new Set(keys).size !== keys.length) return denied("duplicate replay key");
      for (const [key, record] of Object.entries(tenant.replay)) {
        if (record.expiresAt < now) delete tenant.replay[key];
      }
      if (keys.some((key) => tenant.replay[key])) return denied("already consumed");
      const generation = ++state.highWatermarks.replayGeneration;
      for (let index = 0; index < keys.length; index++) {
        const record = tx.records[index]!;
        tenant.replay[keys[index]!] = {
          kind: record.kind,
          hash: record.hash,
          expiresAt: tx.expiresAt,
          generation,
          recordVersion: ++state.recordVersion,
        };
      }
      state.authorityGeneration++;
      state.highWatermarks.authorityGeneration = state.authorityGeneration;
      return {
        outcome: "committed",
        authorityGeneration: state.authorityGeneration,
        recordVersion: state.recordVersion,
      };
    });
  }

  private bindingsValid(tenant: TenantState, tx: InvocationReservationTransaction): boolean {
    const s = tenant.subjects;
    return tx.principalId === s.principal.id && tx.principalEpoch === s.principal.version &&
      tx.agentId === s.agent.id && tx.agentEpoch === s.agent.version &&
      tx.deviceId === s.device.id && tx.deviceEpoch === s.device.version &&
      tx.grantId === s.grant.id && tx.grantVersion === s.grant.version &&
      tx.connectionId === s.connection.id && tx.connectionEpoch === s.connection.version &&
      tx.operation === "github.user.read" &&
      Object.values(s).every((subject) => subject.status === "active");
  }
  async reserveInvocation(
    ctx: TenantContext,
    tx: InvocationReservationTransaction,
  ): Promise<InvocationReservation> {
    return await this.reserveInvocationFault(ctx, tx);
  }
  async reserveInvocationFault(
    ctx: TenantContext,
    tx: InvocationReservationTransaction,
    fault?: FaultPoint,
  ): Promise<InvocationReservation> {
    return await this.locked(
      (state) => {
        const tenant = this.tenant(state, ctx);
        const now = effective(state, tx.now);
        if (
          !tenant || !this.bindingsValid(tenant, tx) || tx.nonceExpiresAt <= now ||
          tx.jtiExpiresAt <= now
        ) {
          return { outcome: "denied", reason: "binding or expiry denied" };
        }
        const keys = [
          `nonce/${clean(tx.deviceNonceHash)}`,
          `nonce/${clean(tx.agentNonceHash)}`,
          `jti/${clean(tx.jtiHash)}`,
        ];
        if (
          new Set(keys).size !== 3 || tenant.attempts[clean(tx.attemptId)] ||
          keys.some((key) => tenant.replay[key])
        ) {
          return { outcome: "already_consumed" };
        }
        const generation = ++state.highWatermarks.replayGeneration;
        const values = [
          ["nonce", tx.deviceNonceHash, tx.nonceExpiresAt],
          ["nonce", tx.agentNonceHash, tx.nonceExpiresAt],
          ["jti", tx.jtiHash, tx.jtiExpiresAt],
        ] as const;
        for (let index = 0; index < keys.length; index++) {
          const [kind, hash, expiresAt] = values[index]!;
          tenant.replay[keys[index]!] = {
            kind,
            hash,
            expiresAt,
            generation,
            recordVersion: ++state.recordVersion,
          };
        }
        tenant.attempts[tx.attemptId] = {
          state: "reserved",
          binding: structuredClone(tx),
          replayKeys: keys,
          dispatchPermitUsed: false,
          claimVersion: 0,
          permitToken: null,
          dispatchStarted: false,
          dispatchStarts: 0,
          automaticRetry: false,
          result: null,
          recordVersion: ++state.recordVersion,
        };
        state.authorityGeneration++;
        state.highWatermarks.authorityGeneration = state.authorityGeneration;
        return {
          outcome: "reserved",
          attemptId: tx.attemptId,
          authorityGeneration: state.authorityGeneration,
        };
      },
      true,
      fault,
    );
  }

  async claimDispatch(
    ctx: TenantContext,
    tx: DispatchClaimTransaction,
  ): Promise<DispatchPermitClaim> {
    return await this.claimDispatchFault(ctx, tx);
  }
  async claimDispatchFault(
    ctx: TenantContext,
    tx: DispatchClaimTransaction,
    fault?: FaultPoint,
  ): Promise<DispatchPermitClaim> {
    return await this.locked(
      (state) => {
        const tenant = this.tenant(state, ctx);
        const now = effective(state, tx.now);
        const attempt = tenant?.attempts[clean(tx.attemptId)];
        if (!attempt) return { outcome: "denied", reason: "attempt absent" };
        if (
          tx.expectedState !== "reserved" || attempt.state !== "reserved" ||
          attempt.dispatchPermitUsed
        ) {
          return { outcome: "already_consumed" };
        }
        if (attempt.binding.nonceExpiresAt <= now || attempt.binding.jtiExpiresAt <= now) {
          return { outcome: "denied", reason: "reservation expired" };
        }
        attempt.state = "dispatching";
        attempt.dispatchPermitUsed = true;
        attempt.claimVersion = 1;
        attempt.permitToken = clean(`permit_${tx.attemptId}_1`);
        attempt.recordVersion = bump(state);
        return {
          outcome: "permit",
          permit: {
            attemptId: tx.attemptId,
            claimVersion: 1,
            authorityGeneration: state.authorityGeneration,
            token: attempt.permitToken,
          },
        };
      },
      true,
      fault,
    );
  }

  async dispatchWithPermit(
    ctx: TenantContext,
    claim: DispatchPermitClaim,
    ambiguous = false,
  ): Promise<boolean> {
    if (!grantsDispatch(claim)) return false;
    const result = await this.locked((state) => {
      const attempt = this.tenant(state, ctx)?.attempts[claim.permit.attemptId];
      if (
        !attempt || attempt.state !== "dispatching" || attempt.dispatchStarted ||
        attempt.claimVersion !== claim.permit.claimVersion ||
        attempt.permitToken !== claim.permit.token
      ) return false;
      attempt.dispatchStarted = true;
      attempt.dispatchStarts++;
      attempt.recordVersion = bump(state);
      return true;
    });
    if (ambiguous && result) throw new InjectedFault("dispatch_start_ambiguity");
    return result;
  }

  async finalizeAttempt(
    ctx: TenantContext,
    tx: AttemptFinalization,
  ): Promise<AtomicAuthorityResult> {
    return await this.locked((state) => {
      const attempt = this.tenant(state, ctx)?.attempts[clean(tx.attemptId)];
      effective(state, tx.now);
      if (!attempt || attempt.state !== tx.expectedState) return denied("attempt state denied");
      if (tx.expectedState === "dispatching") {
        const permit = tx.permit;
        if (
          permit.attemptId !== tx.attemptId || permit.claimVersion !== attempt.claimVersion ||
          permit.token !== attempt.permitToken
        ) return denied("dispatch permit denied");
      }
      if (tx.result.outcome !== tx.nextState) return denied("attempt result denied");
      attempt.state = tx.nextState;
      attempt.result = structuredClone(tx.result);
      attempt.recordVersion = bump(state);
      return {
        outcome: "committed",
        authorityGeneration: state.authorityGeneration,
        recordVersion: attempt.recordVersion,
      };
    });
  }
  async recoverDispatch(
    ctx: TenantContext,
    tx: DispatchRecoveryTransaction,
  ): Promise<AtomicAuthorityResult> {
    return await this.locked((state) => {
      const attempt = this.tenant(state, ctx)?.attempts[clean(tx.attemptId)];
      effective(state, tx.now);
      if (!attempt || attempt.state !== "dispatching") return denied("dispatch recovery denied");
      attempt.state = "dispatch_unknown";
      attempt.result = { outcome: "dispatch_unknown" };
      attempt.recordVersion = bump(state);
      return {
        outcome: "committed",
        authorityGeneration: state.authorityGeneration,
        recordVersion: attempt.recordVersion,
      };
    });
  }

  async issueChallenge(
    ctx: TenantContext,
    tx: ChallengeCreationTransaction,
  ): Promise<AtomicAuthorityResult> {
    return await this.locked((state) => {
      const tenant = this.tenant(state, ctx);
      const now = effective(state, tx.now);
      const challenge = tx.challenge;
      if (
        !tenant || challenge.tenantId !== ctx.tenantId || challenge.userId !== ctx.userId ||
        challenge.expiresAt <= now || challenge.used || tx.expectedAbsent !== true ||
        tenant.challenges[clean(challenge.id)]
      ) return denied("challenge issue denied");
      tenant.challenges[challenge.id] = {
        ...structuredClone(challenge),
        recordVersion: bump(state),
      };
      return {
        outcome: "committed",
        authorityGeneration: state.authorityGeneration,
        recordVersion: tenant.challenges[challenge.id]!.recordVersion,
      };
    });
  }

  private ceremonyValid(
    tenant: TenantState,
    ctx: TenantContext,
    tx: ChallengeTransaction,
  ): boolean {
    const mutation = tx.mutation;
    if (
      (tx.purpose === "bootstrap" && mutation.kind !== "bootstrap") ||
      (tx.purpose === "enroll_candidate" && mutation.kind !== "enrollment") ||
      (tx.purpose === "approve_enrollment" && mutation.kind !== "approval") ||
      (tx.purpose === "remove_device" && mutation.kind !== "removal")
    ) return false;
    if (mutation.kind === "bootstrap") {
      const value = mutation.value;
      return value.principal.tenantId === ctx.tenantId && value.principal.id === ctx.userId &&
        value.agent.tenantId === ctx.tenantId && value.agent.userId === ctx.userId &&
        value.device.tenantId === ctx.tenantId && value.device.userId === ctx.userId;
    }
    if (mutation.kind === "enrollment") {
      const value = mutation.value;
      return value.request.tenantId === ctx.tenantId && value.request.userId === ctx.userId &&
        value.principalEpoch === tenant.subjects.principal.version &&
        value.agentEpoch === tenant.subjects.agent.version;
    }
    if (mutation.kind === "approval") {
      const value = mutation.value;
      return Boolean(tenant.enrollments[value.requestId]) &&
        value.device.tenantId === ctx.tenantId && value.device.userId === ctx.userId &&
        value.principalEpoch === tenant.subjects.principal.version &&
        value.agentEpoch === tenant.subjects.agent.version && value.approverEpoch >= 1;
    }
    const value = mutation.value;
    return value.agentEpoch === tenant.subjects.agent.version && value.approverEpoch >= 1 &&
      value.targetEpoch === tenant.subjects.device.version &&
      value.targetId === tenant.subjects.device.id;
  }

  async commitChallenge(
    ctx: TenantContext,
    tx: ChallengeTransaction,
  ): Promise<AtomicAuthorityResult> {
    return await this.locked((state) => {
      const tenant = this.tenant(state, ctx);
      const now = effective(state, tx.now);
      const challenge = tenant?.challenges[clean(tx.challengeId)];
      if (
        !tenant || !challenge || challenge.used || challenge.expiresAt <= now ||
        challenge.transactionHash !== tx.transactionHash || challenge.purpose !== tx.purpose ||
        !this.ceremonyValid(tenant, ctx, tx)
      ) return denied("challenge commit denied");
      if (tx.mutation.kind === "enrollment") {
        const id = tx.mutation.value.request.id;
        if (tenant.enrollments[id]) return denied("enrollment exists");
        tenant.enrollments[id] = { status: "pending", recordVersion: ++state.recordVersion };
      } else if (tx.mutation.kind === "approval") {
        const enrollment = tenant.enrollments[tx.mutation.value.requestId]!;
        enrollment.status = "approved";
        enrollment.recordVersion = ++state.recordVersion;
      } else if (tx.mutation.kind === "removal") {
        tenant.subjects.device.status = "revoked";
        tenant.subjects.device.version++;
        tenant.subjects.device.recordVersion = ++state.recordVersion;
        state.highWatermarks.revocationGeneration++;
      }
      challenge.used = true;
      challenge.recordVersion = ++state.recordVersion;
      tenant.ceremonies[tx.challengeId] = { kind: tx.mutation.kind, recordVersion: bump(state) };
      return {
        outcome: "committed",
        authorityGeneration: state.authorityGeneration,
        recordVersion: tenant.ceremonies[tx.challengeId]!.recordVersion,
      };
    });
  }

  async transitionAuthority(
    ctx: TenantContext,
    tx: AuthorityTransition,
  ): Promise<AtomicAuthorityResult> {
    return await this.locked((state) => {
      const subject = this.tenant(state, ctx)?.subjects[tx.subjectType];
      effective(state, tx.now);
      if (
        !subject || subject.id !== tx.subjectId || subject.version !== tx.expectedVersion ||
        tx.nextVersion !== tx.expectedVersion + 1
      ) return denied("authority transition denied");
      subject.status = tx.nextStatus;
      subject.version = tx.nextVersion;
      subject.recordVersion = bump(state);
      if (tx.nextStatus === "revoked") state.highWatermarks.revocationGeneration++;
      return {
        outcome: "committed",
        authorityGeneration: state.authorityGeneration,
        recordVersion: subject.recordVersion,
      };
    });
  }

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
      const tenant = state.tenants[ownerKey(owner)];
      if (tenant) {
        const generation = ++state.highWatermarks.replayGeneration;
        tenant.replay["nonce/legacy"] = {
          kind: "nonce",
          hash: "legacy",
          expiresAt: 999,
          generation,
          recordVersion: ++state.recordVersion,
        };
      }
      state.authorityGeneration++;
      state.highWatermarks.authorityGeneration = state.authorityGeneration;
    }, false);
  }
  async migrate(
    fault?: "after_preparing" | "after_committing" | "mark_failed",
  ): Promise<"migrated" | "already_current"> {
    await this.initialize();
    let state = await this.read(false);
    if (state.schemaVersion === 2 && state.migration.status === "idle") return "already_current";
    if (state.migration.status === "idle" || state.migration.status === "failed") {
      await this.locked((value) => {
        if (
          value.schemaVersion === 2 ||
          !["idle", "failed"].includes(value.migration.status)
        ) return;
        value.migration = {
          status: "preparing",
          generation: value.migration.generation + 1,
          fromVersion: 1,
          toVersion: 2,
        };
        value.highWatermarks.migrationGeneration = value.migration.generation;
        value.authorityGeneration++;
        value.highWatermarks.authorityGeneration = value.authorityGeneration;
      }, false);
      if (fault === "after_preparing") throw new InjectedFault(fault);
    }
    state = await this.read(false);
    if (state.migration.status === "preparing") {
      await this.locked((value) => {
        if (value.migration.status !== "preparing") return;
        value.migration.status = fault === "mark_failed" ? "failed" : "committing";
        value.authorityGeneration++;
        value.highWatermarks.authorityGeneration = value.authorityGeneration;
      }, false);
      if (fault === "mark_failed" || fault === "after_committing") throw new InjectedFault(fault);
    }
    state = await this.read(false);
    if (state.migration.status === "failed") return await this.migrate();
    if (state.migration.status === "committing") {
      await this.locked((value) => {
        if (value.migration.status !== "committing") return;
        value.schemaVersion = 2;
        value.highWatermarks.schemaVersion = 2;
        value.migration.status = "idle";
        value.authorityGeneration++;
        value.highWatermarks.authorityGeneration = value.authorityGeneration;
      }, false);
    }
    return "migrated";
  }

  private assertNoRollback(candidate: unknown, current: unknown, path = "state"): void {
    if (plain(current)) {
      if (!plain(candidate)) throw new Error(`restore deletion denied: ${path}`);
      const currentVersion = current.recordVersion;
      const candidateVersion = candidate.recordVersion;
      if (safe(currentVersion, 1)) {
        if (!safe(candidateVersion, 1) || candidateVersion < currentVersion) {
          throw new Error("record rollback denied");
        }
        if (
          candidateVersion === currentVersion &&
          new TextDecoder().decode(serializeDurableAuthority(candidate)) !==
            new TextDecoder().decode(serializeDurableAuthority(current))
        ) {
          throw new Error("copied-watermark payload rollback denied");
        }
      }
      for (const key of Object.keys(current)) {
        this.assertNoRollback(candidate[key], current[key], `${path}.${key}`);
      }
    }
  }
  async restore(candidatePath: string): Promise<boolean> {
    return await this.locked(async (current) => {
      let candidate: unknown;
      try {
        candidate = JSON.parse(await Deno.readTextFile(candidatePath));
        assertState(candidate);
      } catch {
        return false;
      }
      if (candidate.authorityGeneration < current.authorityGeneration) return false;
      const dimensions = [
        "authorityGeneration",
        "migrationGeneration",
        "replayGeneration",
        "revocationGeneration",
        "schemaVersion",
      ] as const;
      if (dimensions.some((key) => candidate.highWatermarks[key] < current.highWatermarks[key])) {
        return false;
      }
      try {
        this.assertNoRollback(candidate.tenants, current.tenants, "tenants");
      } catch {
        return false;
      }
      for (const key of Object.keys(current)) {
        delete (current as unknown as Record<string, unknown>)[key];
      }
      Object.assign(current, candidate);
      return true;
    });
  }
  async snapshot(path: string): Promise<void> {
    await Deno.copyFile(this.statePath, path);
  }
}

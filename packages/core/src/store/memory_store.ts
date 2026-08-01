// deno-lint-ignore-file require-await
import { types as nodeTypes } from "node:util";
import type {
  Agent,
  Connection,
  Device,
  EnrollmentChallenge,
  EnrollmentRequest,
  Grant,
  Principal,
  RevocationEvent,
  TenantContext,
} from "../domain/types.ts";
import { jwkThumbprint } from "../crypto/thumbprint.ts";
import {
  approvalTransaction,
  bootstrapTransaction,
  enrollmentTransaction,
  removalTransaction,
  transactionHash,
} from "../identity/transactions.ts";
import { entityKey, ownerPrefix, replayKey } from "./keys.ts";
import type {
  ApprovalCommit,
  BootstrapCommit,
  EnrollmentRequestCommit,
  InvocationBinding,
  InvocationDecision,
  MetadataStore,
  RemovalCommit,
} from "./store.ts";

function assertPlainData(value: unknown, active = new WeakSet<object>()): void {
  if (value === null || ["string", "number", "boolean", "undefined"].includes(typeof value)) {
    return;
  }
  if (typeof value !== "object") throw new Error("plain data denied");
  const object = value as object;
  if (nodeTypes.isProxy(object) || active.has(object)) throw new Error("plain data denied");
  active.add(object);
  try {
    const array = Array.isArray(object);
    const prototype = Object.getPrototypeOf(object);
    if (prototype !== (array ? Array.prototype : Object.prototype)) {
      throw new Error("plain data denied");
    }
    const descriptors = Object.getOwnPropertyDescriptors(object);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key === "symbol") throw new Error("plain data denied");
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor)) throw new Error("plain data denied");
      if (!array && !descriptor.enumerable) throw new Error("plain data denied");
      if (array && key !== "length" && !descriptor.enumerable) throw new Error("plain data denied");
      assertPlainData(descriptor.value, active);
    }
  } finally {
    active.delete(object);
  }
}

function freezePlainData(value: unknown, seen = new WeakSet<object>()): void {
  if (!value || typeof value !== "object" || seen.has(value as object)) return;
  const object = value as Record<PropertyKey, unknown>;
  seen.add(object);
  for (const key of Reflect.ownKeys(object)) freezePlainData(object[key], seen);
  Object.freeze(object);
}

/** Rejects accessors, exotic prototypes, symbols, cycles, and proxies before use. */
function plainDataSnapshot<T>(value: T): Readonly<T> {
  try {
    // Deno's local runtime proxy predicate is trap-free; use it recursively before reflection.
    assertPlainData(value);
    const snapshot = structuredClone(value);
    assertPlainData(snapshot);
    freezePlainData(snapshot);
    return snapshot;
  } catch {
    throw new Error("plain data denied");
  }
}

/** Authoritative fixture backend. Multiple service/store facades must share this object. */
export class MemoryAuthorityBackend {
  principals = new Map<string, Principal>();
  agents = new Map<string, Agent>();
  devices = new Map<string, Device>();
  enrollments = new Map<string, EnrollmentRequest>();
  challenges = new Map<string, EnrollmentChallenge>();
  connections = new Map<string, Connection>();
  grants = new Map<string, Grant>();
  used = new Map<string, number>();
  revocations: RevocationEvent[] = [];
  tail: Promise<void> = Promise.resolve();
  async exclusive<T>(fn: () => T | Promise<T>): Promise<T> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => release = resolve);
    const prior = this.tail;
    this.tail = prior.then(() => gate);
    await prior;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export class MemoryStore implements MetadataStore {
  constructor(readonly backend = new MemoryAuthorityBackend()) {}
  #owned(ctx: TenantContext, value: { tenantId: string; userId: string }): void {
    if (value.tenantId !== ctx.tenantId || value.userId !== ctx.userId) {
      throw new Error("ownership denied");
    }
  }
  async putPrincipal(ctx: TenantContext, value: Principal): Promise<void> {
    const snapshot = plainDataSnapshot(value);
    this.#owned(ctx, { ...snapshot, userId: snapshot.id });
    this.backend.principals.set(entityKey(ctx, "principal", snapshot.id), snapshot);
  }
  async getPrincipal(ctx: TenantContext, id: string): Promise<Principal | undefined> {
    return structuredClone(this.backend.principals.get(entityKey(ctx, "principal", id)));
  }
  async putAgent(ctx: TenantContext, value: Agent): Promise<void> {
    const snapshot = plainDataSnapshot(value);
    this.#owned(ctx, snapshot);
    const thumbprint = await jwkThumbprint(snapshot.publicJwk);
    if (thumbprint !== snapshot.thumbprint) throw new Error("agent key denied");
    await this.backend.exclusive(async () => {
      const key = entityKey(ctx, "agent", snapshot.id);
      if (this.backend.agents.has(key)) throw new Error("agent exists");
      for (const device of this.backend.devices.values()) {
        if (device.tenantId !== ctx.tenantId || device.userId !== ctx.userId) continue;
        const deviceThumbprint = await jwkThumbprint(device.publicJwk);
        if (deviceThumbprint !== device.thumbprint) throw new Error("device key denied");
        if (deviceThumbprint === thumbprint) throw new Error("agent and device keys must differ");
      }
      this.backend.agents.set(key, snapshot);
    });
  }
  async getAgent(ctx: TenantContext, id: string): Promise<Agent | undefined> {
    return structuredClone(this.backend.agents.get(entityKey(ctx, "agent", id)));
  }
  async putDevice(ctx: TenantContext, value: Device): Promise<void> {
    const snapshot = plainDataSnapshot(value);
    this.#owned(ctx, snapshot);
    const thumbprint = await jwkThumbprint(snapshot.publicJwk);
    if (thumbprint !== snapshot.thumbprint) throw new Error("device key denied");
    await this.backend.exclusive(async () => {
      const key = entityKey(ctx, "device", snapshot.id);
      if (this.backend.devices.has(key)) throw new Error("device exists");
      let referencedAgent: Agent | undefined;
      for (const agent of this.backend.agents.values()) {
        if (agent.tenantId !== ctx.tenantId || agent.userId !== ctx.userId) continue;
        const agentThumbprint = await jwkThumbprint(agent.publicJwk);
        if (agentThumbprint !== agent.thumbprint) throw new Error("agent key denied");
        if (agentThumbprint === thumbprint) throw new Error("agent and device keys must differ");
        if (agent.id === snapshot.agentId) referencedAgent = agent;
      }
      if (!referencedAgent) throw new Error("device agent denied");
      this.backend.devices.set(key, snapshot);
    });
  }
  async getDevice(ctx: TenantContext, id: string): Promise<Device | undefined> {
    return structuredClone(this.backend.devices.get(entityKey(ctx, "device", id)));
  }
  async listDevices(ctx: TenantContext): Promise<Device[]> {
    const prefix = `${ownerPrefix(ctx)}/device/`;
    return [...this.backend.devices.entries()].filter(([key]) => key.startsWith(prefix)).map((
      [, value],
    ) => structuredClone(value));
  }
  async putEnrollment(ctx: TenantContext, value: EnrollmentRequest): Promise<void> {
    const snapshot = plainDataSnapshot(value);
    this.#owned(ctx, snapshot);
    this.backend.enrollments.set(entityKey(ctx, "enrollment", snapshot.id), snapshot);
  }
  async getEnrollment(ctx: TenantContext, id: string): Promise<EnrollmentRequest | undefined> {
    return structuredClone(this.backend.enrollments.get(entityKey(ctx, "enrollment", id)));
  }
  async putConnection(ctx: TenantContext, value: Connection): Promise<void> {
    this.#owned(ctx, value);
    await this.backend.exclusive(() => {
      for (const item of this.backend.connections.values()) {
        if (
          item.custodyRef === value.custodyRef &&
          (item.tenantId !== ctx.tenantId || item.userId !== ctx.userId || item.id !== value.id)
        ) throw new Error("custody ownership denied");
      }
      this.backend.connections.set(entityKey(ctx, "connection", value.id), structuredClone(value));
    });
  }
  async getConnection(ctx: TenantContext, id: string): Promise<Connection | undefined> {
    return structuredClone(this.backend.connections.get(entityKey(ctx, "connection", id)));
  }
  async putGrant(ctx: TenantContext, value: Grant): Promise<void> {
    this.#owned(ctx, value);
    this.backend.grants.set(entityKey(ctx, "grant", value.id), structuredClone(value));
  }
  async getGrant(ctx: TenantContext, id: string): Promise<Grant | undefined> {
    return structuredClone(this.backend.grants.get(entityKey(ctx, "grant", id)));
  }
  async issueChallenge(ctx: TenantContext, value: EnrollmentChallenge): Promise<void> {
    this.#owned(ctx, value);
    await this.backend.exclusive(() => {
      const key = entityKey(ctx, "challenge", value.id);
      if (this.backend.challenges.has(key)) throw new Error("challenge exists");
      this.backend.challenges.set(key, structuredClone(value));
    });
  }
  #consumeChallenge(
    ctx: TenantContext,
    id: string,
    hash: string,
    purpose: EnrollmentChallenge["purpose"],
    now: number,
  ): EnrollmentChallenge | undefined {
    const key = entityKey(ctx, "challenge", id);
    const challenge = this.backend.challenges.get(key);
    if (
      !challenge || challenge.used || challenge.purpose !== purpose ||
      challenge.transactionHash !== hash || challenge.expiresAt <= now
    ) return undefined;
    challenge.used = true;
    this.backend.challenges.set(key, challenge);
    return challenge;
  }
  async commitBootstrap(
    ctx: TenantContext,
    challengeId: string,
    value: BootstrapCommit,
    now: number,
  ): Promise<boolean> {
    const snapshot = plainDataSnapshot(value);
    this.#owned(ctx, { ...snapshot.principal, userId: snapshot.principal.id });
    this.#owned(ctx, snapshot.agent);
    this.#owned(ctx, snapshot.device);
    return await this.backend.exclusive(async () => {
      const transaction = await bootstrapTransaction(
        ctx,
        snapshot.principal,
        snapshot.agent,
        snapshot.device,
      );
      const hash = await transactionHash(transaction);
      if (
        snapshot.principal.id !== ctx.userId || snapshot.principal.tenantId !== ctx.tenantId ||
        snapshot.principal.kind !== "cryptographic" || snapshot.principal.emailRequired !== false ||
        snapshot.principal.status !== "active" || snapshot.principal.epoch !== 1 ||
        snapshot.agent.status !== "active" || snapshot.agent.epoch !== 1 ||
        snapshot.agent.thumbprint !== transaction.agent_jkt ||
        snapshot.device.agentId !== snapshot.agent.id || snapshot.device.role !== "admin" ||
        snapshot.device.status !== "active" || snapshot.device.epoch !== 1 ||
        snapshot.device.thumbprint !== transaction.device_jkt ||
        transaction.agent_jkt === transaction.device_jkt ||
        this.backend.principals.has(entityKey(ctx, "principal", ctx.userId)) ||
        [...this.backend.agents.values()].some((agent) =>
          agent.tenantId === ctx.tenantId && agent.userId === ctx.userId
        ) ||
        [...this.backend.devices.values()].some((device) =>
          device.tenantId === ctx.tenantId && device.userId === ctx.userId
        )
      ) return false;
      if (!this.#consumeChallenge(ctx, challengeId, hash, "bootstrap", now)) return false;
      this.backend.principals.set(
        entityKey(ctx, "principal", snapshot.principal.id),
        snapshot.principal,
      );
      this.backend.agents.set(
        entityKey(ctx, "agent", snapshot.agent.id),
        snapshot.agent,
      );
      this.backend.devices.set(
        entityKey(ctx, "device", snapshot.device.id),
        snapshot.device,
      );
      return true;
    });
  }
  async commitEnrollmentRequest(
    ctx: TenantContext,
    challengeId: string,
    value: EnrollmentRequestCommit,
    now: number,
  ): Promise<boolean> {
    const snapshot = plainDataSnapshot(value);
    this.#owned(ctx, snapshot.request);
    return await this.backend.exclusive(async () => {
      const principal = this.backend.principals.get(entityKey(ctx, "principal", ctx.userId));
      const agent = this.backend.agents.get(entityKey(ctx, "agent", snapshot.request.agentId));
      if (!principal || !agent) return false;
      const agentThumbprint = await jwkThumbprint(agent.publicJwk);
      const transaction = await enrollmentTransaction(ctx, snapshot.request, principal, agent);
      const hash = await transactionHash(transaction);
      let ownerAgentKeyDenied = false;
      for (const ownerAgent of this.backend.agents.values()) {
        if (ownerAgent.tenantId !== ctx.tenantId || ownerAgent.userId !== ctx.userId) continue;
        const ownerAgentThumbprint = await jwkThumbprint(ownerAgent.publicJwk);
        if (
          ownerAgentThumbprint !== ownerAgent.thumbprint ||
          ownerAgentThumbprint === transaction.candidate_jkt
        ) ownerAgentKeyDenied = true;
      }
      if (
        principal.status !== "active" || principal.epoch !== snapshot.principalEpoch ||
        agent.status !== "active" || agent.epoch !== snapshot.agentEpoch ||
        agentThumbprint !== agent.thumbprint || agent.thumbprint !== snapshot.agentThumbprint ||
        transaction.candidate_jkt !== snapshot.request.thumbprint || ownerAgentKeyDenied ||
        transaction.candidate_jkt === agentThumbprint || snapshot.request.status !== "pending" ||
        snapshot.request.expiresAt <= now || snapshot.request.expiresAt > now + 600 ||
        transaction.request_id !== snapshot.request.id || transaction.agent_id !== agent.id ||
        [...this.backend.devices.values()].some((device) =>
          device.tenantId === ctx.tenantId && device.userId === ctx.userId &&
          device.thumbprint === snapshot.request.thumbprint
        )
      ) return false;
      const key = entityKey(ctx, "enrollment", snapshot.request.id);
      if (this.backend.enrollments.has(key)) return false;
      if (!this.#consumeChallenge(ctx, challengeId, hash, "enroll_candidate", now)) return false;
      this.backend.enrollments.set(key, snapshot.request);
      return true;
    });
  }
  async commitApproval(
    ctx: TenantContext,
    challengeId: string,
    value: ApprovalCommit,
    now: number,
  ): Promise<boolean> {
    const snapshot = plainDataSnapshot(value);
    this.#owned(ctx, snapshot.device);
    return await this.backend.exclusive(async () => {
      const requestKey = entityKey(ctx, "enrollment", snapshot.requestId);
      const request = this.backend.enrollments.get(requestKey);
      const principal = this.backend.principals.get(entityKey(ctx, "principal", ctx.userId));
      const agent = request
        ? this.backend.agents.get(entityKey(ctx, "agent", request.agentId))
        : undefined;
      const approver = this.backend.devices.get(entityKey(ctx, "device", snapshot.approverId));
      if (!request || !principal || !agent || !approver) return false;
      const requestThumbprint = await jwkThumbprint(request.candidateJwk);
      const deviceThumbprint = await jwkThumbprint(snapshot.device.publicJwk);
      const agentThumbprint = await jwkThumbprint(agent.publicJwk);
      const approverThumbprint = await jwkThumbprint(approver.publicJwk);
      let ownerAgentKeyDenied = false;
      for (const ownerAgent of this.backend.agents.values()) {
        if (ownerAgent.tenantId !== ctx.tenantId || ownerAgent.userId !== ctx.userId) continue;
        const ownerAgentThumbprint = await jwkThumbprint(ownerAgent.publicJwk);
        if (
          ownerAgentThumbprint !== ownerAgent.thumbprint ||
          ownerAgentThumbprint === deviceThumbprint
        ) ownerAgentKeyDenied = true;
      }
      const transaction = approvalTransaction(
        ctx,
        principal,
        agent,
        request,
        approver,
        snapshot.device.id,
      );
      const hash = await transactionHash(transaction);
      if (
        request.status !== "pending" || request.expiresAt <= now ||
        principal.status !== "active" || principal.epoch !== snapshot.principalEpoch ||
        agent.status !== "active" || agent.epoch !== snapshot.agentEpoch ||
        agentThumbprint !== agent.thumbprint || agent.thumbprint !== snapshot.agentThumbprint ||
        requestThumbprint !== request.thumbprint ||
        deviceThumbprint !== snapshot.device.thumbprint ||
        requestThumbprint !== deviceThumbprint || ownerAgentKeyDenied ||
        deviceThumbprint === agentThumbprint ||
        approver.status !== "active" || approver.role !== "admin" ||
        approver.agentId !== request.agentId || approver.epoch !== snapshot.approverEpoch ||
        approverThumbprint !== approver.thumbprint ||
        approver.thumbprint !== snapshot.approverThumbprint ||
        approverThumbprint === agentThumbprint ||
        approverThumbprint === deviceThumbprint || snapshot.device.agentId !== request.agentId ||
        snapshot.device.thumbprint !== request.thumbprint || snapshot.device.role !== "member" ||
        snapshot.device.status !== "active" || snapshot.device.epoch !== 1 ||
        JSON.stringify(snapshot.device.publicJwk) !== JSON.stringify(request.candidateJwk) ||
        this.backend.devices.has(entityKey(ctx, "device", snapshot.device.id))
      ) return false;
      if (!this.#consumeChallenge(ctx, challengeId, hash, "approve_enrollment", now)) return false;
      this.backend.devices.set(
        entityKey(ctx, "device", snapshot.device.id),
        snapshot.device,
      );
      this.backend.enrollments.set(requestKey, { ...request, status: "approved" });
      return true;
    });
  }
  async commitRemoval(
    ctx: TenantContext,
    challengeId: string,
    value: RemovalCommit,
    now: number,
  ): Promise<boolean> {
    const snapshot = plainDataSnapshot(value);
    return await this.backend.exclusive(async () => {
      const agent = this.backend.agents.get(entityKey(ctx, "agent", snapshot.agentId));
      const approver = this.backend.devices.get(entityKey(ctx, "device", snapshot.approverId));
      const targetKey = entityKey(ctx, "device", snapshot.targetId);
      const target = this.backend.devices.get(targetKey);
      if (!agent || !approver || !target) return false;
      const agentThumbprint = await jwkThumbprint(agent.publicJwk);
      const approverThumbprint = await jwkThumbprint(approver.publicJwk);
      const targetThumbprint = await jwkThumbprint(target.publicJwk);
      const transaction = removalTransaction(ctx, agent, approver, target);
      const hash = await transactionHash(transaction);
      if (
        agent.tenantId !== ctx.tenantId || agent.userId !== ctx.userId ||
        agent.status !== "active" || agent.epoch !== snapshot.agentEpoch ||
        agentThumbprint !== agent.thumbprint || agent.thumbprint !== snapshot.agentThumbprint ||
        approver.tenantId !== ctx.tenantId || approver.userId !== ctx.userId ||
        approver.status !== "active" || approver.role !== "admin" ||
        approver.agentId !== agent.id || approver.epoch !== snapshot.approverEpoch ||
        approverThumbprint !== approver.thumbprint ||
        approver.thumbprint !== snapshot.approverThumbprint ||
        approverThumbprint === agentThumbprint ||
        target.tenantId !== ctx.tenantId || target.userId !== ctx.userId ||
        target.status !== "active" || target.agentId !== agent.id ||
        target.epoch !== snapshot.targetEpoch || target.role !== snapshot.targetRole ||
        targetThumbprint !== target.thumbprint || target.thumbprint !== snapshot.targetThumbprint ||
        targetThumbprint === agentThumbprint
      ) return false;
      if (!this.#consumeChallenge(ctx, challengeId, hash, "remove_device", now)) return false;
      const revoked = { ...target, status: "revoked" as const, epoch: target.epoch + 1 };
      this.backend.devices.set(targetKey, structuredClone(revoked));
      this.backend.revocations.push({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        subjectType: "device",
        subjectId: target.id,
        version: revoked.epoch,
        reason: "operator",
        at: now,
      });
      return true;
    });
  }
  async #update<T extends { tenantId: string; userId?: string; id: string; status: string }>(
    ctx: TenantContext,
    map: Map<string, T>,
    kind: "principal" | "agent" | "device" | "grant" | "connection",
    value: T,
    version: number,
    reason: RevocationEvent["reason"] = "operator",
    at = 0,
  ): Promise<void> {
    await this.backend.exclusive(async () => {
      this.#owned(ctx, {
        tenantId: value.tenantId,
        userId: kind === "principal" ? value.id : value.userId ?? "",
      });
      const key = entityKey(ctx, kind, value.id);
      const previous = map.get(key);
      if (!previous) throw new Error(`${kind} not found`);
      if (kind === "agent" || kind === "device") {
        const priorIdentity = previous as unknown as Agent | Device;
        const nextIdentity = value as unknown as Agent | Device;
        const priorThumbprint = await jwkThumbprint(priorIdentity.publicJwk);
        const nextThumbprint = await jwkThumbprint(nextIdentity.publicJwk);
        if (
          priorThumbprint !== priorIdentity.thumbprint ||
          nextThumbprint !== nextIdentity.thumbprint ||
          nextThumbprint !== priorThumbprint ||
          nextIdentity.thumbprint !== priorIdentity.thumbprint ||
          JSON.stringify(nextIdentity.publicJwk) !== JSON.stringify(priorIdentity.publicJwk)
        ) throw new Error("identity key rotation denied");
        if (kind === "agent") {
          for (const device of this.backend.devices.values()) {
            if (device.tenantId !== ctx.tenantId || device.userId !== ctx.userId) continue;
            const deviceThumbprint = await jwkThumbprint(device.publicJwk);
            if (deviceThumbprint !== device.thumbprint) throw new Error("device key denied");
            if (deviceThumbprint === nextThumbprint) {
              throw new Error("agent and device keys must differ");
            }
          }
        } else {
          const priorDevice = priorIdentity as Device;
          const nextDevice = nextIdentity as Device;
          if (nextDevice.agentId !== priorDevice.agentId || nextDevice.role !== priorDevice.role) {
            throw new Error("device relationship mutation denied");
          }
          let referencedAgent = false;
          for (const agent of this.backend.agents.values()) {
            if (agent.tenantId !== ctx.tenantId || agent.userId !== ctx.userId) continue;
            const agentThumbprint = await jwkThumbprint(agent.publicJwk);
            if (agentThumbprint !== agent.thumbprint) throw new Error("agent key denied");
            if (agentThumbprint === nextThumbprint) {
              throw new Error("agent and device keys must differ");
            }
            if (agent.id === nextDevice.agentId) referencedAgent = true;
          }
          if (!referencedAgent) throw new Error("device agent denied");
        }
      }
      const oldVersion = "epoch" in previous
        ? Number(previous.epoch)
        : Number((previous as unknown as Grant).version);
      if (version <= oldVersion) throw new Error("version must increase");
      map.set(key, value);
      if (value.status !== "active") {
        this.backend.revocations.push({
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          subjectType: kind,
          subjectId: value.id,
          version,
          reason,
          at,
        });
      }
    });
  }
  updatePrincipal(
    ctx: TenantContext,
    value: Principal,
    reason?: RevocationEvent["reason"],
    at?: number,
  ): Promise<void> {
    const snapshot = plainDataSnapshot(value);
    return this.#update(
      ctx,
      this.backend.principals,
      "principal",
      snapshot,
      snapshot.epoch,
      reason,
      at,
    );
  }
  updateAgent(
    ctx: TenantContext,
    value: Agent,
    reason?: RevocationEvent["reason"],
    at?: number,
  ): Promise<void> {
    const snapshot = plainDataSnapshot(value);
    return this.#update(
      ctx,
      this.backend.agents,
      "agent",
      snapshot,
      snapshot.epoch,
      reason,
      at,
    );
  }
  updateDevice(
    ctx: TenantContext,
    value: Device,
    reason?: RevocationEvent["reason"],
    at?: number,
  ): Promise<void> {
    const snapshot = plainDataSnapshot(value);
    return this.#update(
      ctx,
      this.backend.devices,
      "device",
      snapshot,
      snapshot.epoch,
      reason,
      at,
    );
  }
  updateGrant(
    ctx: TenantContext,
    value: Grant,
    reason?: RevocationEvent["reason"],
    at?: number,
  ): Promise<void> {
    const snapshot = plainDataSnapshot(value);
    return this.#update(
      ctx,
      this.backend.grants,
      "grant",
      snapshot,
      snapshot.version,
      reason,
      at,
    );
  }
  async updateConnection(
    ctx: TenantContext,
    value: Connection,
    reason?: RevocationEvent["reason"],
    at = 0,
  ): Promise<void> {
    this.#owned(ctx, value);
    await this.backend.exclusive(() => {
      const key = entityKey(ctx, "connection", value.id);
      const previous = this.backend.connections.get(key);
      if (!previous) throw new Error("connection not found");
      // Custody references are owner-bound immutable handles. Rotation is a new
      // connection ceremony, never a metadata update.
      if (value.custodyRef !== previous.custodyRef) throw new Error("custody ownership denied");
      if (value.epoch <= previous.epoch) throw new Error("version must increase");
      this.backend.connections.set(key, structuredClone(value));
      if (value.status !== "active") {
        this.backend.revocations.push({
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          subjectType: "connection",
          subjectId: value.id,
          version: value.epoch,
          reason: reason ?? "operator",
          at,
        });
      }
    });
  }
  consumeNonce(
    ctx: TenantContext,
    nonceHash: string,
    expiresAt: number,
    now: number,
  ): Promise<boolean> {
    return this.consumeNonces(ctx, [nonceHash], expiresAt, now);
  }
  async consumeNonces(
    ctx: TenantContext,
    nonceHashes: string[],
    expiresAt: number,
    now: number,
  ): Promise<boolean> {
    if (!nonceHashes.length || new Set(nonceHashes).size !== nonceHashes.length) return false;
    return await this.backend.exclusive(() => {
      const keys = nonceHashes.map((hash) => replayKey(ctx, "nonce", hash));
      for (const [key, expiry] of this.backend.used) {
        if (expiry < now) this.backend.used.delete(key);
      }
      if (keys.some((key) => this.backend.used.has(key))) return false;
      for (const key of keys) this.backend.used.set(key, expiresAt);
      return true;
    });
  }
  async consumeInvocation(ctx: TenantContext, b: InvocationBinding): Promise<InvocationDecision> {
    return await this.backend.exclusive(() => {
      const nonceKeys = [
          replayKey(ctx, "nonce", b.deviceNonceHash),
          replayKey(ctx, "nonce", b.agentNonceHash),
        ],
        jtiKey = replayKey(ctx, "jti", b.jtiHash);
      for (const [key, expiry] of this.backend.used) {
        if (expiry < b.now) this.backend.used.delete(key);
      }
      if (nonceKeys.some((key) => this.backend.used.has(key))) {
        return { ok: false, reason: "nonce replay" };
      }
      if (this.backend.used.has(jtiKey)) return { ok: false, reason: "capability replay" };
      const principal = this.backend.principals.get(entityKey(ctx, "principal", b.principalId));
      const agent = this.backend.agents.get(entityKey(ctx, "agent", b.agentId));
      const device = this.backend.devices.get(entityKey(ctx, "device", b.deviceId));
      const grant = this.backend.grants.get(entityKey(ctx, "grant", b.grantId));
      const connection = this.backend.connections.get(entityKey(ctx, "connection", b.connectionId));
      if (!principal || principal.status !== "active" || principal.epoch !== b.principalEpoch) {
        return { ok: false, reason: "principal inactive" };
      }
      if (!agent || agent.status !== "active" || agent.epoch !== b.agentEpoch) {
        return { ok: false, reason: "agent inactive" };
      }
      if (
        !device || device.status !== "active" || device.epoch !== b.deviceEpoch ||
        device.agentId !== b.agentId || device.thumbprint === agent.thumbprint
      ) return { ok: false, reason: "device inactive" };
      if (
        !grant || grant.status !== "active" || grant.version !== b.grantVersion ||
        grant.agentId !== b.agentId || grant.deviceId !== b.deviceId ||
        grant.connectionId !== b.connectionId || grant.operation !== b.operation ||
        grant.expiresAt <= b.now
      ) return { ok: false, reason: "grant inactive" };
      if (!connection || connection.status !== "active" || connection.epoch !== b.connectionEpoch) {
        return { ok: false, reason: "connection inactive" };
      }
      for (const nonceKey of nonceKeys) this.backend.used.set(nonceKey, b.nonceExpiresAt);
      this.backend.used.set(jtiKey, b.jtiExpiresAt);
      return { ok: true };
    });
  }
  async revocations(ctx: TenantContext): Promise<RevocationEvent[]> {
    return structuredClone(
      this.backend.revocations.filter((event) =>
        event.tenantId === ctx.tenantId && event.userId === ctx.userId
      ),
    );
  }
}

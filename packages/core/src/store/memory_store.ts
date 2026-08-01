// deno-lint-ignore-file require-await
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
} from "./store.ts";

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
    this.#owned(ctx, { ...value, userId: value.id });
    this.backend.principals.set(entityKey(ctx, "principal", value.id), structuredClone(value));
  }
  async getPrincipal(ctx: TenantContext, id: string): Promise<Principal | undefined> {
    return structuredClone(this.backend.principals.get(entityKey(ctx, "principal", id)));
  }
  async putAgent(ctx: TenantContext, value: Agent): Promise<void> {
    this.#owned(ctx, value);
    const thumbprint = await jwkThumbprint(value.publicJwk);
    if (thumbprint !== value.thumbprint) throw new Error("agent key denied");
    await this.backend.exclusive(() => {
      const key = entityKey(ctx, "agent", value.id);
      if (this.backend.agents.has(key)) throw new Error("agent exists");
      for (const device of this.backend.devices.values()) {
        if (
          device.tenantId === ctx.tenantId && device.userId === ctx.userId &&
          device.agentId === value.id && device.thumbprint === thumbprint
        ) throw new Error("agent and device keys must differ");
      }
      this.backend.agents.set(key, structuredClone(value));
    });
  }
  async getAgent(ctx: TenantContext, id: string): Promise<Agent | undefined> {
    return structuredClone(this.backend.agents.get(entityKey(ctx, "agent", id)));
  }
  async putDevice(ctx: TenantContext, value: Device): Promise<void> {
    this.#owned(ctx, value);
    const thumbprint = await jwkThumbprint(value.publicJwk);
    if (thumbprint !== value.thumbprint) throw new Error("device key denied");
    await this.backend.exclusive(async () => {
      const key = entityKey(ctx, "device", value.id);
      if (this.backend.devices.has(key)) throw new Error("device exists");
      const agent = this.backend.agents.get(entityKey(ctx, "agent", value.agentId));
      const agentThumbprint = agent ? await jwkThumbprint(agent.publicJwk) : undefined;
      if (
        !agent || agentThumbprint !== agent.thumbprint ||
        agentThumbprint === thumbprint
      ) {
        throw new Error("agent and device keys must differ");
      }
      this.backend.devices.set(key, structuredClone(value));
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
    this.#owned(ctx, value);
    this.backend.enrollments.set(entityKey(ctx, "enrollment", value.id), structuredClone(value));
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
    this.#owned(ctx, { ...value.principal, userId: value.principal.id });
    this.#owned(ctx, value.agent);
    this.#owned(ctx, value.device);
    return await this.backend.exclusive(async () => {
      const transaction = await bootstrapTransaction(
        ctx,
        value.principal,
        value.agent,
        value.device,
      );
      const hash = await transactionHash(transaction);
      if (
        value.principal.id !== ctx.userId || value.principal.tenantId !== ctx.tenantId ||
        value.principal.kind !== "cryptographic" || value.principal.emailRequired !== false ||
        value.principal.status !== "active" || value.principal.epoch !== 1 ||
        value.agent.status !== "active" || value.agent.epoch !== 1 ||
        value.agent.thumbprint !== transaction.agent_jkt ||
        value.device.agentId !== value.agent.id || value.device.role !== "admin" ||
        value.device.status !== "active" || value.device.epoch !== 1 ||
        value.device.thumbprint !== transaction.device_jkt ||
        transaction.agent_jkt === transaction.device_jkt ||
        this.backend.principals.has(entityKey(ctx, "principal", ctx.userId)) ||
        this.backend.agents.has(entityKey(ctx, "agent", value.agent.id)) ||
        [...this.backend.devices.keys()].some((key) =>
          key.startsWith(`${ownerPrefix(ctx)}/device/`)
        )
      ) return false;
      if (!this.#consumeChallenge(ctx, challengeId, hash, "bootstrap", now)) return false;
      this.backend.principals.set(
        entityKey(ctx, "principal", value.principal.id),
        structuredClone(value.principal),
      );
      this.backend.agents.set(
        entityKey(ctx, "agent", value.agent.id),
        structuredClone(value.agent),
      );
      this.backend.devices.set(
        entityKey(ctx, "device", value.device.id),
        structuredClone(value.device),
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
    this.#owned(ctx, value.request);
    return await this.backend.exclusive(async () => {
      const principal = this.backend.principals.get(entityKey(ctx, "principal", ctx.userId));
      const agent = this.backend.agents.get(entityKey(ctx, "agent", value.request.agentId));
      if (!principal || !agent) return false;
      const agentThumbprint = await jwkThumbprint(agent.publicJwk);
      const transaction = await enrollmentTransaction(ctx, value.request, principal, agent);
      const hash = await transactionHash(transaction);
      if (
        principal.status !== "active" || principal.epoch !== value.principalEpoch ||
        agent.status !== "active" || agent.epoch !== value.agentEpoch ||
        agentThumbprint !== agent.thumbprint || agent.thumbprint !== value.agentThumbprint ||
        transaction.candidate_jkt !== value.request.thumbprint ||
        transaction.candidate_jkt === agentThumbprint || value.request.status !== "pending" ||
        value.request.expiresAt <= now || value.request.expiresAt > now + 600 ||
        transaction.request_id !== value.request.id || transaction.agent_id !== agent.id ||
        [...this.backend.devices.values()].some((device) =>
          device.tenantId === ctx.tenantId && device.userId === ctx.userId &&
          device.thumbprint === value.request.thumbprint
        )
      ) return false;
      const key = entityKey(ctx, "enrollment", value.request.id);
      if (this.backend.enrollments.has(key)) return false;
      if (!this.#consumeChallenge(ctx, challengeId, hash, "enroll_candidate", now)) return false;
      this.backend.enrollments.set(key, structuredClone(value.request));
      return true;
    });
  }
  async commitApproval(
    ctx: TenantContext,
    challengeId: string,
    value: ApprovalCommit,
    now: number,
  ): Promise<boolean> {
    this.#owned(ctx, value.device);
    return await this.backend.exclusive(async () => {
      const requestKey = entityKey(ctx, "enrollment", value.requestId);
      const request = this.backend.enrollments.get(requestKey);
      const principal = this.backend.principals.get(entityKey(ctx, "principal", ctx.userId));
      const agent = request
        ? this.backend.agents.get(entityKey(ctx, "agent", request.agentId))
        : undefined;
      const approver = this.backend.devices.get(entityKey(ctx, "device", value.approverId));
      if (!request || !principal || !agent || !approver) return false;
      const requestThumbprint = await jwkThumbprint(request.candidateJwk);
      const deviceThumbprint = await jwkThumbprint(value.device.publicJwk);
      const agentThumbprint = await jwkThumbprint(agent.publicJwk);
      const approverThumbprint = await jwkThumbprint(approver.publicJwk);
      const transaction = approvalTransaction(
        ctx,
        principal,
        agent,
        request,
        approver,
        value.device.id,
      );
      const hash = await transactionHash(transaction);
      if (
        request.status !== "pending" || request.expiresAt <= now ||
        principal.status !== "active" || principal.epoch !== value.principalEpoch ||
        agent.status !== "active" || agent.epoch !== value.agentEpoch ||
        agentThumbprint !== agent.thumbprint || agent.thumbprint !== value.agentThumbprint ||
        requestThumbprint !== request.thumbprint || deviceThumbprint !== value.device.thumbprint ||
        requestThumbprint !== deviceThumbprint || deviceThumbprint === agentThumbprint ||
        approver.status !== "active" || approver.role !== "admin" ||
        approver.agentId !== request.agentId || approver.epoch !== value.approverEpoch ||
        approverThumbprint !== approver.thumbprint ||
        approver.thumbprint !== value.approverThumbprint ||
        approverThumbprint === agentThumbprint ||
        approverThumbprint === deviceThumbprint || value.device.agentId !== request.agentId ||
        value.device.thumbprint !== request.thumbprint || value.device.role !== "member" ||
        value.device.status !== "active" || value.device.epoch !== 1 ||
        JSON.stringify(value.device.publicJwk) !== JSON.stringify(request.candidateJwk) ||
        this.backend.devices.has(entityKey(ctx, "device", value.device.id))
      ) return false;
      if (!this.#consumeChallenge(ctx, challengeId, hash, "approve_enrollment", now)) return false;
      this.backend.devices.set(
        entityKey(ctx, "device", value.device.id),
        structuredClone(value.device),
      );
      this.backend.enrollments.set(requestKey, { ...request, status: "approved" });
      return true;
    });
  }
  async consumeChallenge(
    ctx: TenantContext,
    challengeId: string,
    hash: string,
    purpose: EnrollmentChallenge["purpose"],
    now: number,
  ): Promise<boolean> {
    return await this.backend.exclusive(() =>
      !!this.#consumeChallenge(ctx, challengeId, hash, purpose, now)
    );
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
      }
      const oldVersion = "epoch" in previous
        ? Number(previous.epoch)
        : Number((previous as unknown as Grant).version);
      if (version <= oldVersion) throw new Error("version must increase");
      map.set(key, structuredClone(value));
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
    return this.#update(ctx, this.backend.principals, "principal", value, value.epoch, reason, at);
  }
  updateAgent(
    ctx: TenantContext,
    value: Agent,
    reason?: RevocationEvent["reason"],
    at?: number,
  ): Promise<void> {
    return this.#update(ctx, this.backend.agents, "agent", value, value.epoch, reason, at);
  }
  updateDevice(
    ctx: TenantContext,
    value: Device,
    reason?: RevocationEvent["reason"],
    at?: number,
  ): Promise<void> {
    return this.#update(ctx, this.backend.devices, "device", value, value.epoch, reason, at);
  }
  updateGrant(
    ctx: TenantContext,
    value: Grant,
    reason?: RevocationEvent["reason"],
    at?: number,
  ): Promise<void> {
    return this.#update(ctx, this.backend.grants, "grant", value, value.version, reason, at);
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

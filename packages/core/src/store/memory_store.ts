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
import { entityKey, ownerPrefix, replayKey } from "./keys.ts";
import type {
  ApprovalCommit,
  BootstrapCommit,
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
  async exclusive<T>(fn: () => T): Promise<T> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => release = resolve);
    const prior = this.tail;
    this.tail = prior.then(() => gate);
    await prior;
    try {
      return fn();
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
    this.backend.agents.set(entityKey(ctx, "agent", value.id), structuredClone(value));
  }
  async getAgent(ctx: TenantContext, id: string): Promise<Agent | undefined> {
    return structuredClone(this.backend.agents.get(entityKey(ctx, "agent", id)));
  }
  async putDevice(ctx: TenantContext, value: Device): Promise<void> {
    this.#owned(ctx, value);
    this.backend.devices.set(entityKey(ctx, "device", value.id), structuredClone(value));
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
      challenge.transactionHash !== hash || challenge.expiresAt < now
    ) return undefined;
    challenge.used = true;
    this.backend.challenges.set(key, challenge);
    return challenge;
  }
  async commitBootstrap(
    ctx: TenantContext,
    challengeId: string,
    hash: string,
    value: BootstrapCommit,
    now: number,
  ): Promise<boolean> {
    this.#owned(ctx, { ...value.principal, userId: value.principal.id });
    this.#owned(ctx, value.agent);
    this.#owned(ctx, value.device);
    return await this.backend.exclusive(() => {
      if (
        this.backend.principals.has(entityKey(ctx, "principal", ctx.userId)) ||
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
    hash: string,
    value: EnrollmentRequest,
    now: number,
  ): Promise<boolean> {
    this.#owned(ctx, value);
    return await this.backend.exclusive(() => {
      if (!this.#consumeChallenge(ctx, challengeId, hash, "enroll_candidate", now)) return false;
      const key = entityKey(ctx, "enrollment", value.id);
      if (this.backend.enrollments.has(key)) return false;
      this.backend.enrollments.set(key, structuredClone(value));
      return true;
    });
  }
  async commitApproval(
    ctx: TenantContext,
    challengeId: string,
    hash: string,
    value: ApprovalCommit,
    now: number,
  ): Promise<boolean> {
    this.#owned(ctx, value.device);
    return await this.backend.exclusive(() => {
      if (!this.#consumeChallenge(ctx, challengeId, hash, "approve_enrollment", now)) return false;
      const requestKey = entityKey(ctx, "enrollment", value.requestId);
      const request = this.backend.enrollments.get(requestKey);
      if (
        !request || request.status !== "pending" || request.expiresAt < now ||
        this.backend.devices.has(entityKey(ctx, "device", value.device.id))
      ) return false;
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
    await this.backend.exclusive(() => {
      this.#owned(ctx, {
        tenantId: value.tenantId,
        userId: kind === "principal" ? value.id : value.userId ?? "",
      });
      const key = entityKey(ctx, kind, value.id);
      const previous = map.get(key);
      if (!previous) throw new Error(`${kind} not found`);
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
      const nonceKey = replayKey(ctx, "nonce", b.nonceHash),
        jtiKey = replayKey(ctx, "jti", b.jtiHash);
      for (const [key, expiry] of this.backend.used) {
        if (expiry < b.now) this.backend.used.delete(key);
      }
      if (this.backend.used.has(nonceKey)) return { ok: false, reason: "nonce replay" };
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
        device.agentId !== b.agentId
      ) return { ok: false, reason: "device inactive" };
      if (
        !grant || grant.status !== "active" || grant.version !== b.grantVersion ||
        grant.agentId !== b.agentId || grant.deviceId !== b.deviceId ||
        grant.connectionId !== b.connectionId || grant.operation !== b.operation ||
        grant.expiresAt < b.now
      ) return { ok: false, reason: "grant inactive" };
      if (!connection || connection.status !== "active" || connection.epoch !== b.connectionEpoch) {
        return { ok: false, reason: "connection inactive" };
      }
      this.backend.used.set(nonceKey, b.nonceExpiresAt);
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

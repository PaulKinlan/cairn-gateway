// deno-lint-ignore-file require-await
import type {
  Agent,
  Connection,
  Device,
  EnrollmentRequest,
  Grant,
  Principal,
  RevocationEvent,
  TenantContext,
} from "../domain/types.ts";
import { entityKey, ownerPrefix, replayKey } from "./keys.ts";
import type { InvocationBinding, InvocationDecision, MetadataStore } from "./store.ts";

export class MemoryStore implements MetadataStore {
  #principals = new Map<string, Principal>();
  #agents = new Map<string, Agent>();
  #devices = new Map<string, Device>();
  #enrollments = new Map<string, EnrollmentRequest>();
  #connections = new Map<string, Connection>();
  #grants = new Map<string, Grant>();
  #used = new Map<string, number>();
  #revocations: RevocationEvent[] = [];
  #tail: Promise<void> = Promise.resolve();

  async #exclusive<T>(fn: () => T): Promise<T> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => release = resolve);
    const prior = this.#tail;
    this.#tail = prior.then(() => gate);
    await prior;
    try {
      return fn();
    } finally {
      release();
    }
  }
  #owned(ctx: TenantContext, value: { tenantId: string; userId: string }): void {
    if (value.tenantId !== ctx.tenantId || value.userId !== ctx.userId) {
      throw new Error("ownership denied");
    }
  }
  async putPrincipal(ctx: TenantContext, value: Principal): Promise<void> {
    this.#owned(ctx, { ...value, userId: value.id });
    this.#principals.set(entityKey(ctx, "principal", value.id), structuredClone(value));
  }
  async getPrincipal(ctx: TenantContext, id: string): Promise<Principal | undefined> {
    return structuredClone(this.#principals.get(entityKey(ctx, "principal", id)));
  }
  async putAgent(ctx: TenantContext, value: Agent): Promise<void> {
    this.#owned(ctx, value);
    this.#agents.set(entityKey(ctx, "agent", value.id), structuredClone(value));
  }
  async getAgent(ctx: TenantContext, id: string): Promise<Agent | undefined> {
    return structuredClone(this.#agents.get(entityKey(ctx, "agent", id)));
  }
  async putDevice(ctx: TenantContext, value: Device): Promise<void> {
    this.#owned(ctx, value);
    this.#devices.set(entityKey(ctx, "device", value.id), structuredClone(value));
  }
  async getDevice(ctx: TenantContext, id: string): Promise<Device | undefined> {
    return structuredClone(this.#devices.get(entityKey(ctx, "device", id)));
  }
  async listDevices(ctx: TenantContext): Promise<Device[]> {
    const prefix = `${ownerPrefix(ctx)}/device/`;
    return [...this.#devices.entries()].filter(([key]) => key.startsWith(prefix)).map(([, value]) =>
      structuredClone(value)
    );
  }
  async putEnrollment(ctx: TenantContext, value: EnrollmentRequest): Promise<void> {
    this.#owned(ctx, value);
    this.#enrollments.set(entityKey(ctx, "enrollment", value.id), structuredClone(value));
  }
  async getEnrollment(ctx: TenantContext, id: string): Promise<EnrollmentRequest | undefined> {
    return structuredClone(this.#enrollments.get(entityKey(ctx, "enrollment", id)));
  }
  async putConnection(ctx: TenantContext, value: Connection): Promise<void> {
    this.#owned(ctx, value);
    this.#connections.set(entityKey(ctx, "connection", value.id), structuredClone(value));
  }
  async getConnection(ctx: TenantContext, id: string): Promise<Connection | undefined> {
    return structuredClone(this.#connections.get(entityKey(ctx, "connection", id)));
  }
  async putGrant(ctx: TenantContext, value: Grant): Promise<void> {
    this.#owned(ctx, value);
    this.#grants.set(entityKey(ctx, "grant", value.id), structuredClone(value));
  }
  async getGrant(ctx: TenantContext, id: string): Promise<Grant | undefined> {
    return structuredClone(this.#grants.get(entityKey(ctx, "grant", id)));
  }
  async updateDevice(ctx: TenantContext, value: Device, event?: RevocationEvent): Promise<void> {
    if (!await this.getDevice(ctx, value.id)) throw new Error("device not found");
    await this.putDevice(ctx, value);
    if (event) this.#revocations.push(structuredClone(event));
  }
  async updateGrant(ctx: TenantContext, value: Grant, event?: RevocationEvent): Promise<void> {
    if (!await this.getGrant(ctx, value.id)) throw new Error("grant not found");
    await this.putGrant(ctx, value);
    if (event) this.#revocations.push(structuredClone(event));
  }
  async updateConnection(
    ctx: TenantContext,
    value: Connection,
    event?: RevocationEvent,
  ): Promise<void> {
    if (!await this.getConnection(ctx, value.id)) throw new Error("connection not found");
    await this.putConnection(ctx, value);
    if (event) this.#revocations.push(structuredClone(event));
  }
  async consumeNonce(
    ctx: TenantContext,
    nonceHash: string,
    expiresAt: number,
    now: number,
  ): Promise<boolean> {
    return await this.#exclusive(() => {
      const key = replayKey(ctx, "nonce", nonceHash);
      for (const [usedKey, expiry] of this.#used) if (expiry < now) this.#used.delete(usedKey);
      if (this.#used.has(key)) return false;
      this.#used.set(key, expiresAt);
      return true;
    });
  }
  async consumeInvocation(ctx: TenantContext, b: InvocationBinding): Promise<InvocationDecision> {
    return await this.#exclusive(() => {
      const nonceKey = replayKey(ctx, "nonce", b.nonceHash);
      const jtiKey = replayKey(ctx, "jti", b.jtiHash);
      for (const [key, expiry] of this.#used) if (expiry < b.now) this.#used.delete(key);
      if (this.#used.has(nonceKey)) return { ok: false, reason: "nonce replay" };
      if (this.#used.has(jtiKey)) return { ok: false, reason: "capability replay" };
      const device = this.#devices.get(entityKey(ctx, "device", b.deviceId));
      const grant = this.#grants.get(entityKey(ctx, "grant", b.grantId));
      const connection = this.#connections.get(entityKey(ctx, "connection", b.connectionId));
      if (!device || device.status !== "active" || device.epoch !== b.deviceEpoch) {
        return { ok: false, reason: "device inactive" };
      }
      if (
        !grant || grant.status !== "active" || grant.version !== b.grantVersion ||
        grant.deviceId !== b.deviceId || grant.connectionId !== b.connectionId ||
        grant.operation !== b.operation || grant.expiresAt < b.now
      ) {
        return { ok: false, reason: "grant inactive" };
      }
      if (!connection || connection.status !== "active" || connection.epoch !== b.connectionEpoch) {
        return { ok: false, reason: "connection inactive" };
      }
      this.#used.set(nonceKey, b.nonceExpiresAt);
      this.#used.set(jtiKey, b.jtiExpiresAt);
      return { ok: true };
    });
  }
  async revocations(ctx: TenantContext): Promise<RevocationEvent[]> {
    return structuredClone(this.#revocations.filter((event) => event.tenantId === ctx.tenantId));
  }
}

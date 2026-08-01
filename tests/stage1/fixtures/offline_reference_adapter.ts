import { serializeDurableAuthority } from "../../../packages/core/src/store/schema.ts";

export interface Owner {
  tenantId: string;
  userId: string;
}
type Subject = { status: "active" | "revoked"; version: number };
type Attempt = {
  state: "reserved" | "dispatching" | "completed" | "failed_safe" | "dispatch_unknown";
  dispatchPermitUsed: boolean;
  automaticRetry: false;
  recordVersion: number;
};
type Challenge = {
  used: boolean;
  transactionHash: string;
  expiresAt: number;
  recordVersion: number;
};
type TenantState = {
  subjects: Record<"principal" | "agent" | "device" | "grant" | "connection", Subject>;
  replay: Record<string, number>;
  attempts: Record<string, Attempt>;
  challenges: Record<string, Challenge>;
  enrollments: Record<string, { status: "pending"; recordVersion: number }>;
  connections: Record<string, { custodyRef: string; recordVersion: number }>;
};
type State = {
  format: "cairn-offline-reference";
  schemaVersion: number;
  migration: { status: "idle"; generation: number; fromVersion: number; toVersion: number };
  authorityGeneration: number;
  highWatermarks: {
    authorityGeneration: number;
    migrationGeneration: number;
    replayGeneration: number;
    revocationGeneration: number;
    schemaVersion: number;
  };
  lastNow: number;
  recordVersion: number;
  tenants: Record<string, TenantState>;
  custodyClaims: Record<string, string>;
};

const clean = (value: string): string => {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error("owner denied");
  return value;
};
const ownerKey = (owner: Owner): string => `${clean(owner.tenantId)}/${clean(owner.userId)}`;
const emptyState = (): State => ({
  format: "cairn-offline-reference",
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
  lastNow: 0,
  recordVersion: 0,
  tenants: {},
  custodyClaims: {},
});
const emptyTenant = (): TenantState => ({
  subjects: {
    principal: { status: "active", version: 1 },
    agent: { status: "active", version: 1 },
    device: { status: "active", version: 1 },
    grant: { status: "active", version: 1 },
    connection: { status: "active", version: 1 },
  },
  replay: {},
  attempts: {},
  challenges: {},
  enrollments: {},
  connections: {},
});

function assertState(value: unknown, current = true): asserts value is State {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("record denied");
  const state = value as State;
  if (
    state.format !== "cairn-offline-reference" || !Number.isSafeInteger(state.schemaVersion) ||
    (current && state.schemaVersion !== 2) || !Number.isSafeInteger(state.authorityGeneration) ||
    state.authorityGeneration < 1 || !state.highWatermarks ||
    state.highWatermarks.schemaVersion !== state.schemaVersion ||
    state.highWatermarks.authorityGeneration < state.authorityGeneration ||
    !state.migration || state.migration.status !== "idle" || !state.tenants ||
    typeof state.tenants !== "object" || !state.custodyClaims ||
    typeof state.custodyClaims !== "object"
  ) throw new Error("record denied");
  serializeDurableAuthority(state);
}

export class OfflineReferenceAuthority {
  readonly statePath: string;
  readonly lockPath: string;
  constructor(readonly root: string) {
    this.statePath = `${root}/authority.json`;
    this.lockPath = `${root}/authority.lock`;
  }

  async initialize(): Promise<void> {
    await Deno.mkdir(this.root, { recursive: true });
    try {
      await Deno.stat(this.statePath);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      await this.write(emptyState());
    }
  }

  async read(requireCurrent = true): Promise<State> {
    const text = await Deno.readTextFile(this.statePath);
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error("record denied");
    }
    assertState(value, requireCurrent);
    return value;
  }

  private async write(state: State): Promise<void> {
    const temporary = `${this.statePath}.${Deno.pid}.${crypto.randomUUID()}.tmp`;
    await Deno.writeFile(temporary, serializeDurableAuthority(state), { createNew: true });
    await Deno.rename(temporary, this.statePath);
  }

  private async locked<T>(
    operation: (state: State) => T | Promise<T>,
    requireCurrent = true,
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
      await this.write(state);
      return result;
    } finally {
      await Deno.remove(this.lockPath).catch(() => undefined);
    }
  }

  private tenant(state: State, owner: Owner): TenantState | undefined {
    return state.tenants[ownerKey(owner)];
  }

  async seed(
    owner: Owner,
    custodyRef = `custody_${owner.tenantId}_${owner.userId}`,
  ): Promise<boolean> {
    return await this.locked((state) => {
      const key = ownerKey(owner);
      if (state.tenants[key]) return false;
      const prior = state.custodyClaims[custodyRef];
      if (prior && prior !== key) return false;
      const tenant = emptyTenant();
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
    const tenant = this.tenant(state, owner);
    return structuredClone({
      exists: Boolean(tenant),
      tenant: tenant ?? null,
      schemaVersion: state.schemaVersion,
      authorityGeneration: state.authorityGeneration,
      highWatermarks: state.highWatermarks,
      lastNow: state.lastNow,
    });
  }

  async consume(
    owner: Owner,
    kind: "nonce" | "jti",
    hashes: string[],
    expiresAt: number,
    now: number,
  ): Promise<boolean> {
    return await this.locked((state) => {
      const tenant = this.tenant(state, owner);
      if (!tenant || !hashes.length || new Set(hashes).size !== hashes.length) return false;
      const effectiveNow = Math.max(state.lastNow, now);
      state.lastNow = effectiveNow;
      for (const [key, expiry] of Object.entries(tenant.replay)) {
        if (expiry < effectiveNow) delete tenant.replay[key];
      }
      const keys = hashes.map((hash) => `${kind}/${clean(hash)}`);
      if (keys.some((key) => tenant.replay[key] !== undefined)) return false;
      for (const key of keys) tenant.replay[key] = expiresAt;
      state.highWatermarks.replayGeneration++;
      state.authorityGeneration++;
      state.highWatermarks.authorityGeneration = state.authorityGeneration;
      return true;
    });
  }

  async reserve(owner: Owner, attemptId: string, now: number, suffix = attemptId): Promise<string> {
    return await this.locked((state) => {
      const tenant = this.tenant(state, owner);
      if (!tenant) return "denied";
      const effectiveNow = Math.max(state.lastNow, now);
      state.lastNow = effectiveNow;
      if (Object.values(tenant.subjects).some((subject) => subject.status !== "active")) {
        return "denied";
      }
      const keys = [`nonce/device_${suffix}`, `nonce/agent_${suffix}`, `jti/jti_${suffix}`];
      if (tenant.attempts[attemptId] || keys.some((key) => tenant.replay[key] !== undefined)) {
        return "already_consumed";
      }
      for (const key of keys) tenant.replay[key] = effectiveNow + 600;
      tenant.attempts[attemptId] = {
        state: "reserved",
        dispatchPermitUsed: false,
        automaticRetry: false,
        recordVersion: ++state.recordVersion,
      };
      state.highWatermarks.replayGeneration++;
      state.authorityGeneration++;
      state.highWatermarks.authorityGeneration = state.authorityGeneration;
      return "reserved";
    });
  }

  async beginDispatch(owner: Owner, attemptId: string): Promise<string> {
    return await this.locked((state) => {
      const attempt = this.tenant(state, owner)?.attempts[attemptId];
      if (!attempt || attempt.state !== "reserved" || attempt.dispatchPermitUsed) {
        return "already_consumed";
      }
      attempt.state = "dispatching";
      attempt.dispatchPermitUsed = true;
      attempt.recordVersion = ++state.recordVersion;
      state.authorityGeneration++;
      state.highWatermarks.authorityGeneration = state.authorityGeneration;
      return "permit";
    });
  }

  async markDispatchUnknown(owner: Owner, attemptId: string): Promise<boolean> {
    return await this.locked((state) => {
      const attempt = this.tenant(state, owner)?.attempts[attemptId];
      if (!attempt || attempt.state !== "dispatching") return false;
      attempt.state = "dispatch_unknown";
      attempt.recordVersion = ++state.recordVersion;
      state.authorityGeneration++;
      state.highWatermarks.authorityGeneration = state.authorityGeneration;
      return true;
    });
  }

  async issueChallenge(
    owner: Owner,
    id: string,
    hash: string,
    expiresAt: number,
  ): Promise<boolean> {
    return await this.locked((state) => {
      const tenant = this.tenant(state, owner);
      if (!tenant || tenant.challenges[id]) return false;
      tenant.challenges[id] = {
        used: false,
        transactionHash: hash,
        expiresAt,
        recordVersion: ++state.recordVersion,
      };
      return true;
    });
  }

  async consumeChallenge(
    owner: Owner,
    id: string,
    hash: string,
    now: number,
    enrollmentId?: string,
  ): Promise<boolean> {
    return await this.locked((state) => {
      const tenant = this.tenant(state, owner);
      const challenge = tenant?.challenges[id];
      if (
        !tenant || !challenge || challenge.used || challenge.transactionHash !== hash ||
        challenge.expiresAt <= now
      ) return false;
      if (enrollmentId && tenant.enrollments[enrollmentId]) return false;
      challenge.used = true;
      challenge.recordVersion = ++state.recordVersion;
      if (enrollmentId) {
        tenant.enrollments[enrollmentId] = {
          status: "pending",
          recordVersion: ++state.recordVersion,
        };
      }
      state.authorityGeneration++;
      state.highWatermarks.authorityGeneration = state.authorityGeneration;
      return true;
    });
  }

  async transition(
    owner: Owner,
    subjectName: keyof TenantState["subjects"],
    status: "active" | "revoked",
    version: number,
  ): Promise<boolean> {
    return await this.locked((state) => {
      const subject = this.tenant(state, owner)?.subjects[subjectName];
      if (!subject || version <= subject.version) return false;
      subject.status = status;
      subject.version = version;
      state.authorityGeneration++;
      state.highWatermarks.authorityGeneration = state.authorityGeneration;
      if (status === "revoked") state.highWatermarks.revocationGeneration++;
      return true;
    });
  }

  async writeLegacy(owner: Owner): Promise<void> {
    await this.initialize();
    await this.locked((state) => {
      state.schemaVersion = 1;
      state.highWatermarks.schemaVersion = 1;
      state.migration = { status: "idle", generation: 0, fromVersion: 1, toVersion: 1 };
      const tenant = this.tenant(state, owner);
      if (tenant) tenant.replay["nonce/legacy"] = 999;
    }, false);
  }

  async migrate(): Promise<boolean> {
    return await this.locked((state) => {
      if (state.schemaVersion !== 1) return false;
      state.schemaVersion = 2;
      state.migration = {
        status: "idle",
        generation: state.migration.generation + 1,
        fromVersion: 1,
        toVersion: 2,
      };
      state.highWatermarks.schemaVersion = 2;
      state.highWatermarks.migrationGeneration = state.migration.generation;
      state.authorityGeneration++;
      state.highWatermarks.authorityGeneration = state.authorityGeneration;
      return true;
    }, false);
  }

  async restore(candidatePath: string): Promise<boolean> {
    return await this.locked(async (current) => {
      const candidate = JSON.parse(await Deno.readTextFile(candidatePath)) as State;
      assertState(candidate);
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

  async corrupt(): Promise<void> {
    await Deno.writeTextFile(this.statePath, '{"format":"corrupt"}');
  }
}

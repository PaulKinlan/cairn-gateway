export const DURABLE_AUTHORITY_SCHEMA_VERSION = 2 as const;
export const DURABLE_AUTHORITY_MIN_SCHEMA_VERSION = 1 as const;

export type MigrationStatus = "idle" | "preparing" | "committing" | "failed";

export interface AuthorityHighWatermarks {
  authorityGeneration: number;
  migrationGeneration: number;
  replayGeneration: number;
  revocationGeneration: number;
  schemaVersion: number;
}

export interface MigrationState {
  status: MigrationStatus;
  generation: number;
  fromVersion: number;
  toVersion: number;
}

export interface DurableRecord<T = unknown> {
  tenantId: string;
  userId: string;
  recordVersion: number;
  authorityGeneration: number;
  value: T;
}

export interface DurableAuthorityEnvelope {
  schemaVersion: number;
  authorityGeneration: number;
  /** Persisted effective durable time; authorization may never observe an earlier instant. */
  effectiveNow: number;
  highWatermarks: AuthorityHighWatermarks;
  migration: MigrationState;
  records: Record<string, DurableRecord>;
}

const safe = (value: unknown, minimum = 0): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0) &&
  value >= minimum;
const plain = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const clean = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);

function ownData(value: object, expected?: readonly string[]): Record<string, PropertyDescriptor> {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string")) throw new Error("non-canonical durable value");
  const names = keys as string[];
  if (
    expected && (names.length !== expected.length || expected.some((key) => !names.includes(key)))
  ) throw new Error("durable authority shape denied");
  for (const name of names) {
    const descriptor = descriptors[name];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new Error("non-canonical durable value");
    }
  }
  return descriptors;
}

function canonicalValue(value: unknown, active: Set<object>): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0)) {
    return String(value);
  }
  if (!value || typeof value !== "object" || active.has(value)) {
    throw new Error("non-canonical durable value");
  }
  active.add(value);
  try {
    if (Array.isArray(value)) {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Reflect.ownKeys(descriptors);
      if (keys.some((key) => typeof key !== "string")) {
        throw new Error("non-canonical durable value");
      }
      const allowed = new Set([
        "length",
        ...Array.from({ length: value.length }, (_, i) => String(i)),
      ]);
      if (keys.some((key) => !allowed.has(key as string))) {
        throw new Error("non-canonical durable value");
      }
      const length = (descriptors as Record<string, PropertyDescriptor>)["length"];
      if (!length || !("value" in length) || length.value !== value.length) {
        throw new Error("non-canonical durable value");
      }
      const fields: string[] = [];
      for (let index = 0; index < value.length; index++) {
        const descriptor = descriptors[String(index)];
        if (
          !descriptor || !("value" in descriptor) || !descriptor.enumerable ||
          descriptor.value === undefined
        ) {
          throw new Error("non-canonical durable value");
        }
        fields.push(canonicalValue(descriptor.value, active));
      }
      return `[${fields.join(",")}]`;
    }
    if (!plain(value)) throw new Error("non-canonical durable value");
    const descriptors = ownData(value);
    const names = Object.keys(descriptors).sort();
    const fields: string[] = [];
    for (const name of names) {
      const descriptor = descriptors[name]!;
      if (descriptor.value === undefined) throw new Error("non-canonical durable value");
      fields.push(`${JSON.stringify(name)}:${canonicalValue(descriptor.value, active)}`);
    }
    return `{${fields.join(",")}}`;
  } finally {
    active.delete(value);
  }
}

/** Injective deterministic UTF-8 JSON for the admitted durable-value domain. */
export function serializeDurableAuthority(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalValue(value, new Set()));
}

const text = (value: unknown): string => new TextDecoder().decode(serializeDurableAuthority(value));

export async function hashDispatchPermit(value: {
  attemptId: string;
  claimVersion: number;
  authorityGeneration: number;
  token: string;
}): Promise<string> {
  ownData(value, ["attemptId", "claimVersion", "authorityGeneration", "token"]);
  if (
    !clean(value.attemptId) || !safe(value.claimVersion, 1) ||
    !safe(value.authorityGeneration, 1) || !clean(value.token)
  ) throw new Error("permit denied");
  const bytes = serializeDurableAuthority(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function assertBinding(value: unknown): asserts value is Record<string, unknown> {
  if (!plain(value)) throw new Error("durable binding denied");
  ownData(value, [
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
  ]);
  if (
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
    ].some((item) => !clean(item)) ||
    [
      value.principalEpoch,
      value.agentEpoch,
      value.deviceEpoch,
      value.grantVersion,
      value.connectionEpoch,
    ].some((item) => !safe(item, 1)) ||
    !safe(value.nonceExpiresAt, 1) || !safe(value.jtiExpiresAt, 1) || !safe(value.now) ||
    value.operation !== "github.user.read"
  ) throw new Error("durable binding denied");
}

function assertIdentity(
  kind: string,
  identity: unknown,
  tenantId: string,
  userId: string,
  id: string,
): void {
  if (kind === "principal") {
    if (!plain(identity)) throw new Error("durable identity denied");
    ownData(identity, ["id", "tenantId", "kind", "status", "emailRequired", "epoch"]);
    if (
      identity.id !== id || identity.tenantId !== tenantId || identity.kind !== "cryptographic" ||
      !["active", "disabled", "revoked"].includes(String(identity.status)) ||
      identity.emailRequired !== false || !safe(identity.epoch, 1)
    ) throw new Error("durable identity denied");
  } else if (kind === "agent") {
    if (!plain(identity)) throw new Error("durable identity denied");
    ownData(identity, ["id", "tenantId", "userId", "publicJwk", "thumbprint", "status", "epoch"]);
    if (
      identity.id !== id || identity.tenantId !== tenantId || identity.userId !== userId ||
      !plain(identity.publicJwk) || !clean(identity.thumbprint) ||
      !["active", "disabled", "revoked"].includes(String(identity.status)) ||
      !safe(identity.epoch, 1)
    ) {
      throw new Error("durable identity denied");
    }
  } else if (kind === "device") {
    if (!plain(identity)) throw new Error("durable identity denied");
    ownData(identity, [
      "id",
      "tenantId",
      "userId",
      "agentId",
      "publicJwk",
      "thumbprint",
      "role",
      "status",
      "epoch",
    ]);
    if (
      identity.id !== id || identity.tenantId !== tenantId || identity.userId !== userId ||
      !clean(identity.agentId) || !plain(identity.publicJwk) || !clean(identity.thumbprint) ||
      !["admin", "member"].includes(String(identity.role)) ||
      !["active", "disabled", "revoked"].includes(String(identity.status)) ||
      !safe(identity.epoch, 1)
    ) {
      throw new Error("durable identity denied");
    }
  } else if (identity !== null) throw new Error("durable identity denied");
  serializeDurableAuthority(identity);
}

interface ParsedRecord {
  key: string;
  tenantId: string;
  userId: string;
  kind: string;
  id: string;
  record: DurableRecord;
}

function parseRecord(key: string, record: unknown): ParsedRecord {
  const match =
    /^tenant\/([A-Za-z0-9_-]{1,128})\/user\/([A-Za-z0-9_-]{1,128})\/(subject|attempt|challenge|ceremony|enrollment|connection|custody)\/([A-Za-z0-9_-]{1,128})$/
      .exec(key) ??
      /^tenant\/([A-Za-z0-9_-]{1,128})\/user\/([A-Za-z0-9_-]{1,128})\/(replay)\/(nonce|jti)\/([A-Za-z0-9_-]{1,128})$/
        .exec(key);
  if (!match || !plain(record)) throw new Error("durable record key denied");
  ownData(record, ["tenantId", "userId", "recordVersion", "authorityGeneration", "value"]);
  const tenantId = match[1]!;
  const userId = match[2]!;
  const kind = match[3]!;
  const id = kind === "replay" ? match[5]! : match[4]!;
  if (
    record.tenantId !== tenantId || record.userId !== userId || !safe(record.recordVersion, 1) ||
    !safe(record.authorityGeneration, 1)
  ) throw new Error("durable record ownership denied");
  if (kind === "replay" && (record.value as Record<string, unknown>)?.kind !== match[4]) {
    throw new Error("durable replay denied");
  }
  return { key, tenantId, userId, kind, id, record: record as unknown as DurableRecord };
}

/** Deep validation used by adapters before authorization, migration, export, or restore. */
export function assertAuthorityEnvelope(
  value: unknown,
  requireCurrent = true,
): asserts value is DurableAuthorityEnvelope {
  if (!plain(value)) throw new Error("durable authority schema denied");
  ownData(value, [
    "schemaVersion",
    "authorityGeneration",
    "effectiveNow",
    "highWatermarks",
    "migration",
    "records",
  ]);
  const envelope = value as unknown as DurableAuthorityEnvelope;
  if (
    !safe(envelope.schemaVersion, DURABLE_AUTHORITY_MIN_SCHEMA_VERSION) ||
    envelope.schemaVersion > DURABLE_AUTHORITY_SCHEMA_VERSION ||
    (requireCurrent && envelope.schemaVersion !== DURABLE_AUTHORITY_SCHEMA_VERSION) ||
    !safe(envelope.authorityGeneration, 1) || !safe(envelope.effectiveNow) ||
    !plain(envelope.highWatermarks) || !plain(envelope.migration) || !plain(envelope.records)
  ) {
    throw new Error("durable authority schema denied");
  }
  ownData(envelope.highWatermarks, [
    "authorityGeneration",
    "migrationGeneration",
    "replayGeneration",
    "revocationGeneration",
    "schemaVersion",
  ]);
  ownData(envelope.migration, ["status", "generation", "fromVersion", "toVersion"]);
  const watermark = envelope.highWatermarks;
  if (
    !safe(watermark.authorityGeneration, 1) ||
    watermark.authorityGeneration !== envelope.authorityGeneration ||
    !safe(watermark.migrationGeneration) || !safe(watermark.replayGeneration) ||
    !safe(watermark.revocationGeneration) ||
    watermark.schemaVersion !== envelope.schemaVersion ||
    !["idle", "preparing", "committing", "failed"].includes(envelope.migration.status) ||
    !safe(envelope.migration.generation) ||
    watermark.migrationGeneration !== envelope.migration.generation ||
    !safe(envelope.migration.fromVersion, 1) || !safe(envelope.migration.toVersion, 1) ||
    (envelope.migration.status !== "idle" &&
      envelope.migration.toVersion <= envelope.migration.fromVersion) ||
    (requireCurrent &&
      (envelope.migration.status !== "idle" ||
        envelope.migration.toVersion !== envelope.schemaVersion))
  ) {
    throw new Error("durable authority schema denied");
  }

  ownData(envelope.records);
  const parsed = Object.entries(envelope.records).map(([key, record]) => parseRecord(key, record));
  const custody = new Map<string, string>();
  const connections = new Map<string, string>();
  const subjects = new Map<string, Record<string, unknown>>();
  const enrollments: Array<{ tenantId: string; userId: string; request: Record<string, unknown> }> =
    [];
  const owners = new Set<string>();
  const thumbprints = new Map<string, string>();

  for (const item of parsed) {
    const { kind, id, record, tenantId, userId, key } = item;
    owners.add(`${tenantId}/${userId}`);
    if (record.authorityGeneration > envelope.authorityGeneration || !plain(record.value)) {
      throw new Error("durable record authority denied");
    }
    const v = record.value;
    if (kind === "subject") {
      ownData(v, ["kind", "id", "status", "version", "identity"]);
      if (
        !["principal", "agent", "device", "grant", "connection"].includes(String(v.kind)) ||
        v.id !== id || !["active", "disabled", "revoked"].includes(String(v.status)) ||
        !safe(v.version, 1)
      ) {
        throw new Error("durable subject denied");
      }
      assertIdentity(String(v.kind), v.identity, tenantId, userId, id);
      if (plain(v.identity) && (v.identity.status !== v.status || v.identity.epoch !== v.version)) {
        throw new Error("durable subject identity denied");
      }
      subjects.set(`${tenantId}/${userId}/${v.kind}/${id}`, v);
      if (plain(v.identity) && clean(v.identity.thumbprint)) {
        const scopedThumbprint = `${tenantId}/${userId}/${v.identity.thumbprint}`;
        const owner = thumbprints.get(scopedThumbprint);
        if (owner && owner !== key) throw new Error("duplicate identity thumbprint denied");
        thumbprints.set(scopedThumbprint, key);
      }
    } else if (kind === "replay") {
      ownData(v, ["kind", "hash", "expiresAt", "generation"]);
      if (
        !["nonce", "jti"].includes(String(v.kind)) || v.hash !== id || !safe(v.expiresAt, 1) ||
        !safe(v.generation, 1) || v.generation > watermark.replayGeneration
      ) throw new Error("durable replay denied");
    } else if (kind === "attempt") {
      ownData(v, [
        "attemptId",
        "state",
        "binding",
        "replayKeys",
        "claimVersion",
        "permitHash",
        "permitAuthorityGeneration",
        "dispatchStarted",
        "dispatchStarts",
        "result",
      ]);
      assertBinding(v.binding);
      const binding = v.binding;
      if (
        v.attemptId !== id || binding.attemptId !== id ||
        !["reserved", "dispatching", "completed", "failed_safe", "dispatch_unknown"].includes(
          String(v.state),
        ) ||
        !Array.isArray(v.replayKeys) || v.replayKeys.length !== 3 ||
        new Set(v.replayKeys).size !== 3 ||
        v.replayKeys.some((replayKey) =>
          typeof replayKey !== "string" || !envelope.records[replayKey] ||
          !replayKey.startsWith(`tenant/${tenantId}/user/${userId}/replay/`)
        ) ||
        !safe(v.claimVersion) || !(v.permitHash === null || clean(v.permitHash)) ||
        !(v.permitAuthorityGeneration === null || safe(v.permitAuthorityGeneration, 1)) ||
        typeof v.dispatchStarted !== "boolean" || !safe(v.dispatchStarts) || v.dispatchStarts > 1 ||
        v.dispatchStarted !== (v.dispatchStarts === 1)
      ) throw new Error("durable attempt denied");
      const expectedReplay = new Map([
        [`nonce/${binding.deviceNonceHash}`, "nonce"],
        [`nonce/${binding.agentNonceHash}`, "nonce"],
        [`jti/${binding.jtiHash}`, "jti"],
      ]);
      for (const replayRecordKey of v.replayKeys as string[]) {
        const replay = envelope.records[replayRecordKey]!;
        const rv = replay.value as Record<string, unknown>;
        const relative = replayRecordKey.split("/replay/")[1]!;
        if (!expectedReplay.has(relative) || rv.kind !== expectedReplay.get(relative)) {
          throw new Error("durable attempt replay denied");
        }
      }
      const noPermit = v.permitHash === null && v.permitAuthorityGeneration === null &&
        v.claimVersion === 0;
      const hasPermit = clean(v.permitHash) && safe(v.permitAuthorityGeneration, 1) &&
        v.claimVersion === 1 &&
        v.permitAuthorityGeneration <= envelope.authorityGeneration;
      if (
        (v.state === "reserved" && (!noPermit || v.dispatchStarted || v.result !== null)) ||
        (v.state === "dispatching" && (!hasPermit || v.result !== null)) ||
        (v.state === "completed" && (!hasPermit || !v.dispatchStarted)) ||
        (v.state === "dispatch_unknown" && !hasPermit) ||
        (v.state === "failed_safe" && !(noPermit || hasPermit))
      ) throw new Error("durable attempt state denied");
      if (["reserved", "dispatching"].includes(String(v.state))) {
        if (v.result !== null) throw new Error("durable attempt result denied");
      } else {
        if (!plain(v.result) || v.result.outcome !== v.state) {
          throw new Error("durable attempt result denied");
        }
        if (v.state === "completed") {
          ownData(v.result, ["outcome", "resultHash"]);
          if (!clean(v.result.resultHash)) throw new Error("durable attempt result denied");
        } else if (v.state === "failed_safe") {
          ownData(v.result, ["outcome", "reason"]);
          if (!clean(v.result.reason)) throw new Error("durable attempt result denied");
        } else ownData(v.result, ["outcome"]);
      }
    } else if (kind === "challenge") {
      ownData(v, ["id", "tenantId", "userId", "purpose", "transactionHash", "expiresAt", "used"]);
      if (
        v.id !== id || v.tenantId !== tenantId || v.userId !== userId ||
        !["bootstrap", "enroll_candidate", "approve_enrollment", "remove_device"].includes(
          String(v.purpose),
        ) ||
        !clean(v.transactionHash) || !safe(v.expiresAt, 1) || typeof v.used !== "boolean"
      ) throw new Error("durable challenge denied");
    } else if (kind === "ceremony") {
      ownData(v, ["challengeId", "kind"]);
      if (
        v.challengeId !== id ||
        !["bootstrap", "enrollment", "approval", "removal"].includes(String(v.kind))
      ) {
        throw new Error("durable ceremony denied");
      }
      const challenge = envelope.records[`tenant/${tenantId}/user/${userId}/challenge/${id}`];
      const challengeValue = challenge?.value as Record<string, unknown> | undefined;
      const expected = {
        bootstrap: "bootstrap",
        enroll_candidate: "enrollment",
        approve_enrollment: "approval",
        remove_device: "removal",
      }[String(challengeValue?.purpose)];
      if (!challenge || challengeValue?.used !== true || v.kind !== expected) {
        throw new Error("durable ceremony challenge denied");
      }
    } else if (kind === "enrollment") {
      ownData(v, ["request"]);
      if (!plain(v.request)) throw new Error("durable enrollment denied");
      ownData(v.request, [
        "id",
        "tenantId",
        "userId",
        "agentId",
        "candidateJwk",
        "thumbprint",
        "status",
        "expiresAt",
      ]);
      if (
        v.request.id !== id || v.request.tenantId !== tenantId || v.request.userId !== userId ||
        !clean(v.request.agentId) ||
        !plain(v.request.candidateJwk) || !clean(v.request.thumbprint) ||
        !["pending", "approved", "rejected"].includes(String(v.request.status)) ||
        !safe(v.request.expiresAt, 1)
      ) {
        throw new Error("durable enrollment denied");
      }
      enrollments.push({ tenantId, userId, request: v.request });
    } else if (kind === "connection") {
      ownData(v, ["id", "custodyReferenceHash"]);
      if (v.id !== id || !clean(v.custodyReferenceHash)) {
        throw new Error("durable connection denied");
      }
      connections.set(key, v.custodyReferenceHash);
    } else if (kind === "custody") {
      ownData(v, ["custodyReferenceHash", "owner", "connectionId"]);
      const owner = `tenant/${tenantId}/user/${userId}`;
      if (
        v.custodyReferenceHash !== id || v.owner !== owner || !clean(v.connectionId) ||
        custody.has(id)
      ) {
        throw new Error("durable custody denied");
      }
      custody.set(id, `${owner}/connection/${v.connectionId}`);
    }
  }

  for (const [connectionKey, custodyHash] of connections) {
    const item = parsed.find((candidate) => candidate.key === connectionKey)!;
    if (custody.get(custodyHash) !== connectionKey) {
      throw new Error("connection custody relation denied");
    }
    if (!subjects.has(`${item.tenantId}/${item.userId}/connection/${item.id}`)) {
      throw new Error("connection subject denied");
    }
  }
  for (const connectionKey of custody.values()) {
    if (!connections.has(connectionKey)) throw new Error("custody connection relation denied");
  }
  for (const [subjectKey, subject] of subjects) {
    if (subject.kind === "agent") continue;
    if (subject.kind === "device") {
      const identity = subject.identity as Record<string, unknown>;
      const [tenantId, userId] = subjectKey.split("/");
      if (!subjects.has(`${tenantId}/${userId}/agent/${identity.agentId}`)) {
        throw new Error("device agent relation denied");
      }
    }
  }
  for (const owner of owners) {
    const userId = owner.split("/")[1]!;
    if (
      !subjects.has(`${owner}/principal/${userId}`) ||
      ![...subjects.keys()].some((item) => item.startsWith(`${owner}/agent/`))
    ) {
      throw new Error("owner identity relation denied");
    }
  }
  for (const { tenantId, userId, request } of enrollments) {
    const agent = subjects.get(`${tenantId}/${userId}/agent/${request.agentId}`);
    if (!agent || agent.status !== "active") throw new Error("enrollment agent relation denied");
    if (request.status === "approved") {
      const approved = [...subjects.values()].find((item) =>
        item.kind === "device" &&
        plain(item.identity) && item.identity.tenantId === tenantId &&
        item.identity.userId === userId &&
        item.identity.thumbprint === request.thumbprint && item.status === "active"
      );
      if (!approved) throw new Error("approved enrollment device relation denied");
    }
  }
  serializeDurableAuthority(envelope);
}

export function assertCurrentEnvelope(value: DurableAuthorityEnvelope): void {
  assertAuthorityEnvelope(value, true);
}

export const sameDurableValue = (left: unknown, right: unknown): boolean =>
  text(left) === text(right);

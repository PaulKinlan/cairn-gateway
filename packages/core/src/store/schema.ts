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
  highWatermarks: AuthorityHighWatermarks;
  migration: MigrationState;
  records: Record<string, DurableRecord>;
}

const safe = (value: unknown, minimum = 0): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
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
  ) {
    throw new Error("durable authority shape denied");
  }
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
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
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
        ) throw new Error("non-canonical durable value");
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

function assertRecordValue(
  kind: string,
  id: string,
  record: DurableRecord,
  envelope: DurableAuthorityEnvelope,
  custody: Set<string>,
): void {
  const value = record.value;
  if (!plain(value)) throw new Error("durable record value denied");
  if (kind === "subject") {
    ownData(value, ["kind", "id", "status", "version"]);
    if (
      !["principal", "agent", "device", "grant", "connection"].includes(String(value.kind)) ||
      value.id !== id || !["active", "disabled", "revoked"].includes(String(value.status)) ||
      !safe(value.version, 1)
    ) throw new Error("durable subject denied");
  } else if (kind === "replay") {
    ownData(value, ["kind", "hash", "expiresAt", "generation"]);
    if (
      !["nonce", "jti"].includes(String(value.kind)) || value.hash !== id ||
      !safe(value.expiresAt, 1) || !safe(value.generation, 1) ||
      value.generation > envelope.highWatermarks.replayGeneration
    ) {
      throw new Error("durable replay denied");
    }
  } else if (kind === "attempt") {
    ownData(value, [
      "attemptId",
      "state",
      "replayKeys",
      "dispatchPermitUsed",
      "claimVersion",
      "result",
    ]);
    if (
      value.attemptId !== id ||
      !["reserved", "dispatching", "completed", "failed_safe", "dispatch_unknown"].includes(
        String(value.state),
      ) || !Array.isArray(value.replayKeys) || !value.replayKeys.length ||
      value.replayKeys.some((key) => typeof key !== "string" || !envelope.records[key]) ||
      typeof value.dispatchPermitUsed !== "boolean" || !safe(value.claimVersion, 0) ||
      (value.state === "reserved" &&
        (value.dispatchPermitUsed || value.claimVersion !== 0 || value.result !== null)) ||
      (value.state === "dispatching" &&
        (!value.dispatchPermitUsed || value.claimVersion < 1 || value.result !== null)) ||
      (["completed", "dispatch_unknown"].includes(String(value.state)) &&
        (!value.dispatchPermitUsed || value.claimVersion < 1)) ||
      (["completed", "failed_safe", "dispatch_unknown"].includes(String(value.state)) &&
        (!plain(value.result) || value.result.outcome !== value.state))
    ) throw new Error("durable attempt denied");
    if (value.state === "completed") {
      ownData(value.result as Record<string, unknown>, ["outcome", "resultHash"]);
      if (!clean((value.result as Record<string, unknown>).resultHash)) {
        throw new Error("durable attempt result denied");
      }
    } else if (value.state === "failed_safe") {
      ownData(value.result as Record<string, unknown>, ["outcome", "reason"]);
      if (!clean((value.result as Record<string, unknown>).reason)) {
        throw new Error("durable attempt result denied");
      }
    } else if (value.state === "dispatch_unknown") {
      ownData(value.result as Record<string, unknown>, ["outcome"]);
    }
  } else if (kind === "challenge") {
    ownData(value, ["id", "tenantId", "userId", "purpose", "transactionHash", "expiresAt", "used"]);
    if (
      value.id !== id || value.tenantId !== record.tenantId || value.userId !== record.userId ||
      !["bootstrap", "enroll_candidate", "approve_enrollment", "remove_device"].includes(
        String(value.purpose),
      ) || !clean(value.transactionHash) || !safe(value.expiresAt, 1) ||
      typeof value.used !== "boolean"
    ) throw new Error("durable challenge denied");
  } else if (kind === "custody") {
    ownData(value, ["custodyReferenceHash", "owner"]);
    const owner = `tenant/${record.tenantId}/user/${record.userId}`;
    if (value.custodyReferenceHash !== id || value.owner !== owner || custody.has(id)) {
      throw new Error("durable custody denied");
    }
    custody.add(id);
  } else throw new Error("durable record kind denied");
}

/** Deep validation used by adapters before authorization or restore. */
export function assertAuthorityEnvelope(
  value: unknown,
  requireCurrent = true,
): asserts value is DurableAuthorityEnvelope {
  if (!plain(value)) throw new Error("durable authority schema denied");
  ownData(value, [
    "schemaVersion",
    "authorityGeneration",
    "highWatermarks",
    "migration",
    "records",
  ]);
  const envelope = value as unknown as DurableAuthorityEnvelope;
  if (
    !safe(envelope.schemaVersion, DURABLE_AUTHORITY_MIN_SCHEMA_VERSION) ||
    envelope.schemaVersion > DURABLE_AUTHORITY_SCHEMA_VERSION ||
    (requireCurrent && envelope.schemaVersion !== DURABLE_AUTHORITY_SCHEMA_VERSION) ||
    !safe(envelope.authorityGeneration, 1) || !plain(envelope.highWatermarks) ||
    !plain(envelope.migration) || !plain(envelope.records)
  ) throw new Error("durable authority schema denied");
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
    !safe(watermark.revocationGeneration) || watermark.schemaVersion !== envelope.schemaVersion ||
    !["idle", "preparing", "committing", "failed"].includes(envelope.migration.status) ||
    !safe(envelope.migration.generation) ||
    watermark.migrationGeneration !== envelope.migration.generation ||
    !safe(envelope.migration.fromVersion, 1) || !safe(envelope.migration.toVersion, 1) ||
    (requireCurrent && (envelope.migration.status !== "idle" ||
      envelope.migration.toVersion !== envelope.schemaVersion))
  ) throw new Error("durable authority schema denied");
  ownData(envelope.records);
  const custody = new Set<string>();
  for (const [key, record] of Object.entries(envelope.records)) {
    const match =
      /^tenant\/([A-Za-z0-9_-]{1,128})\/user\/([A-Za-z0-9_-]{1,128})\/(subject|replay|attempt|challenge|custody)\/([A-Za-z0-9_-]{1,128})$/
        .exec(key);
    if (!match || !plain(record)) throw new Error("durable record key denied");
    ownData(record, ["tenantId", "userId", "recordVersion", "authorityGeneration", "value"]);
    const [, tenantId, userId, kind, id] = match;
    if (
      record.tenantId !== tenantId || record.userId !== userId || !safe(record.recordVersion, 1) ||
      !safe(record.authorityGeneration, 1) ||
      record.authorityGeneration > envelope.authorityGeneration
    ) {
      throw new Error("durable record ownership denied");
    }
    assertRecordValue(kind!, id!, record, envelope, custody);
  }
  serializeDurableAuthority(envelope);
}

export function assertCurrentEnvelope(value: DurableAuthorityEnvelope): void {
  assertAuthorityEnvelope(value, true);
}

export const DURABLE_AUTHORITY_SCHEMA_VERSION = 2 as const;
export const DURABLE_AUTHORITY_MIN_SCHEMA_VERSION = 1 as const;

export type MigrationStatus = "idle" | "preparing" | "committing" | "failed";

/** Monotonic values are stored independently from mutable subject records and snapshots. */
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
      return `[${value.map((item) => canonicalValue(item, active)).join(",")}]`;
    }
    if (
      Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null
    ) {
      throw new Error("non-canonical durable value");
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== "string")) {
      throw new Error("non-canonical durable value");
    }
    const names = (keys as string[]).sort();
    const fields: string[] = [];
    for (const name of names) {
      const descriptor = descriptors[name];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw new Error("non-canonical durable value");
      }
      if (descriptor.value === undefined) throw new Error("non-canonical durable value");
      fields.push(`${JSON.stringify(name)}:${canonicalValue(descriptor.value, active)}`);
    }
    return `{${fields.join(",")}}`;
  } finally {
    active.delete(value);
  }
}

/** Deterministic UTF-8 JSON representation; never depends on an adapter's object prototypes. */
export function serializeDurableAuthority(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalValue(value, new Set()));
}

export function assertCurrentEnvelope(value: DurableAuthorityEnvelope): void {
  const watermark = value.highWatermarks;
  if (
    value.schemaVersion !== DURABLE_AUTHORITY_SCHEMA_VERSION ||
    value.migration.status !== "idle" || watermark.schemaVersion !== value.schemaVersion ||
    !Number.isSafeInteger(value.authorityGeneration) || value.authorityGeneration < 1 ||
    watermark.authorityGeneration < value.authorityGeneration ||
    watermark.migrationGeneration < value.migration.generation ||
    [
      watermark.authorityGeneration,
      watermark.migrationGeneration,
      watermark.replayGeneration,
      watermark.revocationGeneration,
      watermark.schemaVersion,
    ].some((item) => !Number.isSafeInteger(item) || item < 0)
  ) throw new Error("durable authority schema denied");
  serializeDurableAuthority(value);
}

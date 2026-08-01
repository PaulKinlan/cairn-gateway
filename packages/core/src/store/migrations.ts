import {
  assertCurrentEnvelope,
  DURABLE_AUTHORITY_MIN_SCHEMA_VERSION,
  DURABLE_AUTHORITY_SCHEMA_VERSION,
  type DurableAuthorityEnvelope,
  serializeDurableAuthority,
} from "./schema.ts";

export interface AuthorityMigration {
  fromVersion: number;
  toVersion: number;
  migrate(value: DurableAuthorityEnvelope): DurableAuthorityEnvelope;
}

/** Pure migration planning. Persist preparing/result/idle as separate adapter-atomic commits. */
export function migrateAuthorityEnvelope(
  input: DurableAuthorityEnvelope,
  migrations: readonly AuthorityMigration[],
): DurableAuthorityEnvelope {
  if (
    !Number.isSafeInteger(input.schemaVersion) ||
    input.schemaVersion < DURABLE_AUTHORITY_MIN_SCHEMA_VERSION ||
    input.schemaVersion > DURABLE_AUTHORITY_SCHEMA_VERSION
  ) throw new Error("authority schema unavailable");
  let value = structuredClone(input);
  while (value.schemaVersion < DURABLE_AUTHORITY_SCHEMA_VERSION) {
    const migration = migrations.find((item) => item.fromVersion === value.schemaVersion);
    if (!migration || migration.toVersion !== migration.fromVersion + 1) {
      throw new Error("authority migration unavailable");
    }
    const before = structuredClone(value.highWatermarks);
    value = migration.migrate(value);
    if (
      value.schemaVersion !== migration.toVersion ||
      value.authorityGeneration < input.authorityGeneration ||
      value.highWatermarks.authorityGeneration < before.authorityGeneration ||
      value.highWatermarks.replayGeneration < before.replayGeneration ||
      value.highWatermarks.revocationGeneration < before.revocationGeneration ||
      value.highWatermarks.migrationGeneration <= before.migrationGeneration ||
      value.highWatermarks.schemaVersion !== value.schemaVersion
    ) throw new Error("non-monotonic authority migration");
    serializeDurableAuthority(value);
  }
  assertCurrentEnvelope(value);
  return value;
}

export function assertRestoreNotStale(
  candidate: DurableAuthorityEnvelope,
  current: DurableAuthorityEnvelope,
): void {
  const dimensions = [
    "authorityGeneration",
    "migrationGeneration",
    "replayGeneration",
    "revocationGeneration",
    "schemaVersion",
  ] as const;
  if (dimensions.some((key) => candidate.highWatermarks[key] < current.highWatermarks[key])) {
    throw new Error("stale authority restore denied");
  }
  assertCurrentEnvelope(candidate);
}

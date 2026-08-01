import {
  assertAuthorityEnvelope,
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

/** Pure migration planning. Adapters persist preparing, committing, and idle as separate CAS commits. */
export function migrateAuthorityEnvelope(
  input: DurableAuthorityEnvelope,
  migrations: readonly AuthorityMigration[],
): DurableAuthorityEnvelope {
  assertAuthorityEnvelope(input, false);
  if (
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
    const beforeRecords = structuredClone(value.records);
    value = migration.migrate(value);
    if (
      value.schemaVersion !== migration.toVersion ||
      value.authorityGeneration < input.authorityGeneration ||
      value.highWatermarks.authorityGeneration < before.authorityGeneration ||
      value.highWatermarks.replayGeneration < before.replayGeneration ||
      value.highWatermarks.revocationGeneration < before.revocationGeneration ||
      value.highWatermarks.migrationGeneration <= before.migrationGeneration ||
      value.highWatermarks.schemaVersion !== value.schemaVersion ||
      Object.keys(beforeRecords).some((key) => !value.records[key])
    ) throw new Error("non-monotonic authority migration");
    serializeDurableAuthority(value);
  }
  assertCurrentEnvelope(value);
  return value;
}

/**
 * Rejects envelope, watermark, record-version, deletion, ownership, and equal-version payload
 * rollback. Restore is monotonic per record, not merely by copied envelope watermarks.
 */
export function assertRestoreNotStale(
  candidate: DurableAuthorityEnvelope,
  current: DurableAuthorityEnvelope,
): void {
  assertCurrentEnvelope(current);
  assertCurrentEnvelope(candidate);
  const dimensions = [
    "authorityGeneration",
    "migrationGeneration",
    "replayGeneration",
    "revocationGeneration",
    "schemaVersion",
  ] as const;
  if (
    candidate.authorityGeneration < current.authorityGeneration ||
    dimensions.some((key) => candidate.highWatermarks[key] < current.highWatermarks[key])
  ) {
    throw new Error("stale authority restore denied");
  }
  for (const [key, currentRecord] of Object.entries(current.records)) {
    const candidateRecord = candidate.records[key];
    if (
      !candidateRecord || candidateRecord.tenantId !== currentRecord.tenantId ||
      candidateRecord.userId !== currentRecord.userId ||
      candidateRecord.recordVersion < currentRecord.recordVersion ||
      candidateRecord.authorityGeneration < currentRecord.authorityGeneration
    ) {
      throw new Error("stale authority record restore denied");
    }
    if (
      candidateRecord.recordVersion === currentRecord.recordVersion &&
      new TextDecoder().decode(serializeDurableAuthority(candidateRecord)) !==
        new TextDecoder().decode(serializeDurableAuthority(currentRecord))
    ) {
      throw new Error("copied-watermark payload rollback denied");
    }
  }
}

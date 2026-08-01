import {
  assertAuthorityEnvelope,
  assertCurrentEnvelope,
  DURABLE_AUTHORITY_MIN_SCHEMA_VERSION,
  DURABLE_AUTHORITY_SCHEMA_VERSION,
  type DurableAuthorityEnvelope,
  sameDurableValue,
  serializeDurableAuthority,
} from "./schema.ts";

export interface AuthorityMigration {
  fromVersion: number;
  toVersion: number;
  migrate(value: DurableAuthorityEnvelope): DurableAuthorityEnvelope;
}

const subjectStatus = (record: { value: unknown }): string | undefined => {
  const value = record.value as Record<string, unknown>;
  return value?.kind &&
      ["principal", "agent", "device", "grant", "connection"].includes(String(value.kind))
    ? String(value.status)
    : undefined;
};

function assertRecordsMonotonic(
  candidate: DurableAuthorityEnvelope,
  current: DurableAuthorityEnvelope,
  message: string,
): void {
  for (const [key, currentRecord] of Object.entries(current.records)) {
    const candidateRecord = candidate.records[key];
    if (
      !candidateRecord || candidateRecord.tenantId !== currentRecord.tenantId ||
      candidateRecord.userId !== currentRecord.userId ||
      candidateRecord.recordVersion < currentRecord.recordVersion ||
      candidateRecord.authorityGeneration < currentRecord.authorityGeneration
    ) throw new Error(message);
    if (
      candidateRecord.recordVersion === currentRecord.recordVersion &&
      !sameDurableValue(candidateRecord.value, currentRecord.value)
    ) {
      throw new Error("changed durable payload at equal version denied");
    }
    const beforeStatus = subjectStatus(currentRecord);
    const afterStatus = subjectStatus(candidateRecord);
    if (
      beforeStatus && afterStatus &&
      ((beforeStatus === "revoked" && afterStatus !== "revoked") ||
        (beforeStatus === "disabled" && afterStatus === "active"))
    ) {
      throw new Error("forbidden authority status transition");
    }
  }
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
    const before = structuredClone(value);
    value = migration.migrate(value);
    if (
      value.schemaVersion !== migration.toVersion ||
      value.authorityGeneration < before.authorityGeneration ||
      value.effectiveNow < before.effectiveNow ||
      value.highWatermarks.authorityGeneration < before.highWatermarks.authorityGeneration ||
      value.highWatermarks.replayGeneration < before.highWatermarks.replayGeneration ||
      value.highWatermarks.revocationGeneration < before.highWatermarks.revocationGeneration ||
      value.highWatermarks.migrationGeneration <= before.highWatermarks.migrationGeneration ||
      value.highWatermarks.schemaVersion !== value.schemaVersion
    ) throw new Error("non-monotonic authority migration");
    assertRecordsMonotonic(value, before, "non-monotonic authority migration record");
    serializeDurableAuthority(value);
  }
  assertCurrentEnvelope(value);
  return value;
}

/** Restore comparison includes durable time and every authority-bearing record. */
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
    candidate.effectiveNow < current.effectiveNow ||
    dimensions.some((key) => candidate.highWatermarks[key] < current.highWatermarks[key])
  ) {
    throw new Error("stale authority restore denied");
  }
  assertRecordsMonotonic(candidate, current, "stale authority record restore denied");
}

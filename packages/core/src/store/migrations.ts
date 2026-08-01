import {
  assertAuthorityEnvelope,
  assertCurrentEnvelope,
  DURABLE_AUTHORITY_MIN_SCHEMA_VERSION,
  DURABLE_AUTHORITY_SCHEMA_VERSION,
  type DurableAuthorityEnvelope,
  sameDurableValue,
  serializeDurableAuthority,
} from "./schema.ts";
import {
  authorityObjectEntries,
  authorityObjectValues,
  authorityStructuredClone,
} from "./intrinsics.ts";

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

const data = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;

function withoutFields(value: unknown, fields: readonly string[]): unknown {
  const copy = authorityStructuredClone(value) as Record<string, unknown>;
  for (const field of fields) delete copy[field];
  return copy;
}

function assertSemanticMonotonic(currentValue: unknown, candidateValue: unknown): void {
  const before = data(currentValue);
  const after = data(candidateValue);
  if (typeof before.kind === "string" && subjectStatus({ value: before })) {
    if (after.kind !== before.kind || after.id !== before.id) throw new Error("subject changed");
    if (
      Number(after.version) < Number(before.version) ||
      (after.status !== before.status && Number(after.version) <= Number(before.version))
    ) throw new Error("subject version rollback");
    const beforeMetadata = data(before.identity);
    const afterMetadata = data(after.identity);
    const versionField = before.kind === "grant" ? "version" : "epoch";
    if (Number(afterMetadata[versionField]) < Number(beforeMetadata[versionField])) {
      throw new Error("identity epoch rollback");
    }
    if (
      !sameDurableValue(
        withoutFields(beforeMetadata, ["status", versionField]),
        withoutFields(afterMetadata, ["status", versionField]),
      )
    ) throw new Error("authority relationship mutation denied");
    return;
  }
  if (typeof before.attemptId === "string" && "binding" in before) {
    if (
      after.attemptId !== before.attemptId ||
      !sameDurableValue(after.binding, before.binding) ||
      !sameDurableValue(after.replayKeys, before.replayKeys)
    ) throw new Error("attempt ownership mutation denied");
    const terminal = new Set(["completed", "failed_safe", "dispatch_unknown"]);
    const priorState = String(before.state);
    const nextState = String(after.state);
    if (
      (priorState === "reserved" &&
        !["reserved", "dispatching", ...terminal].includes(nextState)) ||
      (priorState === "dispatching" && !["dispatching", ...terminal].includes(nextState)) ||
      (terminal.has(priorState) && nextState !== priorState)
    ) throw new Error("attempt state rollback denied");
    if (
      Number(after.claimVersion) < Number(before.claimVersion) ||
      Number(after.dispatchStarts) < Number(before.dispatchStarts) ||
      (before.dispatchStarted === true && after.dispatchStarted !== true) ||
      (before.permitHash !== null && after.permitHash !== before.permitHash) ||
      (before.permitAuthorityGeneration !== null &&
        after.permitAuthorityGeneration !== before.permitAuthorityGeneration) ||
      (terminal.has(priorState) && !sameDurableValue(after.result, before.result))
    ) throw new Error("attempt authority rollback denied");
    return;
  }
  if (typeof before.purpose === "string" && typeof before.transactionHash === "string") {
    if (
      !sameDurableValue(
        withoutFields(before, ["used"]),
        withoutFields(after, ["used"]),
      ) || (before.used === true && after.used !== true)
    ) throw new Error("challenge rollback denied");
    return;
  }
  if (before.kind === "nonce" || before.kind === "jti") {
    if (!sameDurableValue(before, after)) throw new Error("replay rollback denied");
    return;
  }
  if (typeof before.challengeId === "string") {
    if (!sameDurableValue(before, after)) throw new Error("ceremony rollback denied");
    return;
  }
  if (before.request) {
    const priorRequest = data(before.request);
    const nextRequest = data(after.request);
    const terminal = priorRequest.status === "approved" || priorRequest.status === "rejected";
    if (
      !sameDurableValue(
        withoutFields(priorRequest, ["status"]),
        withoutFields(nextRequest, ["status"]),
      ) || (terminal && nextRequest.status !== priorRequest.status) ||
      (priorRequest.status === "pending" &&
        !["pending", "approved", "rejected"].includes(String(nextRequest.status))) ||
      (before.approvedDeviceId !== null && after.approvedDeviceId !== before.approvedDeviceId)
    ) throw new Error("enrollment rollback denied");
    return;
  }
  // Custody and connection linkage records are immutable once established.
  if (!sameDurableValue(before, after)) throw new Error("durable ownership mutation denied");
}

function assertRecordsMonotonic(
  candidate: DurableAuthorityEnvelope,
  current: DurableAuthorityEnvelope,
  message: string,
): void {
  for (const [key, currentRecord] of authorityObjectEntries(current.records)) {
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
    assertSemanticMonotonic(currentRecord.value, candidateRecord.value);
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
  let value = authorityStructuredClone(input);
  while (value.schemaVersion < DURABLE_AUTHORITY_SCHEMA_VERSION) {
    const migration = migrations.find((item) => item.fromVersion === value.schemaVersion);
    if (!migration || migration.toVersion !== migration.fromVersion + 1) {
      throw new Error("authority migration unavailable");
    }
    const before = authorityStructuredClone(value);
    value = migration.migrate(value);
    if (
      value.schemaVersion !== migration.toVersion ||
      value.authorityGeneration < before.authorityGeneration ||
      value.effectiveNow < before.effectiveNow ||
      value.highWatermarks.authorityGeneration < before.highWatermarks.authorityGeneration ||
      value.highWatermarks.replayGeneration < before.highWatermarks.replayGeneration ||
      value.highWatermarks.revocationGeneration < before.highWatermarks.revocationGeneration ||
      value.highWatermarks.migrationGeneration <= before.highWatermarks.migrationGeneration ||
      value.highWatermarks.schemaVersion !== value.schemaVersion ||
      value.migration.generation < before.migration.generation
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
    candidate.migration.generation < current.migration.generation ||
    dimensions.some((key) => candidate.highWatermarks[key] < current.highWatermarks[key])
  ) {
    throw new Error("stale authority restore denied");
  }
  assertRecordsMonotonic(candidate, current, "stale authority record restore denied");
}

/**
 * A tenant-scoped restore compares only that owner partition. Schema and global watermarks remain
 * controlled by the current envelope and are never imported from the tenant snapshot.
 */
export function assertTenantRestoreNotStale(
  candidate: DurableAuthorityEnvelope,
  current: DurableAuthorityEnvelope,
  tenantId: string,
  userId: string,
): void {
  assertCurrentEnvelope(current);
  assertCurrentEnvelope(candidate);
  const candidateRecords = authorityObjectValues(candidate.records);
  if (
    candidateRecords.some((record) => record.tenantId !== tenantId || record.userId !== userId) ||
    candidateRecords.some((record) => record.authorityGeneration > current.authorityGeneration)
  ) {
    throw new Error("tenant restore ownership denied");
  }
  const prefix = `tenant/${tenantId}/user/${userId}/`;
  const currentPartition = authorityStructuredClone(current);
  currentPartition.records = {};
  for (const [key, record] of authorityObjectEntries(current.records)) {
    if (key.startsWith(prefix)) currentPartition.records[key] = record;
  }
  const candidatePartition = authorityStructuredClone(candidate);
  candidatePartition.authorityGeneration = current.authorityGeneration;
  candidatePartition.effectiveNow = current.effectiveNow;
  candidatePartition.highWatermarks = authorityStructuredClone(current.highWatermarks);
  candidatePartition.migration = authorityStructuredClone(current.migration);
  assertRecordsMonotonic(
    candidatePartition,
    currentPartition,
    "stale tenant authority record restore denied",
  );
}

import type { EnrollmentChallenge, TenantContext } from "../domain/types.ts";
import type {
  ApprovalCommit,
  BootstrapCommit,
  EnrollmentRequestCommit,
  InvocationBinding,
  RemovalCommit,
} from "./store.ts";
import type { DurableAuthorityEnvelope } from "./schema.ts";

export type AtomicAuthorityResult =
  | { outcome: "committed"; authorityGeneration: number; recordVersion: number }
  | { outcome: "denied"; reason: string };

export interface ChallengeCreationTransaction {
  challenge: EnrollmentChallenge;
  expectedAbsent: true;
  now: number;
}

export interface ChallengeTransaction {
  challengeId: string;
  purpose: "bootstrap" | "enroll_candidate" | "approve_enrollment" | "remove_device";
  now: number;
  mutation:
    | { kind: "bootstrap"; value: BootstrapCommit }
    | { kind: "enrollment"; value: EnrollmentRequestCommit }
    | { kind: "approval"; value: ApprovalCommit }
    | { kind: "removal"; value: RemovalCommit };
}

export interface ReplayTransaction {
  records: readonly [
    { kind: "nonce" | "jti"; hash: string },
    ...Array<{ kind: "nonce" | "jti"; hash: string }>,
  ];
  expiresAt: number;
  now: number;
}

export interface AuthorityTransition {
  subjectType: "principal" | "agent" | "device" | "grant" | "connection";
  subjectId: string;
  expectedVersion: number;
  nextVersion: number;
  nextStatus: "active" | "disabled" | "revoked";
  reason: "operator" | "compromise" | "expired";
  now: number;
}

export type InvocationReservation =
  | { outcome: "reserved"; attemptId: string; authorityGeneration: number }
  | { outcome: "denied"; reason: string }
  | { outcome: "already_consumed" }
  | { outcome: "unknown_commit" };

export interface InvocationReservationTransaction extends InvocationBinding {
  attemptId: string;
  correlationId: string;
}

export type AttemptState =
  | "reserved"
  | "dispatching"
  | "completed"
  | "failed_safe"
  | "dispatch_unknown";

/** Opaque, single-use value returned by the durable reserved -> dispatching claim. */
export interface DurableDispatchPermit {
  attemptId: string;
  claimVersion: number;
  authorityGeneration: number;
  token: string;
}

export type DispatchPermitClaim =
  | { outcome: "permit"; permit: DurableDispatchPermit }
  | { outcome: "denied"; reason: string }
  | { outcome: "already_consumed" }
  | { outcome: "unknown_commit" };

export interface DispatchClaimTransaction {
  attemptId: string;
  expectedState: "reserved";
  now: number;
}

export interface DispatchStartTransaction {
  permit: DurableDispatchPermit;
  now: number;
}

/** Returned only after the permit use and dispatch-start marker commit atomically. */
export interface DispatchAuthorization {
  attemptId: string;
  claimVersion: number;
  authorityGeneration: number;
}

export type DispatchStartResult =
  | { outcome: "authorized"; authorization: DispatchAuthorization }
  | { outcome: "denied"; reason: string }
  | { outcome: "already_consumed" }
  | { outcome: "unknown_commit" };

export type AttemptTerminalResult =
  | { outcome: "completed"; resultHash: string }
  | { outcome: "failed_safe"; reason: string }
  | { outcome: "dispatch_unknown" };

export type AttemptFinalization =
  | {
    attemptId: string;
    expectedState: "reserved";
    nextState: "failed_safe";
    result: Extract<AttemptTerminalResult, { outcome: "failed_safe" }>;
    now: number;
  }
  | {
    attemptId: string;
    expectedState: "dispatching";
    permit: DurableDispatchPermit;
    nextState: "completed" | "failed_safe" | "dispatch_unknown";
    result: AttemptTerminalResult;
    now: number;
  };

export interface DispatchRecoveryTransaction {
  attemptId: string;
  expectedState: "dispatching";
  nextState: "dispatch_unknown";
  now: number;
}

export type AuthorityMaintenancePurpose =
  | "export"
  | "inspect"
  | "initialize"
  | "restore"
  | "prepare_migration"
  | "advance_migration"
  | "fail_migration"
  | "recover_migration";

/**
 * Opaque adapter-issued authority for one tenant, actor, and maintenance purpose. The runtime
 * issuer must authenticate object identity; no public property or literal grants authority.
 */
declare const authorityMaintenanceContextBrand: unique symbol;
export interface AuthorityMaintenanceContext {
  readonly [authorityMaintenanceContextBrand]: never;
}

/** Input to a custody-neutral issuer held outside the ordinary maintenance caller surface. */
export interface AuthorityMaintenanceAuthorization {
  tenant: TenantContext;
  actorId: string;
  purpose: AuthorityMaintenancePurpose;
}

/** Adapter-neutral maintenance result; no concrete storage handle crosses the boundary. */
export type AuthorityMaintenanceResult =
  | { outcome: "committed"; authorityGeneration: number }
  | { outcome: "denied"; reason: string };

export interface MigrationPreparation {
  expectedSchemaVersion: number;
  targetSchemaVersion: number;
}

/**
 * Adapter-neutral atomic authority boundary. Every call requires tenant and owner context.
 * Implementations must linearize validation and every listed mutation in one durable commit.
 */
export interface DurableAuthorityTransactions {
  issueChallenge(
    ctx: TenantContext,
    transaction: ChallengeCreationTransaction,
  ): Promise<AtomicAuthorityResult>;
  commitChallenge(
    ctx: TenantContext,
    transaction: ChallengeTransaction,
  ): Promise<AtomicAuthorityResult>;
  consumeReplay(ctx: TenantContext, transaction: ReplayTransaction): Promise<AtomicAuthorityResult>;
  transitionAuthority(
    ctx: TenantContext,
    transaction: AuthorityTransition,
  ): Promise<AtomicAuthorityResult>;
  reserveInvocation(
    ctx: TenantContext,
    transaction: InvocationReservationTransaction,
  ): Promise<InvocationReservation>;
  claimDispatch(
    ctx: TenantContext,
    transaction: DispatchClaimTransaction,
  ): Promise<DispatchPermitClaim>;
  startDispatch(
    ctx: TenantContext,
    transaction: DispatchStartTransaction,
  ): Promise<DispatchStartResult>;
  finalizeAttempt(
    ctx: TenantContext,
    transaction: AttemptFinalization,
  ): Promise<AtomicAuthorityResult>;
  recoverDispatch(
    ctx: TenantContext,
    transaction: DispatchRecoveryTransaction,
  ): Promise<AtomicAuthorityResult>;
}

/** Neutral export/restore/migration/recovery/inspection boundary used by conformance scenarios. */
export interface DurableAuthorityMaintenance {
  exportAuthority(ctx: AuthorityMaintenanceContext): Promise<DurableAuthorityEnvelope>;
  inspectAuthority(
    ctx: AuthorityMaintenanceContext,
    requireCurrent?: boolean,
  ): Promise<DurableAuthorityEnvelope>;
  /** Installs a validated envelope only into a pristine authority store (offline recovery/bootstrap). */
  initializeAuthority(
    ctx: AuthorityMaintenanceContext,
    candidate: DurableAuthorityEnvelope,
  ): Promise<AuthorityMaintenanceResult>;
  restoreAuthority(
    ctx: AuthorityMaintenanceContext,
    candidate: DurableAuthorityEnvelope,
  ): Promise<AuthorityMaintenanceResult>;
  prepareMigration(
    ctx: AuthorityMaintenanceContext,
    transaction: MigrationPreparation,
  ): Promise<AuthorityMaintenanceResult>;
  advanceMigration(ctx: AuthorityMaintenanceContext): Promise<AuthorityMaintenanceResult>;
  failMigration(ctx: AuthorityMaintenanceContext): Promise<AuthorityMaintenanceResult>;
  recoverMigration(ctx: AuthorityMaintenanceContext): Promise<AuthorityMaintenanceResult>;
}

/** Only the one-time durable permit claim can subsequently be consumed at dispatch start. */
export function grantsDispatchPermit(
  result: DispatchPermitClaim,
): result is Extract<DispatchPermitClaim, { outcome: "permit" }> {
  return result.outcome === "permit";
}

/** Only this outcome authorizes a connector call. */
export function grantsDispatch(
  result: DispatchStartResult,
): result is Extract<DispatchStartResult, { outcome: "authorized" }> {
  return result.outcome === "authorized";
}

/** Ambiguous commit and dispatch outcomes are never retryable automatically. */
export function automaticRetryAllowed(_state: "unknown_commit" | "dispatch_unknown"): false {
  return false;
}

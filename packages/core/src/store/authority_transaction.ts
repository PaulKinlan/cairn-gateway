import type { EnrollmentChallenge, TenantContext } from "../domain/types.ts";
import type {
  ApprovalCommit,
  BootstrapCommit,
  EnrollmentRequestCommit,
  InvocationBinding,
  RemovalCommit,
} from "./store.ts";

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
  transactionHash: string;
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

/** Opaque value returned only by the durable reserved -> dispatching claim. */
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
  finalizeAttempt(
    ctx: TenantContext,
    transaction: AttemptFinalization,
  ): Promise<AtomicAuthorityResult>;
  recoverDispatch(
    ctx: TenantContext,
    transaction: DispatchRecoveryTransaction,
  ): Promise<AtomicAuthorityResult>;
}

/** Only the one-time durable permit claim authorizes connector dispatch. */
export function grantsDispatch(
  result: DispatchPermitClaim,
): result is Extract<DispatchPermitClaim, { outcome: "permit" }> {
  return result.outcome === "permit";
}

/** Ambiguous commit and dispatch outcomes are never retryable automatically. */
export function automaticRetryAllowed(_state: "unknown_commit" | "dispatch_unknown"): false {
  return false;
}

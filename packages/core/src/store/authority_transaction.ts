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

export interface AttemptFinalization {
  attemptId: string;
  expectedState: "reserved" | "dispatching";
  nextState: Exclude<AttemptState, "reserved" | "dispatching">;
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
  finalizeAttempt(
    ctx: TenantContext,
    transaction: AttemptFinalization,
  ): Promise<AtomicAuthorityResult>;
}

/** Only this explicit result authorizes dispatch. Ambiguous results are terminal for the attempt. */
export function grantsDispatch(
  result: InvocationReservation,
): result is Extract<InvocationReservation, { outcome: "reserved" }> {
  return result.outcome === "reserved";
}

/** Ambiguous commit and dispatch outcomes are never retryable automatically. */
export function automaticRetryAllowed(_state: "unknown_commit" | "dispatch_unknown"): false {
  return false;
}

import type {
  Agent,
  Connection,
  Device,
  EnrollmentChallenge,
  EnrollmentRequest,
  Grant,
  Principal,
  RevocationEvent,
  TenantContext,
} from "../domain/types.ts";

export interface InvocationBinding {
  principalId: string;
  principalEpoch: number;
  agentId: string;
  agentEpoch: number;
  deviceId: string;
  deviceEpoch: number;
  grantId: string;
  grantVersion: number;
  connectionId: string;
  connectionEpoch: number;
  operation: "github.user.read";
  deviceNonceHash: string;
  agentNonceHash: string;
  nonceExpiresAt: number;
  jtiHash: string;
  jtiExpiresAt: number;
  now: number;
}
export type InvocationDecision = { ok: true } | { ok: false; reason: string };
export interface BootstrapCommit {
  principal: Principal;
  agent: Agent;
  device: Device;
}
export interface EnrollmentRequestCommit {
  request: EnrollmentRequest;
  principalEpoch: number;
  agentEpoch: number;
  agentThumbprint: string;
}
export interface ApprovalCommit {
  requestId: string;
  device: Device;
  principalEpoch: number;
  agentEpoch: number;
  agentThumbprint: string;
  approverId: string;
  approverEpoch: number;
  approverThumbprint: string;
}
export interface RemovalCommit {
  agentId: string;
  agentEpoch: number;
  agentThumbprint: string;
  approverId: string;
  approverEpoch: number;
  approverThumbprint: string;
  targetId: string;
  targetEpoch: number;
  targetThumbprint: string;
  targetRole: Device["role"];
}

/**
 * Stage 0 fixture store. It remains frozen for the accepted 90-test denominator and is not a
 * production durability contract. Production authority must implement DurableAuthorityTransactions.
 */
export interface MetadataStore {
  putPrincipal(ctx: TenantContext, value: Principal): Promise<void>;
  getPrincipal(ctx: TenantContext, id: string): Promise<Principal | undefined>;
  putAgent(ctx: TenantContext, value: Agent): Promise<void>;
  getAgent(ctx: TenantContext, id: string): Promise<Agent | undefined>;
  putDevice(ctx: TenantContext, value: Device): Promise<void>;
  getDevice(ctx: TenantContext, id: string): Promise<Device | undefined>;
  listDevices(ctx: TenantContext): Promise<Device[]>;
  putEnrollment(ctx: TenantContext, value: EnrollmentRequest): Promise<void>;
  getEnrollment(ctx: TenantContext, id: string): Promise<EnrollmentRequest | undefined>;
  putConnection(ctx: TenantContext, value: Connection): Promise<void>;
  getConnection(ctx: TenantContext, id: string): Promise<Connection | undefined>;
  putGrant(ctx: TenantContext, value: Grant): Promise<void>;
  getGrant(ctx: TenantContext, id: string): Promise<Grant | undefined>;
  issueChallenge(ctx: TenantContext, value: EnrollmentChallenge): Promise<void>;
  commitBootstrap(
    ctx: TenantContext,
    challengeId: string,
    value: BootstrapCommit,
    now: number,
  ): Promise<boolean>;
  commitEnrollmentRequest(
    ctx: TenantContext,
    challengeId: string,
    value: EnrollmentRequestCommit,
    now: number,
  ): Promise<boolean>;
  commitApproval(
    ctx: TenantContext,
    challengeId: string,
    value: ApprovalCommit,
    now: number,
  ): Promise<boolean>;
  commitRemoval(
    ctx: TenantContext,
    challengeId: string,
    value: RemovalCommit,
    now: number,
  ): Promise<boolean>;
  updatePrincipal(
    ctx: TenantContext,
    value: Principal,
    reason?: RevocationEvent["reason"],
    at?: number,
  ): Promise<void>;
  updateAgent(
    ctx: TenantContext,
    value: Agent,
    reason?: RevocationEvent["reason"],
    at?: number,
  ): Promise<void>;
  updateDevice(
    ctx: TenantContext,
    value: Device,
    reason?: RevocationEvent["reason"],
    at?: number,
  ): Promise<void>;
  updateGrant(
    ctx: TenantContext,
    value: Grant,
    reason?: RevocationEvent["reason"],
    at?: number,
  ): Promise<void>;
  updateConnection(
    ctx: TenantContext,
    value: Connection,
    reason?: RevocationEvent["reason"],
    at?: number,
  ): Promise<void>;
  consumeNonce(
    ctx: TenantContext,
    nonceHash: string,
    expiresAt: number,
    now: number,
  ): Promise<boolean>;
  consumeNonces(
    ctx: TenantContext,
    nonceHashes: string[],
    expiresAt: number,
    now: number,
  ): Promise<boolean>;
  consumeInvocation(ctx: TenantContext, binding: InvocationBinding): Promise<InvocationDecision>;
  revocations(ctx: TenantContext): Promise<RevocationEvent[]>;
}

export type {
  AtomicAuthorityResult,
  AttemptFinalization,
  AttemptState,
  AuthorityTransition,
  ChallengeCreationTransaction,
  ChallengeTransaction,
  DurableAuthorityTransactions,
  InvocationReservation,
  InvocationReservationTransaction,
  ReplayTransaction,
} from "./authority_transaction.ts";

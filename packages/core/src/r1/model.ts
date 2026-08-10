import type { DetachedProof } from "../crypto/request_proof.ts";

export type R1TenantId = string & { readonly __r1Tenant: unique symbol };
export type R1UserId = string & { readonly __r1User: unique symbol };
export type R1MembershipId = string & { readonly __r1Membership: unique symbol };
export type ClientPrincipalId = string & { readonly __clientPrincipal: unique symbol };
export type ProviderConnectionId = string & { readonly __providerConnection: unique symbol };
export type R1GrantId = string & { readonly __r1Grant: unique symbol };

export interface Tenant {
  id: R1TenantId;
  name: string;
  status: "active" | "disabled";
}

export interface User {
  id: R1UserId;
  immutableSubject: string;
  status: "active" | "disabled";
}

export interface Membership {
  id: R1MembershipId;
  tenantId: R1TenantId;
  userId: R1UserId;
  role: "owner";
  status: "active" | "revoked";
}

export interface ClientPrincipal {
  id: ClientPrincipalId;
  tenantId: R1TenantId;
  name: string;
  publicJwk: JsonWebKey;
  thumbprint: string;
  status: "pending" | "active" | "revoked";
  keyEpoch: number;
}

export type ConnectionLifecycle =
  | "pending"
  | "connected"
  | "reconnect_required"
  | "disconnected"
  | "deleted"
  | "error";
export type ConnectionHealth = "unknown" | "checking" | "healthy" | "unhealthy";

/** Tenant-owned. It deliberately has no user, membership, client, device, agent, or workload owner. */
export interface ProviderConnection {
  id: ProviderConnectionId;
  tenantId: R1TenantId;
  provider: "github";
  custodyReference: string;
  lifecycle: ConnectionLifecycle;
  configured: boolean;
  health: ConnectionHealth;
  healthCheckedAt?: number;
  authorityEpoch: number;
}

export interface Grant {
  id: R1GrantId;
  tenantId: R1TenantId;
  clientPrincipalId: ClientPrincipalId;
  providerConnectionId: ProviderConnectionId;
  operation: "github.user.read@v1";
  status: "pending" | "active" | "revoked";
  version: number;
  expiresAt: number;
  maxRequestUnits: number;
}

export interface OAuthFlow {
  id: string;
  tenantId: R1TenantId;
  initiatingUserId: R1UserId;
  initiatingMembershipId: R1MembershipId;
  initiatingSessionId: string;
  provider: "github";
  purpose: "owner_login" | "provider_connection";
  redirectUri: string;
  stateHash: string;
  pkceChallenge?: string;
  expiresAt: number;
  status: "pending" | "completed" | "expired" | "cancelled";
}

export interface Attempt {
  id: string;
  tenantId: R1TenantId;
  clientPrincipalId: ClientPrincipalId;
  grantId?: R1GrantId;
  providerConnectionId?: ProviderConnectionId;
  operation: "github.user.read@v1";
  state: "reserved" | "completed" | "denied" | "provider_unknown";
  startedAt: number;
  completedAt?: number;
}

export interface Receipt {
  id: string;
  tenantId: R1TenantId;
  attemptId: string;
  clientPrincipalId: ClientPrincipalId;
  providerConnectionId?: ProviderConnectionId;
  operation: "github.user.read@v1";
  decision: "allow" | "deny" | "error";
  reason:
    | "policy_allow"
    | "client_inactive"
    | "grant_inactive"
    | "connection_inactive"
    | "proof_denied"
    | "replay_denied";
  requestUnits: 0 | 1;
  at: number;
}

export interface EnrollmentReference {
  id: string;
  tenantId: R1TenantId;
  clientPrincipalId: ClientPrincipalId;
  referenceHash: string;
  expiresAt: number;
  status: "issued" | "submitted" | "approved" | "expired" | "cancelled";
}

export interface ClientProofRequest {
  clientPrincipalId: ClientPrincipalId;
  receivedBody: Uint8Array;
  proof: DetachedProof;
}

export interface GithubUserProjection {
  id: number;
  login: string;
  name: string | null;
  html_url: string;
  avatar_url: string;
}

export const r1Ids = Object.freeze({
  tenant: (value: string) => value as R1TenantId,
  user: (value: string) => value as R1UserId,
  membership: (value: string) => value as R1MembershipId,
  client: (value: string) => value as ClientPrincipalId,
  connection: (value: string) => value as ProviderConnectionId,
  grant: (value: string) => value as R1GrantId,
});

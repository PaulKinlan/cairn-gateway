export type TenantId = string & { readonly __tenant: unique symbol };
export type UserId = string & { readonly __user: unique symbol };
export type AgentId = string & { readonly __agent: unique symbol };
export type DeviceId = string & { readonly __device: unique symbol };
export type ConnectionId = string & { readonly __connection: unique symbol };

export interface TenantContext {
  tenantId: TenantId;
  userId: UserId;
}

export type Status = "active" | "disabled" | "revoked";
export interface Principal {
  id: UserId;
  tenantId: TenantId;
  kind: "cryptographic";
  status: Status;
  emailRequired: false;
}
export interface Agent {
  id: AgentId;
  tenantId: TenantId;
  userId: UserId;
  publicJwk: JsonWebKey;
  thumbprint: string;
  status: Status;
}
export interface Device {
  id: DeviceId;
  tenantId: TenantId;
  userId: UserId;
  agentId: AgentId;
  publicJwk: JsonWebKey;
  thumbprint: string;
  role: "admin" | "member";
  status: Status;
  epoch: number;
}
export interface Connection {
  id: ConnectionId;
  tenantId: TenantId;
  userId: UserId;
  provider: "github";
  adapter: "fixture";
  custodyRef: string;
  status: "pending" | "active" | "disabled" | "revoked";
  epoch: number;
}
export interface Grant {
  id: string;
  tenantId: TenantId;
  userId: UserId;
  agentId: AgentId;
  deviceId: DeviceId;
  connectionId: ConnectionId;
  operation: "github.user.read";
  status: Status;
  version: number;
  expiresAt: number;
}
export interface EnrollmentRequest {
  id: string;
  tenantId: TenantId;
  userId: UserId;
  agentId: AgentId;
  candidateJwk: JsonWebKey;
  thumbprint: string;
  challenge: string;
  status: "pending" | "approved" | "rejected";
  expiresAt: number;
}
export interface RevocationEvent {
  tenantId: TenantId;
  subjectType: "device" | "grant" | "connection";
  subjectId: string;
  version: number;
  reason: "operator" | "compromise" | "expired";
  at: number;
}

export const ids = {
  tenant: (value: string) => value as TenantId,
  user: (value: string) => value as UserId,
  agent: (value: string) => value as AgentId,
  device: (value: string) => value as DeviceId,
  connection: (value: string) => value as ConnectionId,
};

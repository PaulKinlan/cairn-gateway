import type {
  Agent,
  Connection,
  Device,
  EnrollmentRequest,
  Grant,
  Principal,
  RevocationEvent,
  TenantContext,
} from "../domain/types.ts";

export interface InvocationBinding {
  deviceId: string;
  deviceEpoch: number;
  grantId: string;
  grantVersion: number;
  connectionId: string;
  connectionEpoch: number;
  operation: "github.user.read";
  nonceHash: string;
  nonceExpiresAt: number;
  jtiHash: string;
  jtiExpiresAt: number;
  now: number;
}
export type InvocationDecision = { ok: true } | { ok: false; reason: string };

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
  updateDevice(ctx: TenantContext, value: Device, event?: RevocationEvent): Promise<void>;
  updateGrant(ctx: TenantContext, value: Grant, event?: RevocationEvent): Promise<void>;
  updateConnection(ctx: TenantContext, value: Connection, event?: RevocationEvent): Promise<void>;
  consumeNonce(
    ctx: TenantContext,
    nonceHash: string,
    expiresAt: number,
    now: number,
  ): Promise<boolean>;
  consumeInvocation(ctx: TenantContext, binding: InvocationBinding): Promise<InvocationDecision>;
  revocations(ctx: TenantContext): Promise<RevocationEvent[]>;
}

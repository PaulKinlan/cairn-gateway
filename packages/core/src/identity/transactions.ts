import type {
  Agent,
  Device,
  EnrollmentRequest,
  Principal,
  TenantContext,
} from "../domain/types.ts";
import { canonical, encoder, sha256 } from "../crypto/encoding.ts";
import { jwkThumbprint, shortFingerprint } from "../crypto/thumbprint.ts";

export async function transactionHash(value: unknown): Promise<string> {
  return await sha256(encoder.encode(canonical(value)));
}

export async function bootstrapTransaction(
  ctx: TenantContext,
  principal: Principal,
  agent: Pick<Agent, "id" | "publicJwk">,
  device: Pick<Device, "id" | "publicJwk">,
) {
  return {
    action: "bootstrap" as const,
    tenant_id: ctx.tenantId,
    principal_epoch: 1,
    agent_epoch: 1,
    device_epoch: 1,
    user_id: ctx.userId,
    principal_id: principal.id,
    agent_id: agent.id,
    agent_jkt: await jwkThumbprint(agent.publicJwk),
    device_id: device.id,
    device_jkt: await jwkThumbprint(device.publicJwk),
  };
}

export async function enrollmentTransaction(
  ctx: TenantContext,
  request: Pick<EnrollmentRequest, "id" | "agentId" | "candidateJwk" | "expiresAt">,
  principal: Pick<Principal, "epoch">,
  agent: Pick<Agent, "thumbprint" | "epoch">,
) {
  return {
    action: "enroll" as const,
    tenant_id: ctx.tenantId,
    principal_epoch: principal.epoch,
    agent_epoch: agent.epoch,
    user_id: ctx.userId,
    request_id: request.id,
    agent_id: request.agentId,
    agent_jkt: agent.thumbprint,
    candidate_jkt: await jwkThumbprint(request.candidateJwk),
    expires_at: request.expiresAt,
  };
}

export function approvalTransaction(
  ctx: TenantContext,
  principal: Pick<Principal, "epoch">,
  agent: Pick<Agent, "epoch">,
  request: Pick<EnrollmentRequest, "id" | "agentId" | "thumbprint" | "expiresAt">,
  approver: Pick<Device, "id" | "thumbprint" | "epoch">,
  candidateId: Device["id"],
) {
  return {
    action: "approve_enrollment" as const,
    tenant_id: ctx.tenantId,
    principal_epoch: principal.epoch,
    agent_epoch: agent.epoch,
    approver_epoch: approver.epoch,
    candidate_epoch: 1,
    user_id: ctx.userId,
    request_id: request.id,
    approver_id: approver.id,
    approver_jkt: approver.thumbprint,
    agent_id: request.agentId,
    candidate_id: candidateId,
    candidate_jkt: request.thumbprint,
    fingerprint: shortFingerprint(request.thumbprint),
    expires_at: request.expiresAt,
  };
}

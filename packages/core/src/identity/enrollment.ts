import type {
  AgentId,
  Device,
  DeviceId,
  EnrollmentRequest,
  Principal,
  TenantContext,
} from "../domain/types.ts";
import type { MetadataStore } from "../store/store.ts";
import { canonical, encoder, unbase64url } from "../crypto/encoding.ts";
import { importPublicP256, jwkThumbprint, shortFingerprint } from "../crypto/thumbprint.ts";

export interface PossessionProof {
  challenge: string;
  signature: string;
}
async function verifyPossession(
  jwk: JsonWebKey,
  message: unknown,
  proof: PossessionProof,
): Promise<void> {
  const key = await importPublicP256(jwk);
  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    unbase64url(proof.signature),
    encoder.encode(canonical(message)),
  );
  if (!valid) throw new Error("possession proof denied");
}

export class DeviceEnrollmentService {
  #approved = new Set<string>();
  constructor(private readonly store: MetadataStore) {}

  async bootstrap(
    ctx: TenantContext,
    principal: Principal,
    agentId: AgentId,
    agentPublicJwk: JsonWebKey,
    deviceId: DeviceId,
    devicePublicJwk: JsonWebKey,
    proof: PossessionProof,
  ): Promise<Device> {
    if (
      await this.store.getPrincipal(ctx, principal.id) || (await this.store.listDevices(ctx)).length
    ) {
      throw new Error("bootstrap already completed");
    }
    if (
      principal.id !== ctx.userId || principal.tenantId !== ctx.tenantId ||
      principal.emailRequired !== false
    ) {
      throw new Error("principal ownership denied");
    }
    const deviceThumbprint = await jwkThumbprint(devicePublicJwk);
    const agentThumbprint = await jwkThumbprint(agentPublicJwk);
    if (deviceThumbprint === agentThumbprint) throw new Error("agent and device keys must differ");
    const message = {
      action: "bootstrap",
      challenge: proof.challenge,
      tenant_id: ctx.tenantId,
      user_id: ctx.userId,
      device_id: deviceId,
      device_jkt: deviceThumbprint,
    };
    await verifyPossession(devicePublicJwk, message, proof);
    await this.store.putPrincipal(ctx, principal);
    await this.store.putAgent(ctx, {
      id: agentId,
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      publicJwk: agentPublicJwk,
      thumbprint: agentThumbprint,
      status: "active",
    });
    const device: Device = {
      id: deviceId,
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      agentId,
      publicJwk: devicePublicJwk,
      thumbprint: deviceThumbprint,
      role: "admin",
      status: "active",
      epoch: 1,
    };
    await this.store.putDevice(ctx, device);
    return device;
  }

  async request(
    ctx: TenantContext,
    value: Omit<EnrollmentRequest, "thumbprint" | "status">,
    proof: PossessionProof,
    now: number,
  ): Promise<{ request: EnrollmentRequest; fingerprint: string }> {
    if (value.expiresAt <= now || value.expiresAt > now + 600) {
      throw new Error("invalid enrollment expiry");
    }
    const thumbprint = await jwkThumbprint(value.candidateJwk);
    if ((await this.store.listDevices(ctx)).some((device) => device.thumbprint === thumbprint)) {
      throw new Error("duplicate device key");
    }
    const message = {
      action: "enroll",
      challenge: proof.challenge,
      request_id: value.id,
      tenant_id: ctx.tenantId,
      user_id: ctx.userId,
      agent_id: value.agentId,
      candidate_jkt: thumbprint,
      expires_at: value.expiresAt,
    };
    await verifyPossession(value.candidateJwk, message, proof);
    const request: EnrollmentRequest = { ...value, thumbprint, status: "pending" };
    await this.store.putEnrollment(ctx, request);
    return { request, fingerprint: shortFingerprint(thumbprint) };
  }

  async approve(
    ctx: TenantContext,
    requestId: string,
    approverId: DeviceId,
    candidateId: DeviceId,
    fingerprint: string,
    proof: PossessionProof,
    now: number,
  ): Promise<Device> {
    if (approverId === candidateId) throw new Error("self approval denied");
    if (this.#approved.has(`${ctx.tenantId}/${requestId}`)) {
      throw new Error("enrollment already consumed");
    }
    const request = await this.store.getEnrollment(ctx, requestId);
    const approver = await this.store.getDevice(ctx, approverId);
    if (
      !request || request.status !== "pending" || request.expiresAt < now || !approver ||
      approver.status !== "active" || approver.role !== "admin" ||
      shortFingerprint(request.thumbprint) !== fingerprint
    ) {
      throw new Error("enrollment approval denied");
    }
    const message = {
      action: "approve_enrollment",
      challenge: proof.challenge,
      request_id: requestId,
      candidate_id: candidateId,
      candidate_jkt: request.thumbprint,
      fingerprint,
    };
    await verifyPossession(approver.publicJwk, message, proof);
    const device: Device = {
      id: candidateId,
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      agentId: request.agentId,
      publicJwk: request.candidateJwk,
      thumbprint: request.thumbprint,
      role: "member",
      status: "active",
      epoch: 1,
    };
    await this.store.putDevice(ctx, device);
    this.#approved.add(`${ctx.tenantId}/${requestId}`);
    await this.store.putEnrollment(ctx, { ...request, status: "approved" });
    return device;
  }

  async remove(ctx: TenantContext, deviceId: DeviceId, now: number): Promise<void> {
    const device = await this.store.getDevice(ctx, deviceId);
    if (!device) throw new Error("device not found");
    await this.store.updateDevice(ctx, { ...device, status: "revoked", epoch: device.epoch + 1 }, {
      tenantId: ctx.tenantId,
      subjectType: "device",
      subjectId: device.id,
      version: device.epoch + 1,
      reason: "operator",
      at: now,
    });
  }
}

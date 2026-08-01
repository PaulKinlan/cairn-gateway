import type {
  AgentId,
  Device,
  DeviceId,
  EnrollmentRequest,
  Principal,
  TenantContext,
} from "../domain/types.ts";
import type { MetadataStore } from "../store/store.ts";
import { base64url, canonical, encoder, sha256, unbase64url } from "../crypto/encoding.ts";
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
  if (
    !await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      unbase64url(proof.signature),
      encoder.encode(canonical(message)),
    )
  ) throw new Error("possession proof denied");
}
function randomChallenge(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}
async function transactionHash(value: unknown): Promise<string> {
  return await sha256(encoder.encode(canonical(value)));
}

export class DeviceEnrollmentService {
  constructor(private readonly store: MetadataStore) {}
  async bootstrapChallenge(
    ctx: TenantContext,
    principal: Principal,
    agentId: AgentId,
    agentPublicJwk: JsonWebKey,
    deviceId: DeviceId,
    devicePublicJwk: JsonWebKey,
    now: number,
  ): Promise<string> {
    const tx = await this.#bootstrapTransaction(
      ctx,
      principal,
      agentId,
      agentPublicJwk,
      deviceId,
      devicePublicJwk,
    );
    return await this.#issue(ctx, "bootstrap", tx, now);
  }
  async bootstrap(
    ctx: TenantContext,
    principal: Principal,
    agentId: AgentId,
    agentPublicJwk: JsonWebKey,
    deviceId: DeviceId,
    devicePublicJwk: JsonWebKey,
    deviceProof: PossessionProof,
    agentProof: PossessionProof,
    now: number,
  ): Promise<Device> {
    if (deviceProof.challenge !== agentProof.challenge) {
      throw new Error("bootstrap challenge mismatch");
    }
    const tx = await this.#bootstrapTransaction(
      ctx,
      principal,
      agentId,
      agentPublicJwk,
      deviceId,
      devicePublicJwk,
    );
    const message = { ...tx, challenge: deviceProof.challenge };
    await verifyPossession(devicePublicJwk, message, deviceProof);
    await verifyPossession(agentPublicJwk, message, agentProof);
    const agentThumbprint = tx.agent_jkt, deviceThumbprint = tx.device_jkt;
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
    const ok = await this.store.commitBootstrap(
      ctx,
      deviceProof.challenge,
      await transactionHash(tx),
      {
        principal: { ...principal, epoch: 1 },
        agent: {
          id: agentId,
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          publicJwk: agentPublicJwk,
          thumbprint: agentThumbprint,
          status: "active",
          epoch: 1,
        },
        device,
      },
      now,
    );
    if (!ok) throw new Error("bootstrap denied or consumed");
    return device;
  }
  async #bootstrapTransaction(
    ctx: TenantContext,
    principal: Principal,
    agentId: AgentId,
    agentPublicJwk: JsonWebKey,
    deviceId: DeviceId,
    devicePublicJwk: JsonWebKey,
  ) {
    if (
      principal.id !== ctx.userId || principal.tenantId !== ctx.tenantId ||
      principal.emailRequired !== false || principal.status !== "active"
    ) throw new Error("principal ownership denied");
    const deviceJkt = await jwkThumbprint(devicePublicJwk),
      agentJkt = await jwkThumbprint(agentPublicJwk);
    if (deviceJkt === agentJkt) throw new Error("agent and device keys must differ");
    return {
      action: "bootstrap" as const,
      tenant_id: ctx.tenantId,
      user_id: ctx.userId,
      principal_id: principal.id,
      agent_id: agentId,
      agent_jkt: agentJkt,
      device_id: deviceId,
      device_jkt: deviceJkt,
    };
  }
  async requestChallenge(
    ctx: TenantContext,
    value: Omit<EnrollmentRequest, "thumbprint" | "status">,
    now: number,
  ): Promise<string> {
    const tx = await this.#requestTransaction(ctx, value, now);
    return await this.#issue(ctx, "enroll_candidate", tx, now);
  }
  async request(
    ctx: TenantContext,
    value: Omit<EnrollmentRequest, "thumbprint" | "status">,
    proof: PossessionProof,
    now: number,
  ): Promise<{ request: EnrollmentRequest; fingerprint: string }> {
    const tx = await this.#requestTransaction(ctx, value, now);
    await verifyPossession(value.candidateJwk, { ...tx, challenge: proof.challenge }, proof);
    const request: EnrollmentRequest = {
      ...value,
      thumbprint: tx.candidate_jkt,
      status: "pending",
    };
    if (
      !await this.store.commitEnrollmentRequest(
        ctx,
        proof.challenge,
        await transactionHash(tx),
        request,
        now,
      )
    ) throw new Error("enrollment challenge denied or consumed");
    return { request, fingerprint: shortFingerprint(tx.candidate_jkt) };
  }
  async #requestTransaction(
    ctx: TenantContext,
    value: Omit<EnrollmentRequest, "thumbprint" | "status">,
    now: number,
  ) {
    if (
      value.tenantId !== ctx.tenantId || value.userId !== ctx.userId || value.expiresAt <= now ||
      value.expiresAt > now + 600
    ) throw new Error("invalid enrollment request");
    const agent = await this.store.getAgent(ctx, value.agentId);
    if (!agent || agent.status !== "active") throw new Error("agent denied");
    const jkt = await jwkThumbprint(value.candidateJwk);
    if ((await this.store.listDevices(ctx)).some((d) => d.thumbprint === jkt)) {
      throw new Error("duplicate device key");
    }
    return {
      action: "enroll" as const,
      tenant_id: ctx.tenantId,
      user_id: ctx.userId,
      request_id: value.id,
      agent_id: value.agentId,
      agent_jkt: agent.thumbprint,
      candidate_jkt: jkt,
      expires_at: value.expiresAt,
    };
  }
  async approvalChallenge(
    ctx: TenantContext,
    requestId: string,
    approverId: DeviceId,
    candidateId: DeviceId,
    fingerprint: string,
    now: number,
  ): Promise<string> {
    const tx = await this.#approvalTransaction(
      ctx,
      requestId,
      approverId,
      candidateId,
      fingerprint,
      now,
    );
    return await this.#issue(ctx, "approve_enrollment", tx, now);
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
    const tx = await this.#approvalTransaction(
      ctx,
      requestId,
      approverId,
      candidateId,
      fingerprint,
      now,
    );
    const request = await this.store.getEnrollment(ctx, requestId),
      approver = await this.store.getDevice(ctx, approverId);
    if (!request || !approver) throw new Error("enrollment approval denied");
    await verifyPossession(approver.publicJwk, { ...tx, challenge: proof.challenge }, proof);
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
    if (
      !await this.store.commitApproval(ctx, proof.challenge, await transactionHash(tx), {
        requestId,
        device,
      }, now)
    ) throw new Error("enrollment approval denied or consumed");
    return device;
  }
  async #approvalTransaction(
    ctx: TenantContext,
    requestId: string,
    approverId: DeviceId,
    candidateId: DeviceId,
    fingerprint: string,
    now: number,
  ) {
    if (approverId === candidateId) throw new Error("self approval denied");
    const request = await this.store.getEnrollment(ctx, requestId),
      approver = await this.store.getDevice(ctx, approverId);
    if (
      !request || request.status !== "pending" || request.expiresAt < now || !approver ||
      approver.status !== "active" || approver.role !== "admin" ||
      shortFingerprint(request.thumbprint) !== fingerprint || approver.agentId !== request.agentId
    ) throw new Error("enrollment approval denied");
    return {
      action: "approve_enrollment" as const,
      tenant_id: ctx.tenantId,
      user_id: ctx.userId,
      request_id: requestId,
      approver_id: approverId,
      approver_jkt: approver.thumbprint,
      agent_id: request.agentId,
      candidate_id: candidateId,
      candidate_jkt: request.thumbprint,
      fingerprint,
      expires_at: request.expiresAt,
    };
  }
  async removalChallenge(
    ctx: TenantContext,
    approverId: DeviceId,
    targetId: DeviceId,
    now: number,
  ): Promise<string> {
    const tx = await this.#removalTransaction(ctx, approverId, targetId);
    return await this.#issue(ctx, "remove_device", tx, now);
  }
  async remove(
    ctx: TenantContext,
    approverId: DeviceId,
    targetId: DeviceId,
    proof: PossessionProof,
    now: number,
  ): Promise<void> {
    const tx = await this.#removalTransaction(ctx, approverId, targetId);
    const approver = await this.store.getDevice(ctx, approverId),
      target = await this.store.getDevice(ctx, targetId);
    if (!approver || !target) throw new Error("device removal denied");
    await verifyPossession(approver.publicJwk, { ...tx, challenge: proof.challenge }, proof);
    if (
      !await this.store.consumeChallenge(
        ctx,
        proof.challenge,
        await transactionHash(tx),
        "remove_device",
        now,
      )
    ) throw new Error("removal challenge replay");
    await this.store.updateDevice(
      ctx,
      { ...target, status: "revoked", epoch: target.epoch + 1 },
      "operator",
      now,
    );
  }
  async #removalTransaction(ctx: TenantContext, approverId: DeviceId, targetId: DeviceId) {
    const approver = await this.store.getDevice(ctx, approverId),
      target = await this.store.getDevice(ctx, targetId);
    if (
      !approver || approver.status !== "active" || approver.role !== "admin" || !target ||
      target.status !== "active"
    ) throw new Error("device removal denied");
    return {
      action: "remove_device" as const,
      tenant_id: ctx.tenantId,
      user_id: ctx.userId,
      approver_id: approverId,
      approver_jkt: approver.thumbprint,
      target_id: targetId,
      target_epoch: target.epoch,
    };
  }
  async #issue(
    ctx: TenantContext,
    purpose: "bootstrap" | "enroll_candidate" | "approve_enrollment" | "remove_device",
    transaction: unknown,
    now: number,
  ): Promise<string> {
    const id = randomChallenge();
    await this.store.issueChallenge(ctx, {
      id,
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      purpose,
      transactionHash: await transactionHash(transaction),
      expiresAt: now + 300,
      used: false,
    });
    return id;
  }
}

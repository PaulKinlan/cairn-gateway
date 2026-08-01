import type { TenantContext } from "../domain/types.ts";
import type { MetadataStore } from "../store/store.ts";
import type { CapabilityKeyring } from "../crypto/capability.ts";
import { type CapabilityClaims, signCapability, verifyCapability } from "../crypto/capability.ts";
import type { DetachedProof } from "../crypto/request_proof.ts";
import { bodyHash, verifyRequestProof } from "../crypto/request_proof.ts";
import { sha256 } from "../crypto/encoding.ts";
import type { CustodyAdapter, CustodyBinding } from "../custody/custody_adapter.ts";
import { type GithubResult, invokeGithubUserRead } from "../connectors/github_user.ts";
import type { SafeLogger } from "../logging/safe_logger.ts";
import { makeReceipt, type Receipt, type ReceiptReason } from "../receipts/receipt.ts";
export interface DualProof {
  device: DetachedProof;
  agent: DetachedProof;
}
export class InvocationService {
  constructor(
    private readonly store: MetadataStore,
    private readonly keys: CapabilityKeyring,
    private readonly custody: CustodyAdapter,
    private readonly logger: SafeLogger,
    private readonly invocationEnabled = true,
    private readonly authority = "fixture.cairn.invalid",
  ) {}
  async issue(
    ctx: TenantContext,
    grantId: string,
    proofs: DualProof,
    receivedBody: Uint8Array,
    now: number,
  ): Promise<string> {
    if (!this.invocationEnabled) throw new Error("invocation disabled");
    const grant = await this.store.getGrant(ctx, grantId),
      principal = await this.store.getPrincipal(ctx, ctx.userId);
    if (
      !grant || grant.status !== "active" || grant.expiresAt <= now || !principal ||
      principal.status !== "active"
    ) throw new Error("grant denied");
    const agent = await this.store.getAgent(ctx, grant.agentId),
      device = await this.store.getDevice(ctx, grant.deviceId),
      connection = await this.store.getConnection(ctx, grant.connectionId);
    if (
      !agent || agent.status !== "active" || !device || device.status !== "active" ||
      device.agentId !== agent.id || !connection || connection.status !== "active"
    ) throw new Error("grant denied");
    const expected = {
      v: 1 as const,
      method: "POST" as const,
      authority: this.authority,
      path: "/internal/capabilities" as const,
      query: "" as const,
      audience: "urn:cairn:gateway" as const,
      body_sha256: await bodyHash(receivedBody),
      device_id: device.id,
      agent_id: agent.id,
      grant_id: grant.id,
    };
    if (!await verifyRequestProof(proofs.device, device.publicJwk, expected, now)) {
      throw new Error("device proof denied");
    }
    if (!await verifyRequestProof(proofs.agent, agent.publicJwk, expected, now)) {
      throw new Error("agent proof denied");
    }
    if (
      !await this.store.consumeNonces(
        ctx,
        [
          await sha256(`device:${proofs.device.payload.nonce}`),
          await sha256(`agent:${proofs.agent.payload.nonce}`),
        ],
        now + 600,
        now,
      )
    ) throw new Error("nonce replay");
    const claims: CapabilityClaims = {
      iss: "urn:cairn:gateway",
      aud: "urn:cairn:invoke",
      sub: grant.agentId,
      tenant_id: ctx.tenantId,
      user_id: ctx.userId,
      agent_id: grant.agentId,
      device_id: device.id,
      connection_id: connection.id,
      operations: ["github.user.read"],
      jti: crypto.randomUUID().replaceAll("-", ""),
      iat: now,
      nbf: now,
      exp: now + 300,
      max_calls: 1,
      cnf: { jkt: device.thumbprint },
      grant_id: grant.id,
      grant_version: grant.version,
      principal_epoch: principal.epoch,
      agent_epoch: agent.epoch,
      device_epoch: device.epoch,
      connection_epoch: connection.epoch,
      policy_version: 1,
      schema_version: 1,
    };
    return await signCapability(this.keys, claims);
  }
  async invoke(
    ctx: TenantContext,
    capability: string,
    proofs: DualProof,
    args: unknown,
    receivedBody: Uint8Array,
    now: number,
    correlationId: string,
    requestPath: "/mcp" | "/mcp/legacy" = "/mcp",
  ): Promise<{ result: GithubResult; receipt: Receipt }> {
    const started = performance.now();
    let receiptEmitted = false;
    const emitClosed = (
      decision: "deny" | "error",
      reason: ReceiptReason,
      claims?: CapabilityClaims,
    ) => {
      if (receiptEmitted) return;
      receiptEmitted = true;
      this.#receipt(ctx, correlationId, now, decision, reason, claims);
    };
    try {
      if (!this.invocationEnabled) {
        emitClosed("deny", "invocation_disabled");
        throw new Error("invocation disabled");
      }
      let claims: CapabilityClaims;
      try {
        claims = await verifyCapability(this.keys, capability, now);
      } catch {
        emitClosed("deny", "capability_invalid");
        throw new Error("capability invalid");
      }
      if (claims.tenant_id !== ctx.tenantId || claims.user_id !== ctx.userId) {
        emitClosed("deny", "ownership_denied", claims);
        throw new Error("ownership denied");
      }
      const principal = await this.store.getPrincipal(ctx, ctx.userId),
        agent = await this.store.getAgent(ctx, claims.agent_id),
        device = await this.store.getDevice(ctx, claims.device_id),
        connection = await this.store.getConnection(ctx, claims.connection_id);
      if (
        !principal || !agent || !device || !connection || claims.cnf.jkt !== device.thumbprint ||
        device.agentId !== agent.id
      ) {
        emitClosed("deny", "binding_denied", claims);
        throw new Error("binding denied");
      }
      if (
        !args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length !== 0
      ) {
        emitClosed("deny", "arguments_denied", claims);
        throw new Error("arguments denied");
      }
      const expected = {
        v: 1 as const,
        method: "POST" as const,
        authority: this.authority,
        path: requestPath,
        query: "" as const,
        audience: "urn:cairn:gateway" as const,
        body_sha256: await bodyHash(receivedBody),
        device_id: device.id,
        agent_id: agent.id,
        grant_id: claims.grant_id,
        capability_sha256: await sha256(capability),
      };
      let deviceProofValid = false;
      try {
        deviceProofValid = await verifyRequestProof(proofs.device, device.publicJwk, expected, now);
      } catch {
        // Malformed encodings are authentication denials, never raw exceptions.
      }
      if (!deviceProofValid) {
        emitClosed("deny", "device_proof_denied", claims);
        throw new Error("device proof denied");
      }
      let agentProofValid = false;
      try {
        agentProofValid = await verifyRequestProof(proofs.agent, agent.publicJwk, expected, now);
      } catch {
        // Preserve the closed receipt taxonomy for hostile detached proofs.
      }
      if (!agentProofValid) {
        emitClosed("deny", "agent_proof_denied", claims);
        throw new Error("agent proof denied");
      }
      const consumed = await this.store.consumeInvocation(ctx, {
        principalId: ctx.userId,
        principalEpoch: claims.principal_epoch,
        agentId: claims.agent_id,
        agentEpoch: claims.agent_epoch,
        deviceId: claims.device_id,
        deviceEpoch: claims.device_epoch,
        grantId: claims.grant_id,
        grantVersion: claims.grant_version,
        connectionId: claims.connection_id,
        connectionEpoch: claims.connection_epoch,
        operation: "github.user.read",
        nonceHash: await sha256(`${proofs.device.payload.nonce}:${proofs.agent.payload.nonce}`),
        nonceExpiresAt: now + 600,
        jtiHash: await sha256(claims.jti),
        jtiExpiresAt: claims.exp,
        now,
      });
      if (!consumed.ok) {
        const reason = closedReason(consumed.reason);
        emitClosed("deny", reason, claims);
        throw new Error(consumed.reason);
      }
      const binding: CustodyBinding = {
        context: ctx,
        connectionId: connection.id,
        connectionRef: connection.custodyRef,
        integration: "github-cairn-v1",
        redirectUri: "https://fixture.cairn.invalid/oauth/github/callback",
      };
      const result = await invokeGithubUserRead(this.custody, binding, args),
        duration = performance.now() - started;
      const isError = result.outcome === "provider_unavailable";
      const bytes = result.outcome === "success"
        ? new TextEncoder().encode(JSON.stringify(result.user)).byteLength
        : 0;
      const receipt = makeReceipt({
        correlationId,
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        agentId: claims.agent_id,
        deviceId: claims.device_id,
        connectionId: claims.connection_id,
        operation: "github.user.read",
        decision: isError ? "error" : "allow",
        reason: isError ? "provider_failure" : "policy_allow",
        at: now,
        latency: duration < 100 ? "lt100ms" : duration < 1000 ? "lt1s" : "gte1s",
        statusClass: result.outcome,
        responseSize: bytes === 0 ? "none" : bytes < 4096 ? "lt4k" : "lt64k",
        requestUnits: 1,
        retryCount: 0,
        redactionPolicyVersion: 1,
      });
      receiptEmitted = true;
      this.logger.emit({ type: "receipt", receipt });
      return { result, receipt };
    } catch (error) {
      if (!receiptEmitted) {
        emitClosed("error", "binding_denied");
        throw new Error("invocation denied");
      }
      throw error;
    }
  }
  #receipt(
    ctx: TenantContext,
    correlationId: string,
    now: number,
    decision: "deny" | "error",
    reason: ReceiptReason,
    claims?: CapabilityClaims,
  ): void {
    this.logger.emit({
      type: "receipt",
      receipt: makeReceipt({
        correlationId,
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        agentId: claims?.agent_id ?? "unknown",
        deviceId: claims?.device_id ?? "unknown",
        connectionId: claims?.connection_id ?? "unknown",
        operation: "github.user.read",
        decision,
        reason,
        at: now,
        latency: "lt100ms",
        statusClass: decision === "error" ? "provider_unavailable" : "policy_denied",
        responseSize: "none",
        requestUnits: 0,
        retryCount: 0,
        redactionPolicyVersion: 1,
      }),
    });
  }
}
function closedReason(reason: string): ReceiptReason {
  const value = reason.replaceAll(" ", "_");
  return ([
      "principal_inactive",
      "agent_inactive",
      "device_inactive",
      "grant_inactive",
      "connection_inactive",
      "nonce_replay",
      "capability_replay",
    ] as string[]).includes(value)
    ? value as ReceiptReason
    : "binding_denied";
}

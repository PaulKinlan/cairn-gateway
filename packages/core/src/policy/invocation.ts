import type { TenantContext } from "../domain/types.ts";
import type { MetadataStore } from "../store/store.ts";
import type { CapabilityKeyring } from "../crypto/capability.ts";
import { type CapabilityClaims, signCapability, verifyCapability } from "../crypto/capability.ts";
import type { DetachedProof } from "../crypto/request_proof.ts";
import { verifyRequestProof } from "../crypto/request_proof.ts";
import { sha256 } from "../crypto/encoding.ts";
import type { CustodyAdapter } from "../custody/custody_adapter.ts";
import { type GithubResult, invokeGithubUserRead } from "../connectors/github_user.ts";
import type { SafeLogger } from "../logging/safe_logger.ts";
import { makeReceipt, type Receipt } from "../receipts/receipt.ts";

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
    proof: DetachedProof,
    now: number,
  ): Promise<string> {
    if (!this.invocationEnabled) throw new Error("invocation disabled");
    const grant = await this.store.getGrant(ctx, grantId);
    if (!grant || grant.status !== "active" || grant.expiresAt < now) {
      throw new Error("grant denied");
    }
    const device = await this.store.getDevice(ctx, grant.deviceId);
    const connection = await this.store.getConnection(ctx, grant.connectionId);
    if (!device || device.status !== "active" || !connection || connection.status !== "active") {
      throw new Error("grant denied");
    }
    const expected = {
      v: 1 as const,
      method: "POST" as const,
      authority: this.authority,
      path: "/internal/capabilities" as const,
      query: "" as const,
      audience: "urn:cairn:gateway" as const,
      body_sha256: proof.payload.body_sha256,
      device_id: device.id,
      grant_id: grant.id,
    };
    if (!await verifyRequestProof(proof, device.publicJwk, expected, now)) {
      throw new Error("device proof denied");
    }
    if (!await this.store.consumeNonce(ctx, await sha256(proof.payload.nonce), now + 600, now)) {
      throw new Error("nonce replay");
    }
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
    proof: DetachedProof,
    args: unknown,
    now: number,
    correlationId: string,
  ): Promise<{ result: GithubResult; receipt: Receipt }> {
    const started = performance.now();
    if (!this.invocationEnabled) {
      this.#deny(ctx, correlationId, now, "invocation_disabled");
      throw new Error("invocation disabled");
    }
    let claims: CapabilityClaims;
    try {
      claims = await verifyCapability(this.keys, capability, now);
    } catch {
      this.#deny(ctx, correlationId, now, "capability_invalid");
      throw new Error("capability invalid");
    }
    if (claims.tenant_id !== ctx.tenantId || claims.user_id !== ctx.userId) {
      this.#deny(ctx, correlationId, now, "ownership_denied", claims);
      throw new Error("ownership denied");
    }
    const device = await this.store.getDevice(ctx, claims.device_id);
    const connection = await this.store.getConnection(ctx, claims.connection_id);
    if (!device || !connection || claims.cnf.jkt !== device.thumbprint) {
      this.#deny(ctx, correlationId, now, "binding_denied", claims);
      throw new Error("binding denied");
    }
    if (
      !args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length !== 0
    ) {
      this.#deny(ctx, correlationId, now, "arguments_denied", claims);
      throw new Error("arguments denied");
    }
    const expected = {
      v: 1 as const,
      method: "POST" as const,
      authority: this.authority,
      path: "/mcp" as const,
      query: "" as const,
      audience: "urn:cairn:gateway" as const,
      body_sha256: proof.payload.body_sha256,
      device_id: device.id,
      grant_id: claims.grant_id,
      capability_sha256: await sha256(capability),
    };
    if (!await verifyRequestProof(proof, device.publicJwk, expected, now)) {
      this.#deny(ctx, correlationId, now, "device_proof_denied", claims);
      throw new Error("device proof denied");
    }
    const consumed = await this.store.consumeInvocation(ctx, {
      deviceId: claims.device_id,
      deviceEpoch: claims.device_epoch,
      grantId: claims.grant_id,
      grantVersion: claims.grant_version,
      connectionId: claims.connection_id,
      connectionEpoch: claims.connection_epoch,
      operation: "github.user.read",
      nonceHash: await sha256(proof.payload.nonce),
      nonceExpiresAt: now + 600,
      jtiHash: await sha256(claims.jti),
      jtiExpiresAt: claims.exp + 30,
      now,
    });
    if (!consumed.ok) {
      this.#deny(ctx, correlationId, now, consumed.reason.replaceAll(" ", "_"), claims);
      throw new Error(consumed.reason);
    }
    const result = await invokeGithubUserRead(this.custody, connection.custodyRef, args);
    const duration = performance.now() - started;
    const receipt = makeReceipt({
      correlationId,
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      agentId: claims.agent_id,
      deviceId: claims.device_id,
      connectionId: claims.connection_id,
      operation: "github.user.read",
      decision: "allow",
      reason: "policy_allow",
      at: now,
      latency: duration < 100 ? "lt100ms" : duration < 1000 ? "lt1s" : "gte1s",
      statusClass: result.outcome,
      responseSize: result.outcome === "success" ? "lt4k" : "none",
      requestUnits: 1,
      retryCount: 0,
      redactionPolicyVersion: 1,
    });
    this.logger.emit({ type: "receipt", receipt });
    return { result, receipt };
  }
  #deny(
    ctx: TenantContext,
    correlationId: string,
    now: number,
    reason: string,
    claims?: CapabilityClaims,
  ): void {
    const receipt = makeReceipt({
      correlationId,
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      agentId: claims?.agent_id ?? "unknown",
      deviceId: claims?.device_id ?? "unknown",
      connectionId: claims?.connection_id ?? "unknown",
      operation: "github.user.read",
      decision: "deny",
      reason,
      at: now,
      latency: "lt100ms",
      statusClass: "policy_denied",
      responseSize: "none",
      requestUnits: 0,
      retryCount: 0,
      redactionPolicyVersion: 1,
    });
    this.logger.emit({ type: "receipt", receipt });
  }
}

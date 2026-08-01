import type { TenantContext } from "../../packages/core/src/domain/types.ts";
import type { MetadataStore } from "../../packages/core/src/store/store.ts";
import type { DeviceSigner } from "../../packages/core/src/crypto/device_signer.ts";
import {
  bodyHash,
  type RequestProofPayload,
  signRequestProof,
} from "../../packages/core/src/crypto/request_proof.ts";
import { encoder, sha256 } from "../../packages/core/src/crypto/encoding.ts";
import type { InvocationService } from "../../packages/core/src/policy/invocation.ts";
import { type VerifiedMcpAuth, verifyMcpAuth } from "./mcp_auth.ts";
import { PolicyMcpCore } from "./policy_core.ts";

/**
 * Fixture-only executable bridge. Signers remain private, and neither the
 * internal capability nor key material is returned to callers or MCP tools.
 */
export class FixtureLocalMcpBridge {
  #store: MetadataStore;
  #service: InvocationService;
  #context: TenantContext;
  #grantId: string;
  #deviceSigner: DeviceSigner;
  #agentSigner: DeviceSigner;
  #authority: string;
  constructor(
    store: MetadataStore,
    service: InvocationService,
    context: TenantContext,
    grantId: string,
    deviceSigner: DeviceSigner,
    agentSigner: DeviceSigner,
    authority = "fixture.cairn.invalid",
  ) {
    this.#store = store;
    this.#service = service;
    this.#context = Object.freeze({ ...context });
    this.#grantId = grantId;
    this.#deviceSigner = deviceSigner;
    this.#agentSigner = agentSigner;
    this.#authority = authority;
  }

  async authorize(
    receivedBody: Uint8Array,
    now: number,
    path: "/mcp" | "/mcp/legacy" = "/mcp",
  ): Promise<{ auth: VerifiedMcpAuth; core: PolicyMcpCore }> {
    const grant = await this.#store.getGrant(this.#context, this.#grantId);
    if (!grant) throw new Error("bridge denied");
    const issueBody = encoder.encode(JSON.stringify({ grant_id: this.#grantId }));
    const issuePayload: RequestProofPayload = {
      v: 1,
      method: "POST",
      authority: this.#authority,
      path: "/internal/capabilities",
      query: "",
      audience: "urn:cairn:gateway",
      body_sha256: await bodyHash(issueBody),
      issued_at: now,
      nonce: `bridge_issue_${crypto.randomUUID().replaceAll("-", "")}`,
      device_id: grant.deviceId,
      agent_id: grant.agentId,
      grant_id: grant.id,
    };
    const issueProofs = await this.#dual(issuePayload);
    const capability = await this.#service.issue(
      this.#context,
      this.#grantId,
      issueProofs,
      issueBody,
      now,
    );
    const requestPayload: RequestProofPayload = {
      ...issuePayload,
      path,
      body_sha256: await bodyHash(receivedBody),
      nonce: `bridge_request_${crypto.randomUUID().replaceAll("-", "")}`,
      capability_sha256: await sha256(capability),
    };
    const proofs = await this.#dual(requestPayload);
    const auth = await verifyMcpAuth(this.#store, {
      context: this.#context,
      grantId: this.#grantId,
      proofs,
      receivedBody,
      now,
      authority: this.#authority,
      path,
      capability,
    });
    return {
      auth,
      core: new PolicyMcpCore(this.#store, this.#service, auth, {
        capability,
        proofs,
        now,
        correlationId: `bridge_${crypto.randomUUID().replaceAll("-", "")}`,
      }),
    };
  }

  async #dual(payload: RequestProofPayload) {
    return {
      device: await signRequestProof(this.#deviceSigner, {
        ...payload,
        nonce: `${payload.nonce}_device`,
      }),
      agent: await signRequestProof(this.#agentSigner, {
        ...payload,
        nonce: `${payload.nonce}_agent00`,
      }),
    };
  }
}

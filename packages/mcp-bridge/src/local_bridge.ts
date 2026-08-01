import type { TenantContext } from "../../core/src/domain/types.ts";
import type { MetadataStore } from "../../core/src/store/store.ts";
import type { DeviceSigner } from "../../core/src/crypto/device_signer.ts";
import {
  bodyHash,
  type RequestProofPayload,
  signRequestProof,
} from "../../core/src/crypto/request_proof.ts";
import { encoder, sha256 } from "../../core/src/crypto/encoding.ts";
import type { InvocationService } from "../../core/src/policy/invocation.ts";
import { type VerifiedMcpAuth, verifyMcpAuth } from "../../../apps/gateway/mcp_auth.ts";
import { createPolicyMcpCore, type PolicyMcpCore } from "../../../apps/gateway/policy_core.ts";

/** Fixture-only executable bridge; private keys and capabilities never cross its boundary. */
export class FixtureLocalMcpBridge {
  #store: MetadataStore;
  #service: InvocationService;
  #context: TenantContext;
  #grantId: string;
  #deviceSigner: DeviceSigner;
  #agentSigner: DeviceSigner;
  #authority: string;
  #clock: () => number;
  constructor(
    store: MetadataStore,
    service: InvocationService,
    context: TenantContext,
    grantId: string,
    deviceSigner: DeviceSigner,
    agentSigner: DeviceSigner,
    authority = "fixture.cairn.invalid",
    clock: () => number = () => Math.floor(Date.now() / 1000),
  ) {
    this.#store = store;
    this.#service = service;
    this.#context = Object.freeze({ ...context });
    this.#grantId = grantId;
    this.#deviceSigner = deviceSigner;
    this.#agentSigner = agentSigner;
    this.#authority = authority;
    this.#clock = clock;
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
      core: createPolicyMcpCore(this.#store, this.#service, auth, {
        capability,
        proofs,
        correlationId: `bridge_${crypto.randomUUID().replaceAll("-", "")}`,
        path,
        clock: this.#clock,
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
